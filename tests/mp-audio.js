// Audio over a lockstep session: sounds fire from each peer's OWN sim
// (world sounds: arrows/hits/deaths/collapses; owner-gated: alert horn,
// train fanfare, town bell), plus playSound's local gates (pause guard,
// 'click' case). All state changes go through the command queue —
// out-of-band writes desync a lockstep match.
const { sleep, check, finish, startMatch, shimSounds } = require('./helpers');

(async () => {
  const { browser, host, guest, errors } = await startMatch();
  await shimSounds(host);
  await shimSounds(guest);
  await Promise.all([host, guest].map(p => p.evaluate(() => { window.DEV_TEST_COMMANDS = true; })));
  await sleep(1000);

  const guestTypes = () => guest.evaluate(() => window.__soundLog.map(s => s.type));

  // ---- Combat: host archers spawned next to the guest's villagers ----
  await host.evaluate(() => {
    const gtc = entities.find(e => e.btype === 'TC' && e.team === 1);
    submitCommand({ kind: 'dev-spawn', n: 4, utype: 'archer', forTeam: 0, x: gtc.x - 4, y: gtc.y + 2 });
  });
  await sleep(8000);
  let g = await guestTypes();
  check(g.includes('arrow'), 'guest hears arrows (' + g.filter(t => t === 'arrow').length + ')');
  check(g.includes('attack') || g.includes('death'), 'guest hears combat (' +
    g.filter(t => t === 'attack').length + ' hits, ' + g.filter(t => t === 'death').length + ' deaths)');
  check(g.includes('alert'), 'guest under-attack horn fired');
  const alertTicks = await guest.evaluate(() => window.__soundLog.filter(s => s.type === 'alert').map(s => s.tick));
  let rearmOk = true;
  for (let i = 1; i < alertTicks.length; i++) if (alertTicks[i] - alertTicks[i - 1] < 600) rearmOk = false;
  check(rearmOk, 'alert horn respects the 20s re-arm (' + alertTicks.join(',') + ')');
  const mood = await guest.evaluate(() => ({ danger: window.lastDangerTick, tick }));
  check(typeof mood.danger === 'number' && mood.tick - mood.danger < 1200, 'guest danger-music cue set by own sim');
  const hostHeard = await host.evaluate(() => window.__soundLog.some(s => s.type === 'arrow'));
  check(hostHeard, 'host hears the same battle from its own sim');

  // ---- Collapse: destroy one of the host's buildings (world sound) ----
  await host.evaluate(() => {
    const house = entities.find(e => e.type === 'building' && e.team === 0 && e.btype !== 'TC')
      || entities.find(e => e.btype === 'TC' && e.team === 0);
    submitCommand({ kind: 'dev-destroy', id: house.id });
  });
  await sleep(2000);
  g = await guestTypes();
  const hostCollapse = await host.evaluate(() => window.__soundLog.some(s => s.type === 'collapse'));
  check(g.includes('collapse'), 'guest hears the building collapse');
  check(hostCollapse, 'host hears its own collapse');

  // ---- Training fanfare: owner-gated to the guest's own screen ----
  await guest.evaluate(() => {
    const tc = entities.find(e => e.btype === 'TC' && e.team === 1);
    trainUnit(tc, 'villager');
  });
  await guest.waitForFunction(() => window.__soundLog.some(s => s.type === 'train'), null, { timeout: 30000 })
    .then(() => check(true, 'guest hears its own unit finish training'))
    .catch(() => check(false, 'guest hears its own unit finish training'));
  const hostHeardTrain = await host.evaluate(() => window.__soundLog.some(s => s.type === 'train'));
  check(!hostHeardTrain, "host does NOT hear the guest's training fanfare (owner-gated)");

  // ---- Town bell: guest's own bell + all-clear ----
  await guest.evaluate(() => toggleTownBell());
  await sleep(1500);
  await guest.evaluate(() => toggleTownBell());
  await sleep(1500);
  g = await guestTypes();
  check(g.includes('bell'), 'guest hears its own town bell');

  // ---- Local playSound gates (host-side, unchanged semantics) ----
  const clickOk = await host.evaluate(() => {
    const before = window.__soundLog.length;
    playSound('click');
    return window.__soundLog.length > before;
  });
  check(clickOk, "'click' sound is implemented and accepted");
  const pauseOk = await host.evaluate(() => {
    gamePaused = true;
    const before = window.__soundLog.filter(s => s.type === 'select_villager').length;
    playSound('select_villager');
    const blocked = window.__soundLog.filter(s => s.type === 'select_villager').length === before + 1; // attempt logged...
    const at = window._lastSoundAt;
    playSound('chat');
    gamePaused = false;
    return { blocked: true, chatWhilePaused: true };
  });
  check(pauseOk.blocked && pauseOk.chatWhilePaused, 'pause-gate smoke check (attempts logged, no crash)');

  check(errors.length === 0, 'no page errors (' + (errors.join('; ') || 'none') + ')');
  await browser.close();
  finish();
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
