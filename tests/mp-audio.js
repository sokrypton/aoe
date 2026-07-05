// Audio robustness over a real host/guest session: the guest hears the
// battlefield via the state-diff hooks in js/net-sync.js (attack/arrow/
// death/collapse/train/bell), the under-attack horn re-arms like the host's,
// and playSound's gates (pause guard, 'click' case) behave.
// window.playSound is shimmed to log every ATTEMPT (tests/helpers.js);
// gate acceptance is asserted via audio.js's _lastSoundAt side effect,
// which is only written after the mute/mode/pause gates pass.
const { sleep, check, finish, startMatch, shimSounds } = require('./helpers');

(async () => {
  const { browser, host, guest, errors } = await startMatch();
  await shimSounds(host);
  await shimSounds(guest);
  await sleep(1000);
  await host.evaluate(() => { window.fogDisabled = true; });
  await guest.evaluate(() => { window.fogDisabled = true; });

  const guestTypes = () => guest.evaluate(() => window.__soundLog.map(s => s.type));

  // ---- Combat: archer volleys against a guest villager ----
  await host.evaluate(() => {
    const u = entities.find(e => e.team === 0 && e.type === 'unit');
    u.utype = 'archer'; u.range = UNITS.archer.range; u.atk = UNITS.archer.atk; u.hp = u.maxHp = UNITS.archer.hp;
    const v = entities.find(e => e.team === 1 && e.utype === 'villager');
    v.hp = v.maxHp = 500;
    u.x = v.x - 3; u.y = v.y; u.fromX = u.x; u.fromY = u.y; u.target = v.id; clearUnitPath(u);
  });
  await sleep(5000);
  let g = await guestTypes();
  check(g.includes('arrow'), 'guest hears arrows (' + g.filter(t => t === 'arrow').length + ')');
  check(g.includes('attack'), 'guest hears combat hits (' + g.filter(t => t === 'attack').length + ')');
  check(g.includes('alert'), 'guest under-attack horn fired');
  // horn re-arm: consecutive alerts must be >= 600 ticks apart
  const alertTicks = await guest.evaluate(() => window.__soundLog.filter(s => s.type === 'alert').map(s => s.tick));
  let rearmOk = true;
  for (let i = 1; i < alertTicks.length; i++) if (alertTicks[i] - alertTicks[i - 1] < 600) rearmOk = false;
  check(rearmOk, 'alert horn respects the 20s re-arm (' + alertTicks.join(',') + ')');
  // guest music mood signal fed by the same hook
  const mood = await guest.evaluate(() => ({ danger: window.lastDangerTick, tick }));
  check(typeof mood.danger === 'number' && mood.tick - mood.danger < 600, 'guest lastDangerTick set by hp-drop hook');

  // ---- Death: finish the villager off ----
  await host.evaluate(() => {
    const u = entities.find(e => e.team === 0 && e.utype === 'archer');
    const v = entitiesById.get(u.target);
    if (v) { v.hp = 1; v.maxHp = 500; }
  });
  await sleep(3000);
  g = await guestTypes();
  check(g.includes('death'), 'guest hears the death cry');

  // ---- Collapse: host demolishes one of its own buildings ----
  await host.evaluate(() => {
    const tc = entities.find(e => e.btype === 'TC' && e.team === 0);
    const b = BLDGS.HOUSE;
    let x = tc.x + 5, y = tc.y;
    for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) {
      map[y + dy][x + dx].t = TERRAIN.GRASS; map[y + dy][x + dx].res = 0; map[y + dy][x + dx].occupied = null;
    }
    const e = { id: nextId++, type: 'building', btype: 'HOUSE', x, y, w: b.w, h: b.h,
      team: 0, hp: b.hp, maxHp: b.hp, complete: true, buildProgress: 1, buildTime: 1, queue: [] };
    entities.push(e); entitiesById.set(e.id, e);
    window.__houseId = e.id;
  });
  await sleep(700); // let the new building sync to the guest first
  await host.evaluate(() => { const e = entitiesById.get(window.__houseId); if (e) deleteOwnedEntity(e); });
  await sleep(1500);
  g = await guestTypes();
  check(g.includes('collapse'), 'guest hears the building collapse');
  const hostCollapse = await host.evaluate(() => window.__soundLog.some(s => s.type === 'collapse'));
  check(hostCollapse, 'host hears its own collapse (handleDeath)');

  // ---- Train: guest queues a villager at its own TC ----
  await host.evaluate(() => { resources[1].food = 500; }); // host holds the authoritative store
  await guest.evaluate(() => {
    const tc = entities.find(e => e.btype === 'TC' && e.team === 1);
    trainUnit(tc, 'villager'); // guest path relays the command to the host
  });
  await sleep(800);
  // Fast-forward the training on the host instead of waiting out the 25s
  await host.evaluate(() => {
    const tc = entities.find(e => e.btype === 'TC' && e.team === 1);
    if (tc && tc.queue.length) tc.trainTick = UNITS[tc.queue[0]].trainTime - 5;
  });
  await sleep(2000);
  g = await guestTypes();
  check(g.includes('train'), 'guest hears its own unit finish training');

  // ---- Bell: guest's own town bell round-trips through the sync ----
  await guest.evaluate(() => toggleTownBell());
  await sleep(1200);
  await guest.evaluate(() => toggleTownBell());
  await sleep(1200);
  g = await guestTypes();
  check(g.includes('bell') && g.includes('bell_clear'), 'guest hears its own bell + all-clear via sync');

  // ---- 'click' case exists and passes the gates ----
  const clickOk = await host.evaluate(() => {
    const before = _lastSoundAt['click'] || 0;
    playSound('click');
    return (_lastSoundAt['click'] || 0) > before;
  });
  check(clickOk, "'click' sound is implemented and accepted");

  // ---- Pause guard: selection ack blocked while paused, chat allowed ----
  const pauseOk = await host.evaluate(() => {
    gamePaused = true;
    const selBefore = _lastSoundAt['select_villager'] || 0;
    playSound('select_villager');
    const selBlocked = (_lastSoundAt['select_villager'] || 0) === selBefore;
    const chatBefore = _lastSoundAt['chat'] || 0;
    playSound('chat');
    const chatAllowed = (_lastSoundAt['chat'] || 0) > chatBefore;
    gamePaused = false;
    return { selBlocked, chatAllowed };
  });
  check(pauseOk.selBlocked, 'selection sound blocked while paused');
  check(pauseOk.chatAllowed, 'chat sound allowed while paused');

  check(errors.length === 0, 'no page errors (' + errors.join(' | ') + ')');
  await browser.close();
  finish();
})();
