// End-to-end multiplayer robustness test: host + guest in two browser
// contexts, real PeerJS/WebRTC between them.
const { chromium } = require('playwright');

const BASE = (process.env.AOE_URL || 'http://127.0.0.1:8471/') + 'index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function watchConsole(page, tag, store) {
  page.on('console', m => {
    const t = m.text();
    store.push(`[${tag}] ${t}`);
  });
  page.on('pageerror', e => store.push(`[${tag}] PAGEERROR ${e.message}`));
}

(async () => {
  const browser = await chromium.launch();
  const logs = [];
  const fail = msg => { console.log('FAIL: ' + msg); process.exitCode = 1; };

  const hostCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  watchConsole(host, 'host', logs);
  await host.goto(BASE);
  await host.waitForTimeout(1000);

  // Start hosting via the real button handler; peer id lands on netPeer.id.
  await host.evaluate(() => onHostClicked());
  await host.waitForFunction(() => typeof netPeer !== 'undefined' && netPeer && netPeer.id, null, { timeout: 20000 });
  const hostId = await host.evaluate(() => netPeer.id);
  console.log('host peer id:', hostId);
  if (!hostId) { fail('no host peer id'); await browser.close(); return; }

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  watchConsole(guest, 'guest', logs);
  await guest.goto(BASE + '?join=' + hostId);

  // Wait until the guest has a world (first full sync applied).
  await guest.waitForFunction(() => typeof map !== 'undefined' && map.length > 0 && entities.length > 0, null, { timeout: 30000 });
  console.log('PASS: guest bootstrapped (full sync applied)');

  // Ticks should advance on the guest.
  const t1 = await guest.evaluate(() => tick);
  await sleep(1500);
  const t2 = await guest.evaluate(() => tick);
  if (t2 > t1) console.log('PASS: guest tick advancing', t1.toFixed(1), '->', t2.toFixed(1));
  else fail('guest tick not advancing');

  // --- Scenario 1: wedge the guest (simulate lost state) and confirm auto-recovery.
  await guest.evaluate(() => { map.length = 0; entities.length = 0; entitiesById.clear(); });
  await sleep(300);
  const wedged = await guest.evaluate(() => map.length === 0);
  console.log('guest wedged:', wedged);
  const recovered = await guest.waitForFunction(() => map.length > 0 && entities.length > 0, null, { timeout: 10000 })
    .then(() => true).catch(() => false);
  if (recovered) console.log('PASS: guest auto-recovered from wedged state via request-full-sync');
  else fail('guest did NOT recover from wedged state');

  // --- Scenario 2: drop the next full sync, wedge again — recovery must survive a lost full sync.
  await host.evaluate(() => { window.NET_TEST_DROP_NEXT_FULL = true; });
  await guest.evaluate(() => { map.length = 0; entities.length = 0; entitiesById.clear(); });
  const recovered2 = await guest.waitForFunction(() => map.length > 0 && entities.length > 0, null, { timeout: 20000 })
    .then(() => true).catch(() => false);
  if (recovered2) console.log('PASS: guest recovered even after a dropped full sync');
  else fail('guest did NOT recover after dropped full sync');

  // --- Scenario 3: seq-gap detection — drop ~40% of host messages for 3s, then stop.
  await host.evaluate(() => { window.NET_TEST_DROP_RATE = 0.4; });
  await sleep(3000);
  await host.evaluate(() => { window.NET_TEST_DROP_RATE = 0; });
  const healthy = await guest.waitForFunction(() => map.length > 0 && entities.length > 0, null, { timeout: 15000 })
    .then(() => true).catch(() => false);
  await sleep(2000);
  const t3 = await guest.evaluate(() => tick);
  await sleep(1500);
  const t4 = await guest.evaluate(() => tick);
  if (healthy && t4 > t3) console.log('PASS: guest healthy and advancing after 40% packet loss burst');
  else fail('guest unhealthy after packet loss burst: healthy=' + healthy + ' tickAdv=' + (t4 > t3));

  // --- Scenario 4: backpressure — 400ms serial send delay on host for 5s; bufferedAmount must stay bounded.
  await host.evaluate(() => { window.NET_TEST_DELAY_MS = 400; });
  await sleep(5000);
  const buffered = await host.evaluate(() => netSendBuffered());
  await host.evaluate(() => { window.NET_TEST_DELAY_MS = 0; });
  if (buffered < 128 * 1024) console.log('PASS: bufferedAmount bounded under choked link:', buffered, 'bytes');
  else fail('bufferedAmount grew unbounded: ' + buffered);
  // guest should still be alive afterwards
  await sleep(3000);
  const t5 = await guest.evaluate(() => tick);
  await sleep(1500);
  const t6 = await guest.evaluate(() => tick);
  if (t6 > t5) console.log('PASS: guest still advancing after choke released');
  else fail('guest frozen after choke');

  // --- Scenario 5: menu-pause self-heal — set guest remoteMenuOpen stuck true; next sync must clear it.
  await guest.evaluate(() => { setRemoteMenuOpen(true); });
  const unstuck = await guest.waitForFunction(() => gamePaused === false, null, { timeout: 5000 })
    .then(() => true).catch(() => false);
  if (unstuck) console.log('PASS: stuck remoteMenuOpen self-healed via sync payload');
  else fail('remoteMenuOpen stayed stuck');

  // --- Scenario 6: movement offload — march units on the host; the guest must
  // track them via its own simulation + per-tile re-anchors, and converge.
  const marchInfo = await host.evaluate(() => {
    let moved = [];
    let units = entities.filter(e => e.type === 'unit' && e.team === 0 && e.speed > 0 && !e.garrisonedIn);
    for (const u of units.slice(0, 6)) {
      let tx = Math.round(u.x) + 10, ty = Math.round(u.y) + 10;
      for (let r = 0; r < 6 && !(walkable(tx, ty, u.id, true)); r++) { tx--; ty--; }
      let p = findPath(Math.round(u.x), Math.round(u.y), tx, ty, u.id);
      if (p && p.length) { u.path = p; u.fromX = Math.round(u.x); u.fromY = Math.round(u.y); u.moveT = 0; moved.push(u.id); }
    }
    return { moved, bytes0: netBytesSent, t0: performance.now() };
  });
  console.log('marching units:', marchInfo.moved.length);
  await sleep(3000);
  const band = await host.evaluate(({ bytes0, t0 }) => ({
    kbps: ((netBytesSent - bytes0) / 1024) / ((performance.now() - t0) / 1000)
  }), marchInfo);
  console.log('host upstream while marching:', band.kbps.toFixed(2), 'KB/s');
  // Mid-march: guest copies should be moving (position differs from where they'll end).
  await sleep(2500); // total ~5.5s — some units may have arrived; compare final convergence
  await sleep(3000);
  const conv = await host.evaluate(ids => ids.map(id => {
    const e = entitiesById.get(id); return e ? { id, x: e.x, y: e.y } : null;
  }).filter(Boolean), marchInfo.moved);
  const guestPos = await guest.evaluate(ids => ids.map(id => {
    const e = entitiesById.get(id); return e ? { id, x: e.x, y: e.y } : null;
  }).filter(Boolean), marchInfo.moved);
  let worst = 0;
  for (const h of conv) {
    const g = guestPos.find(p => p.id === h.id);
    if (!g) { worst = 999; break; }
    worst = Math.max(worst, Math.hypot(h.x - g.x, h.y - g.y));
  }
  if (worst < 1.0) console.log('PASS: guest converged with host after march (worst delta', worst.toFixed(3), 'tiles)');
  else fail('guest diverged from host after march: worst delta ' + worst.toFixed(3) + ' tiles');

  const interesting = logs.filter(l => /resync|Failed|error|dropped/i.test(l)).slice(0, 30);
  console.log('--- relevant console lines ---');
  interesting.forEach(l => console.log(l));
  await browser.close();
  console.log(process.exitCode ? 'RESULT: FAILURES' : 'RESULT: ALL PASS');
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
