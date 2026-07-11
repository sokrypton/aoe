#!/usr/bin/env node
// ---- HUD & command behavior tests (Playwright driver) ----
// Consolidates the staged-scenario probes that verified the guard-post,
// rally-target, auto-scout and selection-panel work: loads the REAL
// index.html, stages a flat world, drives commands through execCommand
// (the lockstep executor) and asserts on sim + DOM state. Complements
// tools/simulate.sh (whole-match health) and tools/screenshot-hud.js
// (visual acceptance) with fast, targeted assertions.
//
//   node tools/hud-tests.js          # run everything, exit 1 on any FAIL
//
// Server + browser bootstrap mirror tools/screenshot-hud.js.

const { ROOT, requireChromium, startServer, launchBrowser } = require('./lib/harness');
const chromium = requireChromium();

// Page-side test suite. Runs inside the loaded game; returns
// [{name, pass, detail}] — every scenario resets the world via stage().
function pageSuite() {
  const results = [];
  const T = (name, fn) => {
    try {
      const detail = fn(); // truthy/object = pass detail; throw = fail
      results.push({ name, pass: true, detail: detail === undefined ? '' : JSON.stringify(detail) });
    } catch (err) {
      results.push({ name, pass: false, detail: String(err && err.message || err) });
    }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  const stage = () => {
    NUM_TEAMS = 2;
    window.__pendingMatchSeed = 7;
    setMapSize('small');
    restartGame('standard');
    gameStarted = true; gamePaused = true;
    window.playSound = () => {}; window.showMsg = () => {};
    document.getElementById('tutorial').style.display = 'none';
    entities.length = 0; entitiesById.clear();
    selected.length = 0; corpses.length = 0;
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
      const t = map[y][x];
      t.occupied = null; t.res = 0; t.t = TERRAIN.GRASS;
      markMapDirty(x, y);
    }
    window.fogDisabled = true; updateFog();
    gameOver = false;
    // Both teams stay alive so no defeat path triggers mid-test.
    createBuilding('TC', 5, 5, 0);
    createBuilding('TC', 52, 52, 1);
  };
  const step = (n) => {
    for (let i = 0; i < n; i++) {
      tick++;
      entities.slice().forEach(u => {
        if (u.type === 'unit') updateUnit(u);
        else if (typeof updateBuilding === 'function') updateBuilding(u);
      });
    }
  };

  // ---- Guard posts ----
  T('guard: flag order paths units to formation posts and they arrive', () => {
    stage();
    const m = createUnit('militia', 20, 20, 0), a = createUnit('archer', 21, 20, 0);
    execCommand({ kind: 'guard', unitIds: [m.id, a.id], x: 30, y: 30 }, 0);
    assert(m.guardFlagged && a.guardFlagged, 'posts not flagged');
    step(600);
    assert(Math.hypot(m.x - m.guardX, m.y - m.guardY) < 1.6, 'militia not at post');
    assert(Math.hypot(a.x - a.guardX, a.y - a.guardY) < 1.6, 'archer not at post');
  });

  T('guard: displaced idle unit returns to its post', () => {
    stage();
    const m = createUnit('militia', 20, 20, 0);
    execCommand({ kind: 'guard', unitIds: [m.id], x: 30, y: 30 }, 0);
    step(600);
    m.x = 24; m.y = 24; clearUnitPath(m); m.target = null; m.task = null;
    step(600);
    assert(Math.hypot(m.x - m.guardX, m.y - m.guardY) < 1.6, 'did not return');
  });

  T('guard: plain move RELOCATES the post (implicit, unflagged)', () => {
    stage();
    const m = createUnit('militia', 20, 20, 0);
    execCommand({ kind: 'guard', unitIds: [m.id], x: 30, y: 30 }, 0);
    execCommand({ kind: 'command', unitIds: [m.id], tileX: 10, tileY: 10 }, 0);
    assert(m.guardX === 10 && m.guardY === 10, 'post not relocated: ' + m.guardX + ',' + m.guardY);
    assert(m.guardFlagged === false, 'implicit post must be unflagged');
  });

  T('guard: edge-of-map formation posts are clamped on-map', () => {
    stage();
    const squad = []; for (let i = 0; i < 8; i++) squad.push(createUnit('militia', 6 + i, 10, 0));
    execCommand({ kind: 'command', unitIds: squad.map(s => s.id), tileX: 0, tileY: 0 }, 0);
    assert(squad.every(s => s.guardX >= 0 && s.guardY >= 0), 'negative post coords');
  });

  T('guard: unreachable post SETTLES instead of repathing forever', () => {
    stage();
    const m = createUnit('militia', 20, 20, 0);
    for (let y = 28; y <= 32; y++) for (let x = 28; x <= 32; x++) { map[y][x].t = TERRAIN.FOREST; map[y][x].res = 100; markMapDirty(x, y); }
    execCommand({ kind: 'guard', unitIds: [m.id], x: 30, y: 30 }, 0);
    step(600);
    assert(!(m.guardX === 30 && m.guardY === 30), 'post never settled off the forest');
    assert(Math.hypot(m.x - m.guardX, m.y - m.guardY) < 2, 'settled post not at the unit');
  });

  T('guard: escort follows a moving unit, post freezes on its death', () => {
    stage();
    const m = createUnit('militia', 20, 20, 0), v = createUnit('villager', 22, 20, 0);
    execCommand({ kind: 'guard', unitIds: [m.id], x: 22, y: 20, targetId: v.id }, 0);
    assert(m.guardTargetId === v.id && m.followId === v.id, 'escort not bound');
    pathUnitTo(v, 35, 30);
    step(700);
    assert(Math.hypot(m.x - v.x, m.y - v.y) < 4, 'escort lost its charge');
    v.hp = 0; handleDeath(v, 1);
    step(30);
    assert(m.guardTargetId == null && m.guardX != null, 'post did not freeze on death');
  });

  T('guard: building flag takes perimeter watch posts', () => {
    stage();
    const bar = createBuilding('BARRACKS', 30, 30, 0);
    const a = createUnit('archer', 20, 30, 0);
    execCommand({ kind: 'guard', unitIds: [a.id], x: 31, y: 31, targetId: bar.id }, 0);
    step(600);
    assert(a.guardTargetId === bar.id, 'building not targeted');
    assert(Math.hypot(a.x - 31.5, a.y - 31.5) < 4, 'not standing watch at the building');
  });

  T('guard: garrison release re-pins the post to the drop spot', () => {
    stage();
    const m = createUnit('militia', 10, 10, 0);
    m.guardX = 40; m.guardY = 40; m.guardFlagged = false;
    const tc = entities.find(u => u.btype === 'TC' && u.team === 0);
    enterGarrison(m, tc);
    ejectGarrison(tc);
    assert(Math.hypot(m.guardX - 7, m.guardY - 7) < 6, 'post still at old spot: ' + m.guardX + ',' + m.guardY);
  });

  T('guard: trained HUMAN units inherit the rally flag as their post; AI units do NOT', () => {
    stage();
    const hb = createBuilding('BARRACKS', 30, 10, 0);
    hb.rallyX = 40; hb.rallyY = 12; hb.queue = ['militia']; hb.trainTick = 1e9;
    resourceStore(0).food += 500;
    const ab = createBuilding('BARRACKS', 46, 46, 1);
    ab.queue = ['militia']; ab.trainTick = 1e9;
    resourceStore(1).food += 500;
    step(5);
    const hm = entities.find(u => u.utype === 'militia' && u.team === 0);
    const am = entities.find(u => u.utype === 'militia' && u.team === 1);
    assert(hm && hm.guardX === 40 && hm.guardY === 12, 'human unit missing rally post');
    assert(am && am.guardX == null, 'AI unit must not carry a guard post');
  });

  T('auto-scout: turning it on drops the guard post; manual order cancels scouting', () => {
    stage();
    const sc = createUnit('scout', 30, 30, 0);
    execCommand({ kind: 'guard', unitIds: [sc.id], x: 35, y: 35 }, 0);
    execCommand({ kind: 'auto-scout', unitIds: [sc.id], on: true }, 0);
    assert(sc.autoScout && sc.guardX == null && !sc.guardFlagged, 'guard not dropped');
    execCommand({ kind: 'command', unitIds: [sc.id], tileX: 20, tileY: 20 }, 0);
    assert(!sc.autoScout, 'manual order did not cancel auto-scout');
  });

  // ---- Rally targets ----
  T('rally: a flag dropped on a unit snaps to ITS tile as a ground flag', () => {
    stage();
    const bar = createBuilding('BARRACKS', 20, 20, 0);
    const sheep = createUnit('sheep', 30, 30, GAIA_TEAM);
    sheep.x = 30.4; sheep.y = 30.7;
    execCommand({ kind: 'rally', bldgId: bar.id, tileX: 29, tileY: 28, targetId: sheep.id }, 0);
    assert(bar.rallyTargetId == null, 'unit kept as rally target');
    assert(bar.rallyX === 30 && bar.rallyY === 31, 'not snapped to the unit tile: ' + bar.rallyX + ',' + bar.rallyY);
  });

  T('rally: only enterable/market/foundation/enemy buildings stay targets', () => {
    stage();
    const bar = createBuilding('BARRACKS', 20, 20, 0);
    const tc = entities.find(u => u.btype === 'TC' && u.team === 0);
    execCommand({ kind: 'rally', bldgId: bar.id, tileX: 5, tileY: 5, targetId: tc.id }, 0);
    assert(bar.rallyTargetId === tc.id, 'TC (garrison) target dropped');
    const h = createBuilding('HOUSE', 40, 40, 0);
    execCommand({ kind: 'rally', bldgId: bar.id, tileX: 40, tileY: 40, targetId: h.id }, 0);
    assert(bar.rallyTargetId == null, 'own house kept as target');
    const eh = createBuilding('HOUSE', 44, 44, 1);
    execCommand({ kind: 'rally', bldgId: bar.id, tileX: 44, tileY: 44, targetId: eh.id }, 0);
    assert(bar.rallyTargetId === eh.id, 'enemy building target dropped');
  });

  // ---- HUD / DOM ----
  T('hud: queue badge + progress fill appear on the same updateUI pass as queueing', () => {
    stage();
    const tc = entities.find(u => u.btype === 'TC' && u.team === 0);
    selected = [tc]; updateUI();
    assert(!document.querySelector('#actions .queue-count'), 'badge before queueing');
    tc.queue.push('villager'); resourceStore(0).food -= 50;
    updateUI();
    assert(document.querySelector('#actions .queue-count'), 'badge missing after queueing');
    assert(document.querySelector('#actions .act-btn.training-active .btn-progress-fill'), 'progress fill missing');
  });

  T('hud: queue badge is display-only — no cancel handler, taps pass through', () => {
    stage();
    const bar = createBuilding('BARRACKS', 14, 14, 0);
    resourceStore(0).food = 500;
    selected = [bar]; updateUI();
    bar.queue.push('militia');
    updateUI();
    const badge = document.querySelector('#actions .queue-count');
    assert(badge, 'badge missing');
    assert(!badge.onclick, 'badge must have NO click handler');
    assert(getComputedStyle(badge).pointerEvents === 'none', 'badge must be pointer-events:none');
    // No queue slots in the mobile skin — cancelling is classic-only.
    assert(!document.querySelector('#actions .queue-slot'), 'mobile skin must not render queue slots');
  });

  T('hud: game over shows the outcome card even with units selected', () => {
    stage();
    const m = createUnit('militia', 20, 20, 0);
    selected = [m]; updateUI();
    gameOver = true; updateUI();
    const si = document.getElementById('sel-info');
    assert(!si.classList.contains('multi-select'), 'grid class still on at game over');
    assert(/VICTORY|DEFEAT/.test(document.getElementById('sel-name').textContent), 'no outcome text');
    gameOver = false;
  });

  T('hud: mixed civilian selection lifts the card cap (no-actions); all-military keeps the Guard slot', () => {
    stage();
    selected = [createUnit('villager', 20, 20, 0), createUnit('militia', 21, 20, 0)];
    updateUI();
    assert(document.getElementById('bottom').classList.contains('no-actions'), 'civilian mix built action buttons?');
    selected = [createUnit('archer', 22, 20, 0), createUnit('militia', 23, 20, 0)];
    updateUI();
    assert(!document.getElementById('bottom').classList.contains('no-actions'), 'military mix lost its Guard button');
    gameOver = false;
  });

  return results;
}

(async () => {
  let srv, browser;
  try {
    srv = await startServer('/index.html');
    const base = 'http://127.0.0.1:' + srv.address().port;
    browser = await launchBrowser(chromium);
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e.message || e)));
    await page.goto(base + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const b = document.getElementById('start-game-btn');
      return b && !b.disabled;
    }, { timeout: 15000 });

    const results = await page.evaluate(`(${pageSuite})()`);

    // Hover behavior needs a real pointer (runs outside pageSuite because
    // page.hover drives it): the dataset-dispatch tooltip on a train button.
    await page.evaluate(`(()=>{
      selected.length=0;
      const tc2=entities.find(u=>u.btype==='TC'&&u.team===0);
      selected=[tc2];updateUI();
    })()`);
    await page.hover('#actions .act-btn[data-tip-key="villager"]');
    await page.waitForTimeout(250);
    const tipVisible = await page.evaluate(`document.getElementById('tooltip').classList.contains('visible')`);
    results.push({ name: 'hud: action-button tooltip fires on hover (dataset dispatch)', pass: !!tipVisible, detail: '' });

    // Mobile market POPUP: auto-opens on selection, ✕ dismisses, the strip's
    // Trade button reopens, and deselecting retires it.
    const popupOk = await page.evaluate(`(()=>{
      selected.length=0; window.__mktPopupHidden=false;
      const mk=createBuilding('MARKET',24,24,0);
      selected=[mk];updateUI();
      const pop=document.getElementById('mkt-popup');
      const r={open: !!pop && pop.style.display!=='none',
               cells: pop ? pop.querySelectorAll('.mkt-cell').length : 0,
               stripHasExchange: !!document.querySelector('#actions .mkt-exchange'),
               tradeBtn: !!document.getElementById('mkt-trade-btn')};
      pop.querySelector('#mkt-popup-x').click();
      r.closedByX = pop.style.display==='none';
      document.getElementById('mkt-trade-btn').click();
      r.reopened = pop.style.display!=='none';
      selected=[entities.find(u=>u.btype==='TC'&&u.team===0)];updateUI();
      r.retiredOnDeselect = pop.style.display==='none';
      // Re-tapping the selected Market reopens a dismissed popup.
      selected=[mk];updateUI();
      pop.querySelector('#mkt-popup-x').click();
      maybeReopenMktPopup(mk);
      r.reopenOnRetap = pop.style.display!=='none';
      selected.length=0;updateUI();
      return r;
    })()`);
    const popupPass = popupOk.open && popupOk.cells===6 && !popupOk.stripHasExchange
      && popupOk.tradeBtn && popupOk.closedByX && popupOk.reopened && popupOk.retiredOnDeselect
      && popupOk.reopenOnRetap;
    results.push({ name: 'hud: mobile market exchange is a dismissible popup (strip stays clear)', pass: popupPass, detail: popupPass?'':JSON.stringify(popupOk) });

    // ---- Desktop tap-mode (index.html): REAL mouse events through the
    // mouseup dispatch. submitCommand is stubbed to capture commands (the
    // sim is paused anyway); screen coords derive from the same transform
    // screenToTile inverts. classic.html gets a regression guard at the end.
    const tapStage = (code) => `(()=>{
      NUM_TEAMS=2;window.__pendingMatchSeed=7;setMapSize('small');restartGame('standard');
      gameStarted=true;gamePaused=true;window.playSound=()=>{};window.showMsg=()=>{};
      document.getElementById('tutorial').style.display='none';
      entities.length=0;entitiesById.clear();selected.length=0;
      for(let y=0;y<MAP;y++)for(let x=0;x<MAP;x++){const t=map[y][x];t.occupied=null;t.res=0;t.t=TERRAIN.GRASS;markMapDirty(x,y);}
      window.fogDisabled=true;updateFog();gameOver=false;
      createBuilding('TC',5,5,0);createBuilding('TC',52,52,1);
      if(!window.__realSubmit) window.__realSubmit = window.submitCommand;
      window.__cmds = []; window.submitCommand = (c)=>{ window.__cmds.push(c); };
      const iso=toIso(30,30);camX=iso.ix;camY=iso.iy;window.targetCamX=camX;window.targetCamY=camY;
      ${code}
      updateUI(); try{render()}catch(e){}
      const scr=(x,y)=>{const p=toIso(x,y);return{x:(p.ix-camX)*ZOOM+W/2,y:(p.iy-camY)*ZOOM+H/2+topH};};
      return window.__pts(scr);
    })()`;
    const tapT = async (name, fn) => {
      try { await fn(); results.push({ name, pass: true, detail: '' }); }
      catch (err) { results.push({ name, pass: false, detail: String(err && err.message || err) }); }
    };
    const assertEq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

    await tapT('desktop-tap: click own unit selects it (no command)', async () => {
      const pts = await page.evaluate(tapStage(`
        const m=createUnit('militia',30,30,0);
        window.__pts=(scr)=>({ m: scr(m.x, m.y) });`));
      await page.mouse.click(pts.m.x, pts.m.y - 8);
      const r = await page.evaluate(`({sel:selected.length, own:selected[0]&&selected[0].utype, cmds:window.__cmds.length})`);
      assertEq(r.sel, 1, 'selection size'); assertEq(r.own, 'militia', 'selected type'); assertEq(r.cmds, 0, 'commands');
    });

    await tapT('desktop-tap: ground click commands the selection and KEEPS it (walk order)', async () => {
      const pts = await page.evaluate(tapStage(`
        const m=createUnit('militia',30,30,0); selected=[m];
        window.__pts=(scr)=>({ g: scr(35.5, 30.5) });`));
      await page.mouse.click(pts.g.x, pts.g.y);
      const r = await page.evaluate(`({sel:selected.length, cmd:window.__cmds.find(c=>c.kind==='command')})`);
      if (!r.cmd) throw new Error('no command captured');
      assertEq(r.cmd.tileX, 35, 'tileX'); assertEq(r.cmd.tileY, 30, 'tileY');
      assertEq(r.sel, 1, 'selection must be KEPT after a walk order');
    });

    await tapT('desktop-tap: resource click assigns villagers and RELEASES them', async () => {
      const pts = await page.evaluate(tapStage(`
        const v=createUnit('villager',30,30,0); selected=[v];
        map[30][33].t=TERRAIN.BERRIES; map[30][33].res=100; markMapDirty(33,30);
        window.__pts=(scr)=>({ b: scr(33.5, 30.5) });`));
      await page.mouse.click(pts.b.x, pts.b.y);
      const r = await page.evaluate(`({sel:selected.length, cmd:window.__cmds.find(c=>c.kind==='command')})`);
      if (!r.cmd) throw new Error('no command captured');
      assertEq(r.sel, 0, 'selection must be RELEASED after a gather order');
    });

    await tapT('desktop-tap: shift-click toggles a unit in and out of the selection', async () => {
      const pts = await page.evaluate(tapStage(`
        const a=createUnit('militia',28,30,0), b=createUnit('archer',33,27,0);
        window.__pts=(scr)=>({ a: scr(a.x,a.y), b: scr(b.x,b.y) });`));
      await page.mouse.click(pts.a.x, pts.a.y - 8);
      await page.keyboard.down('Shift');
      await page.mouse.click(pts.b.x, pts.b.y - 8);
      const r1 = await page.evaluate(`selected.length`);
      await page.mouse.click(pts.b.x, pts.b.y - 8);
      await page.keyboard.up('Shift');
      const r2 = await page.evaluate(`selected.length`);
      assertEq(r1, 2, 'shift-click must ADD'); assertEq(r2, 1, 'second shift-click must REMOVE');
    });

    await tapT('desktop-tap: left-drag box-select still works', async () => {
      const pts = await page.evaluate(tapStage(`
        const u1=createUnit('militia',29,30,0), u2=createUnit('archer',31,30,0);
        // Box corners in SCREEN space around both sprites (world corners on
        // the iso diagonal collapse to a zero-width screen rect).
        window.__pts=(scr)=>{
          const p1=scr(u1.x,u1.y), p2=scr(u2.x,u2.y);
          return { tl:{x:Math.min(p1.x,p2.x)-50, y:Math.min(p1.y,p2.y)-60},
                   br:{x:Math.max(p1.x,p2.x)+50, y:Math.max(p1.y,p2.y)+30} };
        };`));
      await page.mouse.move(pts.tl.x, pts.tl.y);
      await page.mouse.down();
      await page.mouse.move(pts.br.x, pts.br.y, { steps: 6 });
      await page.mouse.up();
      const r = await page.evaluate(`selected.length`);
      assertEq(r, 2, 'box-select count');
    });

    await tapT('desktop-tap: rally click previews the flag at the clicked tile during command latency', async () => {
      const pts = await page.evaluate(tapStage(`
        const bar=createBuilding('BARRACKS',26,26,0); bar.rallyX=40; bar.rallyY=12;
        selected=[bar]; window.settingRally=true; window.pendingRallyPreview=null;
        window.__pts=(scr)=>({ g: scr(30.5,30.5) });`));
      await page.mouse.click(pts.g.x, pts.g.y);
      const r = await page.evaluate(`({prev:window.pendingRallyPreview, stale:[selected[0].rallyX,selected[0].rallyY]})`);
      if (!r.prev || r.prev.x !== 30 || r.prev.y !== 30) throw new Error('preview missing/wrong: ' + JSON.stringify(r.prev));
      assertEq(r.stale[0], 40, 'rally must still be stale (command queued, not executed)');
    });

    await tapT('desktop-tap: right-click does NOT move a rally on index.html (button-armed mode only)', async () => {
      const pts = await page.evaluate(tapStage(`
        const bar=createBuilding('BARRACKS',26,26,0); bar.rallyX=40; bar.rallyY=12;
        selected=[bar]; window.pendingRallyPreview=null;
        window.__pts=(scr)=>({ g: scr(30.5,30.5) });`));
      await page.mouse.click(pts.g.x, pts.g.y, { button: 'right' });
      const r = await page.evaluate(`({cmds:window.__cmds.filter(c=>c.kind==='rally').length, prev:window.pendingRallyPreview})`);
      assertEq(r.cmds, 0, 'rally command must not be issued by right-click on the tap skin');
      if (r.prev) throw new Error('preview must not appear');
    });

    await tapT('classic-guard: right-click DOES set the rally on classic.html (AoE2 standard)', async () => {
      const cpage = await ctx.newPage();
      await cpage.goto(base + '/classic.html', { waitUntil: 'load' });
      await cpage.waitForFunction(() => {
        const b = document.getElementById('start-game-btn');
        return b && !b.disabled;
      }, { timeout: 15000 });
      const pts = await cpage.evaluate(tapStage(`
        const bar=createBuilding('BARRACKS',26,26,0); bar.rallyX=40; bar.rallyY=12;
        selected=[bar];
        window.__pts=(scr)=>({ g: scr(30.5,30.5) });`));
      await cpage.mouse.click(pts.g.x, pts.g.y, { button: 'right' });
      const r = await cpage.evaluate(`window.__cmds.find(c=>c.kind==='rally')`);
      if (!r) throw new Error('classic right-click must issue the rally command');
      assertEq(r.tileX, 30, 'rally tileX');
      await cpage.close();
    });

    await tapT('classic-guard: left ground click never commands on classic.html', async () => {
      const cpage = await ctx.newPage();
      await cpage.goto(base + '/classic.html', { waitUntil: 'load' });
      await cpage.waitForFunction(() => {
        const b = document.getElementById('start-game-btn');
        return b && !b.disabled;
      }, { timeout: 15000 });
      const pts = await cpage.evaluate(tapStage(`
        const m=createUnit('militia',30,30,0); selected=[m];
        window.__pts=(scr)=>({ g: scr(35.5, 30.5) });`));
      await cpage.mouse.click(pts.g.x, pts.g.y);
      const r = await cpage.evaluate(`({sel:selected.length, cmds:window.__cmds.filter(c=>c.kind==='command').length})`);
      assertEq(r.cmds, 0, 'classic left-click must NOT command');
      assertEq(r.sel, 0, 'classic empty click deselects');
      await cpage.close();
    });

    await tapT('classic-guard: queue renders as AoE2 slot buttons and clicking one cancels it', async () => {
      const cpage = await ctx.newPage();
      await cpage.goto(base + '/classic.html', { waitUntil: 'load' });
      await cpage.waitForFunction(() => {
        const b = document.getElementById('start-game-btn');
        return b && !b.disabled;
      }, { timeout: 15000 });
      await cpage.evaluate(tapStage(`
        const bar=createBuilding('BARRACKS',26,26,0);
        bar.queue.push('militia','spearman');
        selected=[bar]; window.__pts=()=>({});`));
      const r = await cpage.evaluate(`(()=>{
        updateUI();
        // Queue slots live in the CENTER panel's #sel-queue lane in classic
        // (real AoE2 shows the training queue in the info panel).
        const slots=[...document.querySelectorAll('#sel-queue .queue-slot')];
        if(slots.length!==2) return {slots:slots.length};
        slots[1].click(); // cancel the queued spearman
        const cancel=window.__cmds.find(c=>c.kind==='cancel-queue');
        // Classic: AoE2-style grid-button exchange in the command panel
        // (two aligned rows of six price buttons), and no popup.
        const mk=createBuilding('MARKET',40,40,0);
        selected=[mk];updateUI();
        const rows=document.querySelectorAll('#actions .mkt-grid-row').length;
        const btns=[...document.querySelectorAll('#actions .mkt-btn')];
        let tradeCmd=null;
        if(btns.length===6){ btns[0].click(); tradeCmd=window.__cmds.find(c=>c.kind==='market-trade'); }
        const noPopup=!document.getElementById('mkt-popup');
        return {slots:2, cancel, frontHasVeil: !!slots[0].querySelector('.train-veil'),
                rows, btnCount: btns.length, tradeCmd, noPopup};
      })()`);
      assertEq(r.slots, 2, 'slot count');
      if (!r.cancel || r.cancel.idx !== 1) throw new Error('cancel command wrong: ' + JSON.stringify(r.cancel));
      if (!r.frontHasVeil) throw new Error('front slot missing training veil');
      if (r.rows!==2 || r.btnCount!==6 || !r.noPopup) throw new Error('classic exchange shape wrong: ' + JSON.stringify(r));
      if (!r.tradeCmd || r.tradeCmd.dir!=='buy' || r.tradeCmd.resType!=='food') throw new Error('buy-food button wrong: ' + JSON.stringify(r.tradeCmd));
      await cpage.close();
    });

    // Un-stub for anything that runs after this section.
    await page.evaluate(`if (window.__realSubmit) window.submitCommand = window.__realSubmit;`);

    let failed = 0;
    for (const r of results) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  — ' + r.detail}`);
      if (!r.pass) failed++;
    }
    if (pageErrors.length) {
      console.error('JS ERRORS:\n  ' + pageErrors.join('\n  '));
      failed++;
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    console.error('HUD TEST HARNESS ERROR: ' + (err && err.stack || err));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (srv) srv.close();
  }
})();
