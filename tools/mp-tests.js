#!/usr/bin/env node
// ---- MULTIPLAYER tests (Playwright driver) ----
// Drives REAL multi-tab matches through the host-relay star: one host page
// plus 1-3 guest pages in the same browser context, connected through the
// live PeerJS cloud signaling server (index.html loads PeerJS from a CDN,
// so these tests need network access — they'll fail fast without it).
// Complements tools/hud-tests.js (single-page HUD/command probes) and
// tools/simulate.sh (headless whole-match health).
//
//   node tools/mp-tests.js            # run everything, exit 1 on any FAIL
//   node tools/mp-tests.js headed=1   # watch it
//   node tools/mp-tests.js only=1v1   # substring filter on scenario names
//
// Identity note: pages in one Playwright context share localStorage (the
// per-browser token) but each page has its own sessionStorage (the per-tab
// id) — exactly the local-multi-tab setup the token+tab identity scheme
// (js/net.js mpClientToken/mpTabId) exists to support.

const { startServer, requireChromium, launchBrowser, parseArgs } = require('./lib/harness');
const chromium = requireChromium();

const args = parseArgs(process.argv.slice(2));
const results = [];
let ctx, base;

function log(line){ process.stdout.write(line + '\n'); }

async function scenario(name, fn){
  if (args.only && !name.includes(args.only)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, pass: true });
    log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, pass: false, detail: String(err && err.message || err) });
    log(`FAIL  ${name}: ${err && err.message || err}`);
  }
}

// ---- page helpers ----

async function newGamePage(query){
  const page = await ctx.newPage();
  page.on('pageerror', err => log(`   [pageerror ${query || 'host'}] ${err.stack || err.message}`));
  await page.goto(base + '/index.html' + (query || ''), { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const b = document.getElementById('start-game-btn');
    return b && !b.disabled;
  }, { timeout: 20000 });
  // Silence audio + toasts; they only slow headless runs down.
  await page.evaluate(() => { window.playSound = () => {}; });
  return page;
}

// Host a session and return {host, joinQuery} where joinQuery is the
// ?join=<peerId> suffix guests open.
async function hostGame(){
  const host = await newGamePage();
  await host.evaluate(() => onHostClicked());
  await host.waitForFunction(() => typeof lobbyShareLink !== 'undefined' && !!lobbyShareLink
    || !!(document.getElementById('mp-link-box') || {}).textContent, { timeout: 20000 });
  const link = await host.evaluate(() =>
    lobbyShareLink || document.getElementById('mp-link-box').textContent.trim());
  const m = link.match(/\?join=([^&]+)/);
  if (!m) throw new Error('no ?join= link on host page: ' + link);
  return { host, joinQuery: '?join=' + m[1] };
}

// Wait until a page's lobby mirror exists and it knows its seat.
async function waitInLobby(page){
  await page.waitForFunction(() =>
    window.__mpSession && window.__mpSession.inLobby !== false
    && typeof lobbyState !== 'undefined' && !!lobbyState, { timeout: 20000 });
}

async function readyUp(guest){
  await guest.evaluate(() => {
    let i = lobbyMySeatIndex();
    if (!lobbyState.seats[i] || !lobbyState.seats[i].ready) onLobbyReadyClicked();
  });
}

async function startMatch(host){
  await host.waitForFunction(() => lobbyCanStart(), { timeout: 20000 });
  await host.evaluate(() => onLobbyStartClicked());
}

async function waitMatchRunning(page){
  await page.waitForFunction(() =>
    typeof gameStarted !== 'undefined' && gameStarted
    && typeof lockstepActive !== 'undefined' && lockstepActive
    && tick > 0, { timeout: 30000 });
}

// Issue a simple deterministic command from this page's own seat: move the
// first own villager one tile. Exercises submitCommand → cmd-ls.
async function issueMove(page){
  await page.evaluate(() => {
    const v = entities.find(e => e.team === myTeam && e.type === 'unit' && e.hp > 0);
    if (v) {
      const tx = Math.max(1, Math.min(MAP - 2, Math.round(v.x) + 1));
      submitCommand({ kind: 'command', unitIds: [v.id], tileX: tx, tileY: Math.round(v.y) });
    }
  });
}

// Assert the lockstep invariants that every scenario cares about.
async function assertHealthy(page, label){
  const h = await page.evaluate(() => ({
    desync: window.__lockstepDesync,
    desyncedAt: typeof lockstepDesyncedAt !== 'undefined' ? lockstepDesyncedAt : null,
    myTeam,
    tick: Math.floor(tick),
  }));
  if (h.desync !== undefined) throw new Error(`${label}: __lockstepDesync = ${JSON.stringify(h.desync)}`);
  if (h.desyncedAt) throw new Error(`${label}: lockstepDesyncedAt = ${h.desyncedAt}`);
  return h;
}

// Compare the newest common checksum-history tick across pages.
async function assertChecksumsAgree(pages){
  const hists = [];
  for (const p of pages) {
    hists.push(await p.evaluate(() => DET.history.slice(-400)));
  }
  const byTick = t => hists.map(h => (h.find(e => e.tick === t) || {}).sum);
  // newest tick present in every history
  const common = hists[0].map(e => e.tick).reverse()
    .find(t => hists.every(h => h.some(e => e.tick === t)));
  if (common === undefined) throw new Error('no common checksum tick across pages');
  const sums = byTick(common);
  if (new Set(sums).size !== 1) {
    throw new Error(`checksum mismatch at tick ${common}: ${sums.join(' vs ')}`);
  }
  return common;
}

// ---- scenarios ----

(async () => {
  const srv = await startServer('/index.html');
  base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await launchBrowser(chromium, !!args.headed);
  ctx = await browser.newContext();

  await scenario('1v1: lobby -> match -> commands -> checksums agree', async () => {
    const { host, joinQuery } = await hostGame();
    const guest = await newGamePage(joinQuery);
    await waitInLobby(host);
    await waitInLobby(guest);
    const seat = await guest.evaluate(() => window.__mpSession.mySeat);
    if (seat !== 1) throw new Error('guest seat = ' + seat);
    await readyUp(guest);
    await startMatch(host);
    await waitMatchRunning(host);
    await waitMatchRunning(guest);
    for (let i = 0; i < 4; i++) {
      await issueMove(host);
      await issueMove(guest);
      await host.waitForTimeout(1500);
    }
    // let checksums (lagged by ~300 ticks) accumulate
    await host.waitForTimeout(8000);
    const h = await assertHealthy(host, 'host');
    const g = await assertHealthy(guest, 'guest');
    if (h.myTeam !== 0 || g.myTeam !== 1) throw new Error(`teams ${h.myTeam}/${g.myTeam}`);
    await assertChecksumsAgree([host, guest]);
    await host.close(); await guest.close();
  });

  await scenario('4p 2v2: four tabs -> teams -> match -> checksums agree', async () => {
    const { host, joinQuery } = await hostGame();
    const guests = [];
    for (let i = 0; i < 3; i++) guests.push(await newGamePage(joinQuery));
    await waitInLobby(host);
    for (const g of guests) await waitInLobby(g);
    await host.waitForFunction(() => lobbyState.seats.length === 4, { timeout: 20000 });
    const seats = [];
    for (const g of guests) seats.push(await g.evaluate(() => window.__mpSession.mySeat));
    if (new Set(seats).size !== 3 || seats.some(s => s == null || s < 1 || s > 3)) {
      throw new Error('bad guest seats: ' + seats.join(','));
    }
    // Host arranges a 2v2 (seats 0+1 vs 2+3) through the team picker.
    await host.evaluate(() => { lobbySetTeam(0, 0); lobbySetTeam(1, 0); lobbySetTeam(2, 1); lobbySetTeam(3, 1); });
    // Everyone got a distinct funny default name.
    const names = await host.evaluate(() => lobbyState.seats.map(s => s.name));
    if (new Set(names).size !== 4 || names.some(n => !n || !n.trim())) {
      throw new Error('names not distinct/filled: ' + JSON.stringify(names));
    }
    for (const g of guests) await readyUp(g);
    await startMatch(host);
    const pages = [host, ...guests];
    for (const p of pages) await waitMatchRunning(p);
    for (let i = 0; i < 4; i++) {
      for (const p of pages) await issueMove(p);
      await host.waitForTimeout(1500);
    }
    await host.waitForTimeout(9000); // let lagged checksums accumulate
    const teams = [];
    for (const p of pages) teams.push((await assertHealthy(p, 'page')).myTeam);
    if (new Set(teams).size !== 4) throw new Error('teams not distinct: ' + teams.join(','));
    const alliance = await host.evaluate(() => teamAlliance.join(','));
    if (alliance !== '100,100,101,101') throw new Error('teamAlliance = ' + alliance);
    await assertChecksumsAgree(pages);
    for (const p of pages) await p.close();
  });

  await scenario('1v1: guest tab dies mid-match -> pause -> new tab rejoins same seat', async () => {
    const { host, joinQuery } = await hostGame();
    let guest = await newGamePage(joinQuery);
    await waitInLobby(host);
    await waitInLobby(guest);
    await readyUp(guest);
    await startMatch(host);
    await waitMatchRunning(host);
    await waitMatchRunning(guest);
    await host.waitForTimeout(2000);
    await guest.close(); // abrupt: heartbeat watchdog must catch it
    await host.waitForFunction(() => disconnectedPause === true, { timeout: 15000 });
    // Same browser context, NEW tab: token matches, tab id differs, record
    // disconnected -> must rebind to seat 1 and resume.
    guest = await newGamePage(joinQuery);
    await guest.waitForFunction(() =>
      typeof lockstepActive !== 'undefined' && lockstepActive && gameStarted, { timeout: 30000 });
    await host.waitForFunction(() => disconnectedPause === false, { timeout: 15000 });
    await guest.waitForFunction(() => myTeam === 1, { timeout: 5000 });
    await host.waitForTimeout(4000);
    await assertHealthy(host, 'host');
    await assertHealthy(guest, 'rejoined guest');
    await host.close(); await guest.close();
  });

  await scenario('3p: drop pauses everyone -> rejoin resumes -> second drop -> kick hands seat to AI', async () => {
    const { host, joinQuery } = await hostGame();
    let gA = await newGamePage(joinQuery);
    const gB = await newGamePage(joinQuery);
    await waitInLobby(host); await waitInLobby(gA); await waitInLobby(gB);
    await host.waitForFunction(() => lobbyState.seats.length === 3, { timeout: 20000 });
    await readyUp(gA); await readyUp(gB);
    log('   [3p] all ready');
    await startMatch(host);
    for (const p of [host, gA, gB]) await waitMatchRunning(p);
    log('   [3p] match running');
    await host.waitForTimeout(2000);

    // Drop guest A: host AND guest B must both pause with the waiting overlay.
    const seatA = await gA.evaluate(() => myTeam);
    await gA.close();
    await host.waitForFunction(() => disconnectedPause === true, { timeout: 15000 });
    await gB.waitForFunction(() => disconnectedPause === true && gamePaused, { timeout: 15000 });
    const overlayText = await gB.evaluate(() => document.getElementById('mp-disconnect-text').textContent);
    if (!overlayText.includes('Waiting for')) throw new Error('guest B overlay: ' + overlayText);

    log('   [3p] paused on drop');
    // Rejoin: same browser context -> token match -> same seat, everyone resumes.
    gA = await newGamePage(joinQuery);
    await gA.waitForFunction(() => lockstepActive && gameStarted, { timeout: 30000 });
    log('   [3p] rejoined');
    await gA.waitForFunction(() => myTeam !== 0, { timeout: 5000 });
    const seatA2 = await gA.evaluate(() => myTeam);
    if (seatA2 !== seatA) throw new Error(`rejoined as team ${seatA2}, was ${seatA}`);
    await host.waitForFunction(() => disconnectedPause === false, { timeout: 15000 });
    await gB.waitForFunction(() => disconnectedPause === false, { timeout: 15000 });
    await host.waitForTimeout(2000);

    // Drop A again and kick: seat becomes AI everywhere, match resumes.
    await gA.close();
    await host.waitForFunction(() => disconnectedPause === true, { timeout: 15000 });
    log('   [3p] paused on second drop; kicking');
    await host.evaluate(() => kickDisconnectedPlayers());
    await host.waitForFunction(() => disconnectedPause === false, { timeout: 15000 });
    await gB.waitForFunction(() => disconnectedPause === false, { timeout: 15000 });
    await host.waitForFunction(s => teamControllers[s] && teamControllers[s].type === 'ai', seatA, { timeout: 15000 });
    await gB.waitForFunction(s => teamControllers[s] && teamControllers[s].type === 'ai', seatA, { timeout: 15000 });
    await host.waitForTimeout(9000); // lagged checksums after the kick
    await assertHealthy(host, 'host');
    await assertHealthy(gB, 'guest B');
    await assertChecksumsAgree([host, gB]);
    // A kicked identity must stay out.
    const gA3 = await newGamePage(joinQuery);
    await gA3.waitForFunction(() =>
      (document.getElementById('mp-status-text') || {}).textContent.includes('removed'), { timeout: 20000 });
    await host.close(); await gB.close(); await gA3.close();
  });

  await scenario('save/reload: host dies -> loads save in new tab -> both guests rejoin their seats', async () => {
    const { host, joinQuery } = await hostGame();
    const gA = await newGamePage(joinQuery);
    const gB = await newGamePage(joinQuery);
    await waitInLobby(host); await waitInLobby(gA); await waitInLobby(gB);
    await host.waitForFunction(() => lobbyState.seats.length === 3, { timeout: 20000 });
    await readyUp(gA); await readyUp(gB);
    await startMatch(host);
    for (const p of [host, gA, gB]) await waitMatchRunning(p);
    await host.waitForTimeout(3000);
    const teamsBefore = [await gA.evaluate(() => myTeam), await gB.evaluate(() => myTeam)];

    // Guest save surfaces are gone: menu button hidden, direct call refused.
    const guestSave = await gA.evaluate(() => ({
      btn: (document.getElementById('save-game-btn') || {}).style.display,
      len: (saveGameToFile(), 0), // guard returns without downloading
    }));
    if (guestSave.btn !== 'none') throw new Error('guest save button visible: ' + guestSave.btn);

    // Host banks the match to a (in-memory) save, then the page dies.
    const save = await host.evaluate(() => serializeGameForWire());
    if (save.version !== 3 || !save.seatTokens || save.seatTokens.length !== 2) {
      throw new Error('bad save meta: v' + save.version + ' tokens=' + JSON.stringify(save.seatTokens));
    }
    await host.close();
    await gA.waitForFunction(() => disconnectedPause === true, { timeout: 15000 });
    log('   [save] host dead, guests waiting');

    // Give the PeerJS cloud time to release the host's peer id, then load
    // the save in a fresh tab — it re-hosts with the SAME id, so the
    // guests' own reconnect loops land without a new link.
    await gA.waitForTimeout(8000);
    const h2 = await newGamePage();
    await h2.evaluate(s => applySavedGame(s), save);
    for (const g of [gA, gB]) {
      await g.waitForFunction(() => lockstepActive && gameStarted && disconnectedPause === false, { timeout: 60000 });
    }
    log('   [save] guests rejoined');
    const teamsAfter = [await gA.evaluate(() => myTeam), await gB.evaluate(() => myTeam)];
    if (teamsAfter.join() !== teamsBefore.join()) {
      throw new Error(`teams changed across reload: ${teamsBefore} -> ${teamsAfter}`);
    }
    await h2.waitForTimeout(9000);
    await assertHealthy(h2, 'reloaded host');
    await assertHealthy(gA, 'guest A');
    await assertHealthy(gB, 'guest B');
    await assertChecksumsAgree([h2, gA, gB]);
    await h2.close(); await gA.close(); await gB.close();
  });

  await browser.close();
  srv.close();

  const fails = results.filter(r => !r.pass);
  log('');
  log(`${results.length - fails.length}/${results.length} scenarios passed`);
  process.exit(fails.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
