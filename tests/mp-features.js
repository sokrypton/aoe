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

  // --- Movement prediction: with 150ms simulated latency each way, a big
  // group starts walking immediately on the guest and converges with host.
  await host.evaluate(() => {
    let v = entities.find(e => e.team === 1 && e.type === 'unit');
    for (let i = 0; i < 20; i++) {
      let t = findSpawnTile(Math.round(v.x) + (i % 5), Math.round(v.y) + Math.floor(i / 5), 10);
      if (t) createUnit('militia', t.x, t.y, 1);
    }
  });
  await guest.waitForFunction(() => entities.filter(e => e.utype === 'militia' && e.team === 1).length >= 20, null, { timeout: 10000 });
  await host.evaluate(() => { window.NET_TEST_DELAY_MS = 150; });
  await guest.evaluate(() => { window.NET_TEST_DELAY_MS = 150; });
  const lat = await guest.evaluate(() => {
    selected = entities.filter(e => e.team === 1 && e.utype === 'militia');
    const ids = selected.map(s => s.id);
    let u = selected[0];
    const iso = toIso(u.x - 8, u.y + 8);
    doCommand(iso.ix - camX + W/2, iso.iy - camY + topH + H/2);
    return ids.filter(i => { const e = entitiesById.get(i); return e && e.path.length > 0; }).length / ids.length;
  });
  check(lat >= 0.8, 'prediction: units moving instantly on guest tap (' + Math.round(lat*100) + '%)');
  await sleep(6000);
  await host.evaluate(() => { window.NET_TEST_DELAY_MS = 0; });
  await guest.evaluate(() => { window.NET_TEST_DELAY_MS = 0; });
  await sleep(4000);
  const cmp = await Promise.all([host, guest].map(p => p.evaluate(() =>
    entities.filter(e => e.utype === 'militia' && e.team === 1).map(e => ({ id: e.id, x: e.x, y: e.y })))));
  let worst = 0;
  cmp[0].forEach(h => {
    const g = cmp[1].find(x => x.id === h.id);
    if (g) worst = Math.max(worst, Math.hypot(h.x - g.x, h.y - g.y));
  });
  check(worst < 1.0, 'prediction converges with host (worst ' + worst.toFixed(3) + ' tiles)');

  // --- Security: forged delete of host units must be ignored; own works.
  const hostUnits = await host.evaluate(() => entities.filter(e => e.team === 0 && e.type === 'unit').map(e => e.id));
  await guest.evaluate(ids => sendCommand({ kind: 'delete-units', unitIds: ids }), hostUnits);
  await sleep(800);
  const immune = await host.evaluate(ids => ids.every(id => entitiesById.has(id)), hostUnits);
  const ownId = await guest.evaluate(() => {
    let u = entities.find(e => e.team === 1 && e.utype === 'militia');
    sendCommand({ kind: 'delete-units', unitIds: [u.id] });
    return u.id;
  });
  await sleep(1000);
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
