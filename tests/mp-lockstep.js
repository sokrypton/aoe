// Lockstep multiplayer (?lockstep): both peers run the full deterministic
// sim from a shared seed + tick-stamped command stream. Asserts: match
// starts on both sides from the seed handshake, both sims advance and stay
// within the input-delay window, commands issued on EITHER side execute on
// BOTH, per-tick checksums agree across peers under 150ms simulated
// latency, and no desync fires.
const { chromium } = require('playwright');
const { BASE, sleep, check, finish } = require('./helpers');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const hostCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  host.on('pageerror', e => errors.push('host: ' + e.message));
  await host.goto(BASE + '?lockstep');
  await host.waitForTimeout(800);
  await host.evaluate(() => onHostClicked());
  await host.waitForFunction(() => typeof netPeer !== 'undefined' && netPeer && netPeer.id, null, { timeout: 20000 });
  const hostId = await host.evaluate(() => netPeer.id);

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  guest.on('pageerror', e => errors.push('guest: ' + e.message));
  await guest.goto(BASE + '?join=' + hostId);
  await guest.waitForFunction(() => typeof lockstepActive !== 'undefined' && lockstepActive && entities.length > 0 && tick > 0, null, { timeout: 30000 });

  check(await host.evaluate(() => lockstepEnabled()), 'host in lockstep mode');
  check(await guest.evaluate(() => lockstepEnabled()), 'guest in lockstep mode');
  check(await guest.evaluate(() => matchSeed) === await host.evaluate(() => matchSeed),
    'seed handshake: same matchSeed on both peers');

  // Guest camera starts on its OWN base (team 1), not the host's.
  const camOk = await guest.evaluate(() => {
    const own = entities.find(e => e.btype === 'TC' && e.team === 1);
    const other = entities.find(e => e.btype === 'TC' && e.team === 0);
    const d = (tc) => { const iso = toIso(tc.x, tc.y); const dx = iso.ix - camX, dy = iso.iy - camY; return Math.sqrt(dx*dx + dy*dy); };
    return d(own) < d(other);
  });
  check(camOk, 'guest camera centered on its own base');

  // Both sims advance, and stay within the input-delay window of each other.
  await sleep(2000);
  const t1 = await Promise.all([host, guest].map(p => p.evaluate(() => tick)));
  await sleep(1500);
  const t2 = await Promise.all([host, guest].map(p => p.evaluate(() => tick)));
  check(t2[0] > t1[0] && t2[1] > t1[1], 'both sims advance');
  check(Math.abs(t2[0] - t2[1]) <= 8, 'peers within gating window (drift ' + Math.abs(t2[0] - t2[1]) + ' ticks)');

  // Simulated latency from here on — gating must absorb it, not desync.
  await host.evaluate(() => { window.NET_TEST_DELAY_MS = 150; });
  await guest.evaluate(() => { window.NET_TEST_DELAY_MS = 150; });

  // Guest command executes on BOTH sims (and identically).
  const guestMove = await guest.evaluate(() => {
    const vils = entities.filter(e => e.team === 1 && e.utype === 'villager');
    const tc = entities.find(e => e.btype === 'TC' && e.team === 1);
    submitCommand({ kind: 'command', unitIds: vils.map(v => v.id), tileX: tc.x + 7, tileY: tc.y + 7, targetId: null, buildTargetId: null, followId: null });
    return vils.map(v => v.id);
  });
  // Host command too.
  await host.evaluate(() => {
    // NOTE: never mutate state directly here (e.g. poking resources) — any
    // out-of-band write on one peer is an instant, legitimate desync.
    const tc = entities.find(e => e.btype === 'TC' && e.team === 0);
    submitCommand({ kind: 'train-unit', bldgId: tc.id, utype: 'villager' });
  });
  // Exact positional identity is asserted by the per-tick checksum
  // comparison below (positions feed the entity hashes) — a from-outside
  // position snapshot can never be tick-aligned across two live sims, so
  // here we only assert the command's OUTCOME landed on both peers.
  await guest.waitForFunction((ids) => ids.every(id => { const e = entitiesById.get(id); return !e || e.path.length === 0; }),
    guestMove, { timeout: 20000 });
  await sleep(1500);
  const arrivedBoth = await Promise.all([host, guest].map(p => p.evaluate((ids) => {
    const tc = entities.find(e => e.btype === 'TC' && e.team === 1);
    return ids.some(id => { const e = entitiesById.get(id); return e && Math.abs(e.x - (tc.x + 7)) < 4 && Math.abs(e.y - (tc.y + 7)) < 4; });
  }, guestMove)));
  check(arrivedBoth[0] && arrivedBoth[1], 'guest-commanded villagers arrived near target on BOTH sims');
  const moved = await guest.evaluate((ids) => {
    const tc = entities.find(e => e.btype === 'TC' && e.team === 1);
    return ids.some(id => { const e = entitiesById.get(id); return e && (Math.abs(e.x - (tc.x + 7)) < 4 && Math.abs(e.y - (tc.y + 7)) < 4); });
  }, guestMove);
  check(moved, 'guest command actually moved its villagers');
  const hostTrained = await Promise.all([host, guest].map(p => p.evaluate(() => {
    const tc = entities.find(e => e.btype === 'TC' && e.team === 0);
    return tc.queue.length > 0 || entities.filter(e => e.team === 0 && e.utype === 'villager').length > 3;
  })));
  check(hostTrained[0] && hostTrained[1], 'host train command took effect on both sims');

  // Let it run under latency, then compare checksum history across peers.
  await sleep(8000);
  const [hHist, gHist] = await Promise.all([host, guest].map(p => p.evaluate(() => DET.history.slice())));
  const gByTick = new Map(gHist.map(r => [r.tick, r.sum]));
  let compared = 0, mismatches = 0;
  for (const r of hHist) {
    if (gByTick.has(r.tick)) { compared++; if (gByTick.get(r.tick) !== r.sum) mismatches++; }
  }
  check(compared > 100, 'checksum overlap window large enough (' + compared + ' ticks compared)');
  check(mismatches === 0, 'ZERO checksum mismatches across ' + compared + ' shared ticks');

  // Mobile keep-selection: a walk order must NOT deselect during the
  // input-delay window (finishMobileUnitCommand runs right after the tap,
  // before the queued command executes).
  const keepSel = await guest.evaluate(async () => {
    selected = entities.filter(e => e.team === 1 && e.utype === 'villager');
    const n = selected.length;
    const u = selected[0];
    const iso = toIso(u.x + 5, u.y + 5);
    doCommand(iso.ix - camX + W/2, iso.iy - camY + topH + H/2);
    finishMobileUnitCommand();
    const stillNow = selected.length === n;
    await new Promise(r => setTimeout(r, 1500));
    finishMobileUnitCommand();
    return { stillNow, stillLater: selected.length === n };
  });
  check(keepSel.stillNow && keepSel.stillLater,
    'mobile walk order keeps selection through the input-delay window (now=' + keepSel.stillNow + ', later=' + keepSel.stillLater + ')');

  const desyncs = await Promise.all([host, guest].map(p => p.evaluate(() => window.__lockstepDesync || null)));
  check(!desyncs[0] && !desyncs[1], 'no desync flagged on either peer (' + desyncs.join(', ') + ')');
  check(errors.length === 0, 'no page errors (' + errors.join('; ') + ')');

  await browser.close();
  finish();
})();
