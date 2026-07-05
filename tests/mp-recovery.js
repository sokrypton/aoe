// Host crash recovery (?host= resume link) + save-on-disconnect.
// The host page is killed mid-match; a new page at the ?host= URL must
// reclaim the peer id and recover the world from the guest's live mirror.
const { BASE, sleep, check, finish, startMatch } = require('./helpers');

(async () => {
  const { host: firstHost, hostCtx, guest, errors } = await startMatch();
  const hostUrl = await firstHost.evaluate(() => location.href);
  check(hostUrl.includes('?host='), 'host URL rewritten to ?host= resume link');

  // Diverge state from spawn so recovery is distinguishable from a restart.
  await firstHost.evaluate(() => {
    let tc = entities.find(e => e.btype === 'TC' && e.team === 0);
    queueUnit(tc, 'villager');
    resources[0].wood = 137; // marker value
  });
  await sleep(1500);
  const marker = await guest.evaluate(() => resources[0].wood);
  check(marker === 137, 'marker state synced to guest before crash');

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
    typeof mpMatchStarted !== 'undefined' && mpMatchStarted && entities.length > 0 && resources[0].wood === 137,
    null, { timeout: 60000 }).then(() => true).catch(() => false);
  check(recovered, 'rehosted page recovered world from guest');
  await sleep(2000);

  const post = await Promise.all([host, guest].map(p => p.evaluate(() => ({
    ents: entities.length, wood: resources[0].wood, paused: gamePaused,
    overlay: document.getElementById('mp-disconnect-overlay').style.display,
  }))));
  check(post[0].ents === post[1].ents && post[0].wood === 137 && post[1].wood === 137
    && !post[0].paused && !post[1].paused && post[1].overlay === 'none',
    'both sides resumed in sync after recovery');

  // Sim flowing + command round-trip after recovery.
  const t1 = await guest.evaluate(() => tick);
  await sleep(1200);
  const t2 = await guest.evaluate(() => tick);
  check(t2 > t1, 'sync stream flowing after recovery');
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
