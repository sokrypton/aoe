// Feature-level multiplayer regressions: chat, town bell round-trip,
// movement prediction under latency, forged-command guard, version
// handshake. Each of these has broken (or been exploitable) once.
const { sleep, check, finish, startMatch } = require('./helpers');

(async () => {
  const { browser, host, guest, errors } = await startMatch();

  // --- Chat both directions (textContent-safe).
  await host.keyboard.press('Enter');
  await host.keyboard.type('gl hf');
  await host.keyboard.press('Enter');
  await sleep(800);
  const guestChat = await guest.evaluate(() => document.getElementById('chat-log').textContent);
  await guest.keyboard.press('Enter');
  await guest.keyboard.type('<b>u2</b>');
  await guest.keyboard.press('Enter');
  await sleep(800);
  const hostChat = await host.evaluate(() => ({
    text: document.getElementById('chat-log').textContent,
    injected: document.getElementById('chat-log').querySelector('b') !== null,
  }));
  check(guestChat.includes('gl hf') && hostChat.text.includes('<b>u2</b>') && !hostChat.injected,
    'chat delivers both ways and neutralizes HTML');

  // --- Town bell: guest rings, villagers garrison AND release on both views.
  await guest.evaluate(() => toggleTownBell());
  await sleep(2500);
  const inG = await Promise.all([host, guest].map(p =>
    p.evaluate(() => entities.filter(e => e.team === 1 && e.utype === 'villager' && e.garrisonedIn).length)));
  await guest.evaluate(() => toggleTownBell());
  await sleep(1500);
  const outG = await Promise.all([host, guest].map(p =>
    p.evaluate(() => entities.filter(e => e.team === 1 && e.utype === 'villager' && e.garrisonedIn).length)));
  check(inG[0] > 0 && inG[1] > 0 && outG[0] === 0 && outG[1] === 0,
    'guest town bell garrisons and releases on both sides');

  // --- Command latency: under lockstep the guest's OWN sim executes its
  // command INPUT_DELAY_TICKS (~70ms) after the tap, regardless of link
  // latency — a big group must be walking within a fraction of a second.
  await Promise.all([host, guest].map(p => p.evaluate(() => { window.DEV_TEST_COMMANDS = true; })));
  await guest.evaluate(() => {
    let v = entities.find(e => e.team === 1 && e.type === 'unit');
    submitCommand({ kind: 'dev-spawn', n: 20, utype: 'militia', forTeam: 1, x: Math.round(v.x), y: Math.round(v.y) });
  });
  await guest.waitForFunction(() => entities.filter(e => e.utype === 'militia' && e.team === 1).length >= 15, null, { timeout: 10000 });
  await host.evaluate(() => { window.NET_TEST_LATENCY_MS = 150; });
  await guest.evaluate(() => { window.NET_TEST_LATENCY_MS = 150; });
  const guestIds = await guest.evaluate(() => {
    selected = entities.filter(e => e.team === 1 && e.utype === 'militia');
    const ids = selected.map(s => s.id);
    let u = selected[0];
    const iso = toIso(u.x - 8, u.y + 8);
    doCommand((iso.ix - camX) * ZOOM + W/2, (iso.iy - camY + HALF_TH) * ZOOM + H/2 + topH);
    return ids;
  });
  await sleep(400); // > input delay (67ms) with margin; well under a round-trip
  const lat = await guest.evaluate((ids) =>
    ids.filter(i => { const e = entitiesById.get(i); return e && (e.path.length > 0 || e.moveGoalX !== undefined); }).length / ids.length, guestIds);
  check(lat >= 0.8, 'guest commands execute locally without a round-trip (' + Math.round(lat*100) + '% moving at 400ms)');
  await sleep(6000);
  await host.evaluate(() => { window.NET_TEST_LATENCY_MS = 0; });
  await guest.evaluate(() => { window.NET_TEST_LATENCY_MS = 0; });
  await sleep(4000);
  const cmp = await Promise.all([host, guest].map(p => p.evaluate(() =>
    entities.filter(e => e.utype === 'militia' && e.team === 1).map(e => ({ id: e.id, x: e.x, y: e.y })))));
  let worst = 0;
  cmp[0].forEach(h => {
    const g = cmp[1].find(x => x.id === h.id);
    if (g) worst = Math.max(worst, Math.hypot(h.x - g.x, h.y - g.y));
  });
  check(worst < 1.0, 'sims converge on unit positions (worst ' + worst.toFixed(3) + ' tiles)');

  // --- Security: a forged delete of HOST units injected on the wire must
  // be ignored (the receiver assigns the peer's team, never trusts it);
  // deleting your own units works.
  const hostUnits = await host.evaluate(() => entities.filter(e => e.team === 0 && e.type === 'unit').map(e => e.id));
  await guest.evaluate(ids => sendToPeer({ type: 'cmd-ls', execTick: Math.round(tick) + 8, seq: 9999, cmd: { kind: 'delete-units', unitIds: ids } }), hostUnits);
  await sleep(800);
  const immune = await host.evaluate(ids => ids.every(id => entitiesById.has(id)), hostUnits);
  const ownId = await guest.evaluate(() => {
    let u = entities.find(e => e.team === 1 && e.utype === 'militia');
    submitCommand({ kind: 'delete-units', unitIds: [u.id] });
    return u.id;
  });
  await sleep(1200);
  const ownGone = await host.evaluate(id => !entitiesById.has(id), ownId);
  check(immune && ownGone, 'delete-units guard: host immune, own deletes work');

  // --- Version handshake: forged old version triggers the mismatch overlay.
  await guest.evaluate(() => sendToHost({ type: 'proto', v: -1 }));
  await sleep(600);
  const mm = await host.evaluate(() => ({
    shown: document.getElementById('mp-disconnect-overlay').style.display === 'flex',
    title: document.getElementById('mp-disconnect-title').textContent,
  }));
  check(mm.shown && mm.title.includes('Version'), 'protocol version mismatch overlay');

  check(errors.length === 0, 'no page errors (' + (errors.join('; ') || 'none') + ')');
  await browser.close();
  finish();
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
