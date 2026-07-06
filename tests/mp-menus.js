// E2E for the menu redesign: persistence, cancel-hosting, retry, MP pause,
// game-over menus, guest minimal menu.
const { chromium } = require('playwright');
const BASE = (process.env.AOE_URL || 'http://127.0.0.1:8471/') + 'index.html';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, name) => { console.log((cond ? 'PASS' : 'FAIL') + ': ' + name); if (!cond) failures++; };

(async () => {
  const b = await chromium.launch();

  // --- 1. Settings persistence across reload
  {
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE); await p.waitForTimeout(800);
    await p.evaluate(() => {
      showMenuPanel('options');
      document.querySelector('input[name="difficulty"][value="hard"]').checked = true;
      document.querySelector('input[name="gamespeed"][value="4"]').checked = true;
      document.querySelector('input[name="mapsize"][value="large"]').checked = true;
      closeOptionsPanel();
    });
    await p.reload(); await p.waitForTimeout(800);
    const persisted = await p.evaluate(() => ({
      d: document.querySelector('input[name="difficulty"]:checked').value,
      s: document.querySelector('input[name="gamespeed"]:checked').value,
      m: document.querySelector('input[name="mapsize"]:checked').value,
    }));
    check(persisted.d === 'hard' && persisted.s === '4' && persisted.m === 'large',
      'settings persist across reload (' + JSON.stringify(persisted) + ')');
    await ctx.close();
  }

  // --- 2. Cancel hosting restores menu; SP start still works
  {
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE); await p.waitForTimeout(800);
    await p.evaluate(() => onHostClicked());
    await p.waitForFunction(() => typeof netPeer !== 'undefined' && netPeer && netPeer.id, null, { timeout: 20000 });
    const cancelVisible = await p.evaluate(() => document.getElementById('mp-cancel-btn').style.display !== 'none'
      && document.getElementById('mp-status-panel').style.display !== 'none');
    await p.evaluate(() => cancelHosting());
    await p.waitForTimeout(300);
    const restored = await p.evaluate(() => ({
      panelHidden: document.getElementById('mp-status-panel').style.display === 'none',
      startVisible: document.getElementById('start-row').style.display !== 'none',
      hostEnabled: !document.getElementById('host-game-btn').disabled,
      role: netRole, peer: netPeer,
    }));
    await p.evaluate(() => onStartClicked());
    await p.waitForTimeout(600);
    const spStarted = await p.evaluate(() => gameStarted && entities.length > 0 && netRole === null);
    check(cancelVisible && restored.panelHidden && restored.startVisible && restored.hostEnabled
      && restored.role === null && restored.peer === null && spStarted,
      'cancel hosting restores menu and SP start works');
    await ctx.close();
  }

  // --- 3. Guest retry button on failed connect
  {
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE + '?join=nonexistent-peer-id-12345');
    await p.waitForFunction(() => {
      const btn = document.getElementById('mp-retry-btn');
      return btn && btn.style.display !== 'none';
    }, null, { timeout: 45000 }).catch(() => {});
    const retryVisible = await p.evaluate(() => document.getElementById('mp-retry-btn').style.display !== 'none');
    check(retryVisible, 'guest retry button appears on failed connect');
    await ctx.close();
  }

  // --- 4. Full MP: join, guest minimal menu, pause broadcast, game-over both sides
  {
    const hostCtx = await b.newContext();
    const host = await hostCtx.newPage();
    const errs = [];
    host.on('pageerror', e => errs.push('host: ' + e.message));
    await host.goto(BASE); await host.waitForTimeout(800);
    await host.evaluate(() => onHostClicked());
    await host.waitForFunction(() => typeof netPeer !== 'undefined' && netPeer && netPeer.id, null, { timeout: 20000 });
    const id = await host.evaluate(() => netPeer.id);
    const guestCtx = await b.newContext();
    const guest = await guestCtx.newPage();
    guest.on('pageerror', e => errs.push('guest: ' + e.message));
    await guest.goto(BASE + '?join=' + id);
    await guest.waitForFunction(() => typeof map !== 'undefined' && map.length > 0, null, { timeout: 30000 });
    check(true, 'MP match starts after redesign');

    // guest minimal menu: open ☰ and inspect
    await guest.evaluate(() => toggleMenu());
    await guest.waitForTimeout(300);
    const guestMenu = await guest.evaluate(() => ({
      resume: document.getElementById('resume-game-btn').style.display !== 'none',
      save: document.getElementById('save-game-btn').style.display !== 'none',
      start: document.getElementById('start-game-btn').style.display === 'none',
      mpRow: document.getElementById('mp-row').style.display === 'none',
      options: document.getElementById('options-btn').offsetParent !== null,
      speedHidden: document.querySelector('.setup-col-speed').style.display === 'none',
    }));
    check(Object.values(guestMenu).every(Boolean),
      'guest mid-match menu minimal + options available, speed hidden (' + JSON.stringify(guestMenu) + ')');
    // host should be paused via broadcast
    await host.waitForTimeout(500);
    const hostPaused = await host.evaluate(() => gamePaused);
    await guest.evaluate(() => toggleMenu());
    await host.waitForTimeout(500);
    const hostResumed = await host.evaluate(() => !gamePaused);
    check(hostPaused && hostResumed, 'menu pause broadcast still works both ways');

    // game over: host wins → both auto-show game-over menus. The kill goes
    // through the command queue (dev-destroy) so BOTH lockstep sims see it;
    // guest units die too so team 1 is fully eliminated.
    await Promise.all([host, guest].map(p => p.evaluate(() => { window.DEV_TEST_COMMANDS = true; })));
    await host.evaluate(() => {
      entities.filter(e => e.team === 1).forEach(e => submitCommand({ kind: 'dev-destroy', id: e.id }));
    });
    await host.waitForTimeout(4500);
    const hostGo = await host.evaluate(() => ({
      over: gameOver,
      menu: document.getElementById('tutorial').style.display === 'flex',
      banner: document.getElementById('game-over-banner').style.display !== 'none',
      title: document.getElementById('game-over-title').textContent,
      playAgain: document.getElementById('start-game-btn').textContent.includes('Rematch'),
    }));
    const guestGo = await guest.evaluate(() => ({
      over: gameOver,
      menu: document.getElementById('tutorial').style.display === 'flex',
      banner: document.getElementById('game-over-banner').style.display !== 'none',
      title: document.getElementById('game-over-title').textContent,
    }));
    check(hostGo.over && hostGo.menu && hostGo.banner && hostGo.title.includes('Victory') && hostGo.playAgain,
      'host auto game-over menu with Victory (' + JSON.stringify(hostGo) + ')');
    check(guestGo.over && guestGo.menu && guestGo.banner && guestGo.title.includes('Defeat'),
      'guest auto game-over menu with Defeat (' + JSON.stringify(guestGo) + ')');

    // Rematch on host → fresh MP match over the same connection
    await host.evaluate(() => handleStartButton());
    await host.waitForTimeout(2500);
    const hostFresh = await host.evaluate(() => gameStarted && !gameOver && netRole === 'host' && netConnected && entities.length > 0);
    const guestFresh = await guest.evaluate(() => !gameOver && entities.length > 0
      && document.getElementById('tutorial').style.display === 'none');
    check(hostFresh && guestFresh, 'Rematch after MP game-over starts fresh MP match for both');
    console.log('page errors:', errs.length ? errs : 'none');
    if (errs.length) failures++;
    await hostCtx.close(); await guestCtx.close();
  }

  await b.close();
  console.log(failures ? 'RESULT: ' + failures + ' FAILURES' : 'RESULT: ALL PASS');
  process.exit(failures ? 1 : 0);
})();
