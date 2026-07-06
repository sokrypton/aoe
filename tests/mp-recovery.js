// Host crash recovery (?host= resume link) + save-on-disconnect.
// The host page is killed mid-match; a new page at the ?host= URL must
// reclaim the peer id and recover the world from the guest's live mirror.
const { BASE, sleep, check, finish, startMatch } = require('./helpers');

(async () => {
  const { host: firstHost, hostCtx, guest, errors } = await startMatch();
  const hostUrl = await firstHost.evaluate(() => location.href);
  check(hostUrl.includes('?host='), 'host URL rewritten to ?host= resume link');

  // Diverge state from spawn so recovery is distinguishable from a restart —
  // through the command queue (out-of-band writes desync a lockstep match):
  // host queues a villager, guest prepays a farm (spends 60 wood).
  await firstHost.evaluate(() => {
    let tc = entities.find(e => e.btype === 'TC' && e.team === 0);
    trainUnit(tc, 'villager');
  });
  await guest.evaluate(() => prepayFarm());
  await sleep(1500);
  const marker = await guest.evaluate(() => ({
    q: (entities.find(e => e.btype === 'TC' && e.team === 0) || {}).queue.length,
    pf: resources[1].prepaidFarms }));
  check(marker.q > 0 && marker.pf === 1, 'marker state on both sims before crash (' + JSON.stringify(marker) + ')');

  // Crash the host.
  await firstHost.close();
  await guest.waitForFunction(() => document.getElementById('mp-disconnect-overlay').style.display === 'flex', null, { timeout: 15000 });
  const saveVisible = await guest.evaluate(() => document.getElementById('mp-disconnect-save').style.display !== 'none');
  const download = guest.waitForEvent('download', { timeout: 5000 }).then(() => true).catch(() => false);
  await guest.evaluate(() => document.getElementById('mp-disconnect-save').click());
  check(saveVisible && await download, 'disconnect overlay Save button downloads a save');

  // Resume from the ?host= link.
  const host = await hostCtx.newPage();
  host.on('pageerror', e => errors.push('rehost: ' + e.message));
  await host.goto(hostUrl);
  const recovered = await host.waitForFunction(() =>
    typeof mpMatchStarted !== 'undefined' && mpMatchStarted && entities.length > 0
    && resources[1] && resources[1].prepaidFarms === 1,
    null, { timeout: 60000 }).then(() => true).catch(() => false);
  check(recovered, 'rehosted page recovered world from guest');
  await sleep(2000);

  const post = await Promise.all([host, guest].map(p => p.evaluate(() => ({
    pf: resources[1].prepaidFarms, paused: gamePaused,
    overlay: document.getElementById('mp-disconnect-overlay').style.display,
  }))));
  check(post[0].pf === 1 && post[1].pf === 1
    && !post[0].paused && !post[1].paused && post[1].overlay === 'none',
    'both sides resumed in sync after recovery (' + JSON.stringify(post) + ')');

  // Sim flowing + command round-trip after recovery.
  const t1 = await guest.evaluate(() => tick);
  await sleep(1200);
  const t2 = await guest.evaluate(() => tick);
  check(t2 > t1, 'sim advancing after recovery');
  await guest.evaluate(() => {
    let tc = entities.find(e => e.btype === 'TC' && e.team === 1);
    trainUnit(tc, 'villager');
  });
  await sleep(1500);
  const queued = await host.evaluate(() => {
    let tc = entities.find(e => e.btype === 'TC' && e.team === 1);
    return tc && tc.queue.length > 0;
  });
  check(queued, 'guest command round-trips after recovery');

  check(errors.length === 0, 'no page errors (' + (errors.join('; ') || 'none') + ')');
  await (await host.context().browser()).close();
  finish();
})().catch(e => { console.error('Test crashed:', e); process.exit(1); });
