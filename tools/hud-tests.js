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

  T('auto-scout: enabling it releases an ESCORT immediately (clears followId, no lingering chase)', () => {
    stage();
    const sc = createUnit('scout', 30, 30, 0);
    const vil = createUnit('villager', 31, 31, 0);
    execCommand({ kind: 'guard', unitIds: [sc.id], x: 31, y: 31, targetId: vil.id }, 0);
    assert(sc.guardTargetId === vil.id && sc.followId === vil.id, 'escort not bound');
    execCommand({ kind: 'auto-scout', unitIds: [sc.id], on: true }, 0);
    assert(sc.autoScout, 'auto-scout not on');
    assert(sc.followId == null, 'followId not cleared — scout would keep escorting');
    assert(sc.guardTargetId == null && sc.guardX == null && !sc.guardFlagged, 'guard/escort state not fully dropped');
    // and it does not re-glue to the villager as the villager moves
    pathUnitTo(vil, 40, 40);
    step(60);
    assert(sc.followId == null, 'escort re-bound after auto-scout');
  });

  T('villager sent to an UNSEEN resource just walks (no auto-gather); an explored one gathers', () => {
    stage();
    window.fogDisabled = false;
    resetTeamVision(); // fresh per-team grids, everything unexplored
    const v = createUnit('villager', 30, 30, 0);
    map[30][40].t = TERRAIN.FOREST; map[30][40].res = 100; markMapDirty(40, 30);
    // (40,30) has never been seen by team 0 → the click is a plain walk
    execCommand({ kind: 'command', unitIds: [v.id], tileX: 40, tileY: 30 }, 0);
    assert(v.task == null, 'villager auto-gathered an UNSEEN resource: task=' + v.task);
    // once the tile is explored, the same click DOES start gathering
    teamExploredGrid[0][30 * MAP + 40] = 1;
    execCommand({ kind: 'command', unitIds: [v.id], tileX: 40, tileY: 30 }, 0);
    assert(v.task === 'chop', 'villager did not gather an explored resource: task=' + v.task);
    window.fogDisabled = true; // restore for later tests
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

  T('hud: TC portrait icon changes with age (Dark=wood, Feudal=stone, Castle=base)', () => {
    stage();
    const tc = entities.find(e => e.btype === 'TC' && e.team === 0);
    selected = [tc];
    const iconCls = () => { updateUI(); const el = document.querySelector('#sel-portrait .tile-sprite-img'); return el ? el.className : ''; };
    teamAge[0] = 0; { let c = iconCls(); assert(/icon-TC-dark/.test(c), 'Dark should be TC-dark, got: ' + c); }
    teamAge[0] = 1; { let c = iconCls(); assert(/icon-TC-feudal/.test(c), 'Feudal should be TC-feudal, got: ' + c); }
    teamAge[0] = 2; { let c = iconCls(); assert(/icon-TC-castle/.test(c), 'Castle should be TC-castle, got: ' + c); }
    teamAge[0] = 0;
  });

  T('hud: Watch Tower icon is age-specific (Feudal variant, Castle keeps base) — portrait + build button', () => {
    stage();
    // portrait: select a TOWER, check the age variant (portrait rebuilds live)
    const tower = createBuilding('TOWER', 10, 10, 0);
    selected = [tower];
    const portCls = () => { updateUI(); const el = document.querySelector('#sel-portrait .tile-sprite-img'); return el ? el.className : ''; };
    teamAge[0] = 1; { let c = portCls(); assert(/icon-WT-feudal/.test(c), 'Feudal portrait should be WT-feudal, got: ' + c); }
    teamAge[0] = 2; { let c = portCls(); assert(/icon-WT-castle/.test(c), 'Castle portrait should be WT-castle, got: ' + c); }
    // build button: the villager military submenu's Watch Tower button uses the
    // same age variant. A fresh villager per age forces the actions to rebuild
    // (selKey doesn't include teamAge); then switch to the 'mil' submenu so the
    // TOWER button renders at the current age.
    const buildBtnClsAtAge = (age) => {
      teamAge[0] = age;
      selected = [createUnit('villager', 12, 12 + age, 0)];
      updateUI();                          // new selection → submenu resets to 'main'
      window.currentVillagerMenu = 'mil';
      updateUI();                          // submenu changed → rebuild at current age
      const btn = [...document.querySelectorAll('#actions .act-btn')].find(b => b.dataset.tipKey === 'TOWER');
      const spr = btn && btn.querySelector('.sprite-icon');
      return spr ? spr.className : (btn ? 'NO-SPRITE' : 'NO-BTN');
    };
    let f = buildBtnClsAtAge(1); assert(/icon-WT-feudal/.test(f), 'Feudal build button should be WT-feudal, got: ' + f);
    let cst = buildBtnClsAtAge(2); assert(/icon-WT-castle/.test(cst), 'Castle build button should be WT-castle, got: ' + cst);
    teamAge[0] = 0; window.currentVillagerMenu = 'main';
  });

  // ---- Palisade Watch Tower (PTOWER): dark-age build-over-wall with
  // refund, garrison arrows, and the in-place Feudal upgrade to TOWER
  // (execUpgradeWalls' WALL_STONE_MATCH extension).
  T('ptower: builds over a palisade wall (tile consumed, wood refunded)', () => {
    stage();
    const store = resourceStore(0);
    store.wood = 1000;
    const wall = createBuilding('WALL', 30, 30, 0);
    const v = createUnit('villager', 29, 29, 0);
    execCommand({ kind: 'build-placement', btype: 'PTOWER', tileX: 30, tileY: 30, unitIds: [v.id] }, 0);
    assert(!entitiesById.get(wall.id), 'wall not consumed');
    const pt = entities.find(e => e.type === 'building' && e.btype === 'PTOWER' && e.x === 30 && e.y === 30);
    assert(pt, 'no PTOWER foundation placed');
    // 110 wood minus the consumed palisade's own 2-wood refund
    assert(store.wood === 1000 - (BLDGS.PTOWER.cost.w - BLDGS.WALL.cost.w), 'refund math off: ' + store.wood);
  });

  T('ptower: fires 1+garrison arrows at enemies in range', () => {
    stage();
    const pt = createBuilding('PTOWER', 30, 30, 0);
    createUnit('militia', 33, 30, 1); // enemy in range 6
    for (let i = 0; i < 3; i++) enterGarrison(createUnit('militia', 29, 30, 0), pt);
    assert(garrisonCount(pt) === 3, 'garrison cap 3 not honored: ' + garrisonCount(pt));
    projectiles.length = 0;
    step(1);
    assert(projectiles.length === 4, 'expected 4 arrows (1+3 garrison), got ' + projectiles.length);
  });

  T('ptower: upgrade = instant swap to a construction site — Dark-age rejected; salvage refunds; committed (no cancel); villagers finish a full TOWER', () => {
    stage();
    const store = resourceStore(0);
    store.wood = 1000; store.stone = 1000;
    const pt = createBuilding('PTOWER', 30, 30, 0);
    execCommand({ kind: 'upgrade-walls', unitIds: [pt.id] }, 0);
    assert(pt.btype === 'PTOWER' && pt.complete, 'upgraded in the Dark Age');
    teamAge[0] = 1;
    pt.hp = Math.round(pt.maxHp / 2); // half-damaged: salvage must halve → floor(110w * 0.5) = 55
    execCommand({ kind: 'upgrade-walls', unitIds: [pt.id] }, 0);
    assert(pt.btype === 'TOWER', 'did not swap to TOWER');
    assert(!pt.complete && pt.hp === 1 && pt.upgrading, 'not a committed construction site: complete=' + pt.complete + ' hp=' + pt.hp + ' upgrading=' + pt.upgrading);
    // salvage 55 wood credited before the full TOWER cost is charged
    assert(store.wood === 1000 + 55 - BLDGS.TOWER.cost.w, 'wood salvage off: ' + store.wood);
    assert(store.stone === 1000 - BLDGS.TOWER.cost.s, 'stone cost off: ' + store.stone);
    // committed: deleting the site gives NO refund (can't cancel an upgrade)
    const wBefore = store.wood, sBefore = store.stone;
    deleteOwnedEntity(pt);
    assert(store.wood === wBefore && store.stone === sBefore, 'cancelling a committed upgrade refunded: ' + store.wood + '/' + store.stone);
    // fresh run: villagers build the swapped site up into a full Watch Tower
    stage();
    const s2 = resourceStore(0); s2.wood = 1000; s2.stone = 1000; teamAge[0] = 1;
    const pt2 = createBuilding('PTOWER', 30, 30, 0);
    execCommand({ kind: 'upgrade-walls', unitIds: [pt2.id] }, 0);
    const v = createUnit('villager', 29.5, 30.5, 0);
    v.task = 'build'; v.buildTarget = pt2.id;
    step(BLDGS.TOWER.buildTime + 600);
    assert(pt2.complete && !pt2.upgrading, 'villager never finished the upgrade');
    assert(pt2.maxHp === buildingMaxHpFor(0, 'TOWER') && pt2.hp === pt2.maxHp, 'not full TOWER hp: ' + pt2.hp + '/' + pt2.maxHp);
    assert(pt2.atk === BLDGS.TOWER.atk, 'atk not refreshed: ' + pt2.atk);
  });

  // ---- Building guard covers the WHOLE footprint, not one corner ----
  T('guard: a building guard leashes to the whole footprint (chases across a 4x4 TC), but still leashes beyond it', () => {
    stage();
    const tc = createBuilding('TC', 20, 20, 0); // 4x4 → tiles 20..23
    const g = createUnit('militia', 19, 19, 0);
    // guard the TC; home post at the NW exterior corner
    execCommand({ kind: 'guard', unitIds: [g.id], x: 19, y: 19, targetId: tc.id }, 0);
    assert(g.guardTargetId === tc.id, 'not guarding the TC');
    const foe = createUnit('militia', 24.5, 24.5, 1); // SE exterior corner of the TC
    // simulate having chased to the far (SE) corner — ~7 tiles from the NW
    // home post (old point-leash would yank it home) but adjacent to the
    // footprint (new footprint-leash keeps it engaged)
    g.guardX = 19; g.guardY = 19; g.explicitAttack = false;
    g.x = 24; g.y = 24; clearUnitPath(g); g.target = foe.id;
    step(3);
    assert(g.target === foe.id, 'footprint guard was leash-yanked off a threat at the far side of its building');
    // but a genuine over-leash (well beyond the footprint) still pulls home
    const foe2 = createUnit('militia', 30.5, 30.5, 1);
    g.x = 31; g.y = 31; clearUnitPath(g); g.target = foe2.id;
    step(3);
    assert(g.target === null, 'guard failed to leash back when dragged well beyond the building');
  });

  T('guard: a building guard ignores an enemy that is near the guard but far from the building (no wandering chase)', () => {
    stage();
    const tc = createBuilding('TC', 20, 20, 0); // 4x4 → edges x/y 19.5..23.5
    const g = createUnit('militia', 19, 19, 0);
    g.stance = 'defensive';
    g.guardTargetId = tc.id; g.guardX = 19; g.guardY = 19; g.guardFlagged = true; g.explicitAttack = false;
    // displace the guard east of the TC (still within its footprint leash),
    // then drop an enemy that is close to the GUARD (~5 tiles) but well
    // outside the building's guard zone (~9 tiles past its east edge)
    g.x = 28; g.y = 20; g.target = null; g.task = null; clearUnitPath(g);
    const foe = createUnit('militia', 33, 20, 1);
    step(9); // spans several acquisition scan ticks
    assert(g.target !== foe.id, 'guard chased an enemy that was not threatening its building');
    // sanity: an enemy INSIDE the guard zone (near the TC) IS engaged
    const near = createUnit('militia', 25, 21, 1); // ~1.5 tiles past the SE edge
    g.x = 24; g.y = 22; g.target = null; g.task = null; clearUnitPath(g);
    step(9);
    assert(g.target === near.id, 'guard ignored an enemy right next to its building');
  });

  T('guard: multiple building guards fan out to distinct perimeter posts', () => {
    stage();
    const tc = createBuilding('TC', 20, 20, 0);
    const squad = [createUnit('militia',18,18,0), createUnit('militia',18,19,0),
                   createUnit('militia',18,20,0), createUnit('militia',18,21,0)];
    execCommand({ kind: 'guard', unitIds: squad.map(s=>s.id), x: 19, y: 19, targetId: tc.id }, 0);
    const posts = new Set(squad.map(s => s.guardX + ',' + s.guardY));
    assert(squad.every(s => s.guardTargetId === tc.id), 'not all guarding the TC');
    assert(posts.size === squad.length, 'guards piled onto shared posts: ' + [...posts].join(' '));
  });

  // ---- AI keeps building after an upgrade ----
  // The wall→stone upgrade (execUpgradeWalls) now swaps the piece into a
  // 1-HP construction site instead of finishing instantly, so the AI MUST
  // route a villager to it or it leaves stranded 1-HP walls. Verifies the
  // AI's own villager-assignment loop (assignAIVillagers) picks up the
  // swapped site and finishes it.
  T('ai: upgrading a wall to stone re-tasks an idle AI villager to finish the construction site', () => {
    stage();
    teamControllers[1] = { type: 'ai', difficulty: 'hard' };
    AI_STATES[1] = freshAIState(1);
    teamAge[1] = 1; // Feudal: stone unlocked
    const store = resourceStore(1);
    store.wood = 1000; store.stone = 1000;
    const wall = createBuilding('WALL', 50, 50, 1); // beside the team-1 TC at 52,52
    const vil = createUnit('villager', 49, 49, 1);
    vil.task = null; vil.target = null; vil.buildTarget = null; clearUnitPath(vil);
    // upgrade → instant swap to a committed SWALL construction site
    execCommand({ kind: 'upgrade-walls', unitIds: [wall.id] }, 1);
    assert(wall.btype === 'SWALL' && !wall.complete && wall.upgrading, 'upgrade did not create a construction site');
    // the AI's decision loop should hand the idle villager this build
    assignAIVillagers(AI_STATES[1], [vil], aiProfileFor(1));
    assert(vil.task === 'build' && vil.buildTarget === wall.id, 'AI did not assign a builder to the upgrade site: task=' + vil.task + ' target=' + vil.buildTarget);
    // and it actually finishes into a complete stone wall
    step(BLDGS.SWALL.buildTime + 600);
    assert(wall.complete && wall.btype === 'SWALL' && !wall.upgrading, 'AI never finished the upgraded wall: complete=' + wall.complete);
  });

  T('farm: reseed prepay queues, and cancel refunds 60 wood (soldier-queue parity)', () => {
    stage();
    const store = resourceStore(0);
    store.wood = 1000; store.prepaidFarms = 0;
    execCommand({ kind: 'prepay-farm' }, 0);
    execCommand({ kind: 'prepay-farm' }, 0);
    assert(store.prepaidFarms === 2 && store.wood === 880, 'prepay ×2: ' + store.prepaidFarms + '/' + store.wood);
    execCommand({ kind: 'cancel-reseed' }, 0);
    assert(store.prepaidFarms === 1 && store.wood === 940, 'cancel refunds 60 wood: ' + store.prepaidFarms + '/' + store.wood);
    execCommand({ kind: 'cancel-reseed' }, 0);
    execCommand({ kind: 'cancel-reseed' }, 0); // empty queue → no-op, no over-refund
    assert(store.prepaidFarms === 0 && store.wood === 1000, 'cancel to empty is a no-op: ' + store.prepaidFarms + '/' + store.wood);
  });

  T('gate: upgrading a LOCKED gate to stone does NOT inherit the lock', () => {
    stage();
    const store = resourceStore(0); store.wood = 1000; store.stone = 1000;
    teamAge[0] = 1; // Feudal → stone unlocked
    const gate = createBuilding('GATE', 30, 30, 0);
    execCommand({ kind: 'gate-lock', bldgIds: [gate.id], locked: true }, 0);
    assert(gate.locked === true, 'setup: gate should be locked');
    execCommand({ kind: 'upgrade-walls', unitIds: [gate.id] }, 0);
    assert(gate.btype === 'SGATE', 'gate did not upgrade to stone: ' + gate.btype);
    assert(!gate.locked, 'upgraded gate wrongly inherited the lock');
    teamAge[0] = 0;
  });

  T('hud: home button icon reflects the age (TC top-half: dark/feudal/castle)', () => {
    stage();
    const homeCls = () => { updateUI(); const el = document.querySelector('#home-btn .sprite-icon'); return el ? el.className : ''; };
    teamAge[0] = 0; assert(/icon-home-dark/.test(homeCls()), 'Dark home icon: ' + homeCls());
    teamAge[0] = 1; assert(/icon-home-feudal/.test(homeCls()), 'Feudal home icon: ' + homeCls());
    teamAge[0] = 2; assert(/icon-home-castle/.test(homeCls()), 'Castle home icon: ' + homeCls());
    teamAge[0] = 0;
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

    await tapT('walk into UNEXPLORED territory KEEPS selection (even over a fogged resource — no task committed)', async () => {
      const pts = await page.evaluate(tapStage(`
        const v=createUnit('villager',30,30,0); selected=[v];
        window.fogDisabled=false;
        for(let y=0;y<MAP;y++)for(let x=0;x<MAP;x++){ if(fog[y]) fog[y][x]=2; }
        map[30][40].t=TERRAIN.FOREST; map[30][40].res=100; markMapDirty(40,30);
        fog[30][40]=0; // destination is unexplored
        window.__pts=(scr)=>({ g: scr(40.5,30.5) });`));
      await page.mouse.click(pts.g.x, pts.g.y);
      const r = await page.evaluate(`({sel:selected.length, marker:(cmdMarkers[cmdMarkers.length-1]||{}).color})`);
      assertEq(r.sel, 1, 'walking into the unknown keeps the selection');
      assertEq(r.marker, '#0f0', 'marker must be the GREEN walk color, not the yellow gather color, over unexplored terrain');
    });

    await tapT('build placement (no Shift) deselects the villager (build is a task)', async () => {
      const pts = await page.evaluate(tapStage(`
        const v=createUnit('villager',30,30,0); selected=[v]; placing='HOUSE';
        window.__pts=(scr)=>({ g: scr(34.5,34.5) });`));
      await page.mouse.click(pts.g.x, pts.g.y);
      const r = await page.evaluate(`({sel:selected.length, cmd:window.__cmds.find(c=>c.kind==='build-placement')||null})`);
      if (!r.cmd) throw new Error('no build-placement command issued');
      assertEq(r.sel, 0, 'placing a building deselects the villager');
    });

    await tapT('auto-scout button deselects the scout (auto-scout is a task)', async () => {
      await page.evaluate(tapStage(`
        const sc=createUnit('scout',30,30,0); selected=[sc]; window.__pts=()=>({});`));
      const r = await page.evaluate(`(()=>{ updateUI();
        const btn=[...document.querySelectorAll('#actions .act-btn')].find(b=>b.dataset.tipLabel==='Auto Scout');
        if(!btn) return {found:false};
        btn.click();
        return {found:true, sel:selected.length, cmd:window.__cmds.find(c=>c.kind==='auto-scout')||null}; })()`);
      if (!r.found) throw new Error('Auto Scout button not found');
      if (!r.cmd) throw new Error('no auto-scout command issued');
      assertEq(r.sel, 0, 'enabling auto-scout deselects the scout');
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

    await tapT('desktop-tap: RIGHT-click resource assign also RELEASES (same rules as left)', async () => {
      const pts = await page.evaluate(tapStage(`
        const v=createUnit('villager',30,30,0); selected=[v];
        map[30][33].t=TERRAIN.BERRIES; map[30][33].res=100; markMapDirty(33,30);
        window.__pts=(scr)=>({ b: scr(33.5, 30.5) });`));
      await page.mouse.click(pts.b.x, pts.b.y, { button: 'right' });
      const r = await page.evaluate(`({sel:selected.length, cmd:window.__cmds.find(c=>c.kind==='command')})`);
      if (!r.cmd) throw new Error('no command captured');
      assertEq(r.sel, 0, 'right-click gather order must RELEASE the selection on index.html');
    });

    // ---- Right-click to plant a Guard/Escort flag (index.html) ----
    // Right-clicking a friendly BUILDING guards it, a friendly UNIT escorts
    // it; GROUND/ENEMY stay a normal walk/attack; and a villager selection
    // never intercepts (repair-on-right-click is preserved). Building/unit
    // click points are self-calibrated against the real hit-tests so the
    // pixel geometry can't make the test flaky.
    await tapT('right-click own building = Guard flag (military selected, deselects after tasking)', async () => {
      const pts = await page.evaluate(tapStage(`
        const b=createBuilding('BARRACKS',29,29,0);
        const m=createUnit('militia',25,25,0); selected=[m];
        window.__pts=(scr)=>{ const base=scr(b.x+b.w/2,b.y+b.h/2); let pt=base;
          for(let dy=0;dy<=100;dy+=3){const c={x:base.x,y:base.y-dy}; if(getBuildingUnderCursor(c.x,c.y)===b){pt=c;break;}}
          return { p: pt, bId: b.id }; };`));
      await page.mouse.click(pts.p.x, pts.p.y, { button: 'right' });
      const r = await page.evaluate(`({g:window.__cmds.find(c=>c.kind==='guard')||null, other:window.__cmds.some(c=>c.kind==='command'), sel:selected.length})`);
      if (!r.g) throw new Error('no guard command issued for own-building right-click');
      assertEq(r.g.targetId, pts.bId, 'guard targetId = the building');
      if (r.other) throw new Error('should NOT also issue a normal command');
      assertEq(r.sel, 0, 'guard is a task → deselects');
    });

    await tapT('right-click friendly unit = Escort flag', async () => {
      const pts = await page.evaluate(tapStage(`
        const ally=createUnit('militia',30,30,0); const m=createUnit('militia',25,25,0); selected=[m];
        window.__pts=(scr)=>{ const base=scr(ally.x,ally.y); let pt={x:base.x,y:base.y-8};
          for(let dy=0;dy<=24;dy+=2){const c={x:base.x,y:base.y-dy}; if(getUnitUnderCursor(c.x,c.y)===ally){pt=c;break;}}
          return { p: pt, aId: ally.id }; };`));
      await page.mouse.click(pts.p.x, pts.p.y, { button: 'right' });
      const g = await page.evaluate(`window.__cmds.find(c=>c.kind==='guard')||null`);
      if (!g) throw new Error('no guard/escort command issued for friendly-unit right-click');
      assertEq(g.targetId, pts.aId, 'escort targetId = the friendly unit');
    });

    await tapT('right-click ground = normal walk (NOT a guard flag)', async () => {
      const pts = await page.evaluate(tapStage(`
        const m=createUnit('militia',30,30,0); selected=[m];
        window.__pts=(scr)=>({ g: scr(36.5, 30.5) });`));
      await page.mouse.click(pts.g.x, pts.g.y, { button: 'right' });
      const r = await page.evaluate(`({guard:window.__cmds.some(c=>c.kind==='guard'), cmd:window.__cmds.find(c=>c.kind==='command')||null})`);
      if (r.guard) throw new Error('ground right-click must NOT plant a guard flag');
      if (!r.cmd) throw new Error('ground right-click should issue a walk command');
      assertEq(r.cmd.tileX, 36, 'walk tileX');
    });

    await tapT('right-click enemy = normal attack (NOT a guard flag)', async () => {
      const pts = await page.evaluate(tapStage(`
        const foe=createUnit('militia',30,30,1); const m=createUnit('militia',25,25,0); selected=[m];
        window.__pts=(scr)=>{ const base=scr(foe.x,foe.y); let pt={x:base.x,y:base.y-8};
          for(let dy=0;dy<=24;dy+=2){const c={x:base.x,y:base.y-dy}; if(getUnitUnderCursor(c.x,c.y)===foe){pt=c;break;}}
          return { p: pt, fId: foe.id }; };`));
      await page.mouse.click(pts.p.x, pts.p.y, { button: 'right' });
      const r = await page.evaluate(`({guard:window.__cmds.some(c=>c.kind==='guard'), cmd:window.__cmds.find(c=>c.kind==='command')||null})`);
      if (r.guard) throw new Error('enemy right-click must NOT plant a guard flag');
      if (!r.cmd) throw new Error('enemy right-click should issue an attack command');
      assertEq(r.cmd.targetId, pts.fId, 'attack targetId = the enemy');
    });

    await tapT('right-click own building with VILLAGERS = repair, not guard (feature does not hijack villagers)', async () => {
      const pts = await page.evaluate(tapStage(`
        const b=createBuilding('BARRACKS',29,29,0); b.hp=Math.round(b.maxHp/2); // damaged → repairable
        const v=createUnit('villager',25,25,0); selected=[v];
        window.__pts=(scr)=>{ const base=scr(b.x+b.w/2,b.y+b.h/2); let pt=base;
          for(let dy=0;dy<=100;dy+=3){const c={x:base.x,y:base.y-dy}; if(getBuildingUnderCursor(c.x,c.y)===b){pt=c;break;}}
          return { p: pt, bId: b.id }; };`));
      await page.mouse.click(pts.p.x, pts.p.y, { button: 'right' });
      const r = await page.evaluate(`({guard:window.__cmds.some(c=>c.kind==='guard'), cmd:window.__cmds.find(c=>c.kind==='command')||null, sel:selected.length})`);
      if (r.guard) throw new Error('villager right-click must NOT plant a guard flag');
      if (!r.cmd) throw new Error('villager right-click on a damaged building should issue a repair command');
      assertEq(r.cmd.buildTargetId, pts.bId, 'repair buildTargetId = the building');
      assertEq(r.sel, 0, 'repair is a task → deselects');
    });

    await tapT('desktop-tap: advance-age button is display-only while researching (no tap-cancel)', async () => {
      await page.evaluate(tapStage(`
        const tc=entities.find(en=>en.btype==='TC'&&en.team===0)||createBuilding('TC',26,26,0);
        tc.research={target:1,tick:50};
        selected=[tc]; window.__pts=()=>({});`));
      const r = await page.evaluate(`(()=>{ updateUI();
        const btn=document.getElementById('advance-progress-btn');
        if(!btn) return {found:false};
        btn.click();
        return {found:true, cancel:window.__cmds.find(c=>c.kind==='cancel-research')||null,
                hasHandler:!!btn.onclick};
      })()`);
      if (!r.found) throw new Error('researching advance button not rendered');
      if (r.hasHandler || r.cancel) throw new Error('tap skin must not cancel research from the button: ' + JSON.stringify(r));
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

    await tapT('right-click a training building = set rally on index.html (building half of right-click-to-flag)', async () => {
      const pts = await page.evaluate(tapStage(`
        const bar=createBuilding('BARRACKS',26,26,0); bar.rallyX=40; bar.rallyY=12;
        selected=[bar]; window.pendingRallyPreview=null;
        window.__pts=(scr)=>({ g: scr(30.5,30.5) });`));
      await page.mouse.click(pts.g.x, pts.g.y, { button: 'right' });
      const r = await page.evaluate(`({rally:window.__cmds.find(c=>c.kind==='rally')||null, prev:window.pendingRallyPreview, sel:selected.length})`);
      if (!r.rally) throw new Error('right-click on a training building should issue a rally command');
      assertEq(r.rally.tileX, 30, 'rally tileX'); assertEq(r.rally.tileY, 30, 'rally tileY');
      if (!r.prev || r.prev.x !== 30) throw new Error('rally preview should appear at the clicked tile');
      assertEq(r.sel, 1, 'building stays selected after setting its rally');
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

    await tapT('classic: right-click move KEEPS the selection (AoE2-sticky, no deselect)', async () => {
      const cpage = await ctx.newPage();
      await cpage.goto(base + '/classic.html', { waitUntil: 'load' });
      await cpage.waitForFunction(() => {
        const b = document.getElementById('start-game-btn');
        return b && !b.disabled;
      }, { timeout: 15000 });
      const pts = await cpage.evaluate(tapStage(`
        const m=createUnit('militia',30,30,0); selected=[m];
        window.__pts=(scr)=>({ g: scr(35.5, 30.5) });`));
      await cpage.mouse.click(pts.g.x, pts.g.y, { button: 'right' });
      const r = await cpage.evaluate(`({sel:selected.length, cmd:window.__cmds.find(c=>c.kind==='command')||null})`);
      if (!r.cmd) throw new Error('classic right-click should issue a move command');
      assertEq(r.sel, 1, 'classic keeps the unit selected after an order (AoE2-sticky, unlike index)');
      await cpage.close();
    });

    await tapT('classic: Guard button + click guards a building and KEEPS selection (shared guard, sticky)', async () => {
      const cpage = await ctx.newPage();
      await cpage.goto(base + '/classic.html', { waitUntil: 'load' });
      await cpage.waitForFunction(() => {
        const b = document.getElementById('start-game-btn');
        return b && !b.disabled;
      }, { timeout: 15000 });
      const pts = await cpage.evaluate(tapStage(`
        const b=createBuilding('BARRACKS',29,29,0);
        const m=createUnit('militia',25,25,0); selected=[m];
        window.settingGuard=true; // shared Guard button armed
        window.__pts=(scr)=>{ const base=scr(b.x+b.w/2,b.y+b.h/2); let pt=base;
          for(let dy=0;dy<=100;dy+=3){const c={x:base.x,y:base.y-dy}; if(getBuildingUnderCursor(c.x,c.y)===b){pt=c;break;}}
          return { p: pt, bId: b.id }; };`));
      await cpage.mouse.click(pts.p.x, pts.p.y); // LEFT-click drops the armed guard flag on classic
      const r = await cpage.evaluate(`({g:window.__cmds.find(c=>c.kind==='guard')||null, sel:selected.length})`);
      if (!r.g) throw new Error('classic Guard button + click should issue a guard command');
      assertEq(r.g.targetId, pts.bId, 'guard targetId = the building');
      assertEq(r.sel, 1, 'classic keeps the unit selected after guarding (sticky)');
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

    await tapT('classic: prepaid reseeds are cancellable queue slots (parity) + reseed button keeps its border', async () => {
      const cpage = await ctx.newPage();
      await cpage.goto(base + '/classic.html', { waitUntil: 'load' });
      await cpage.waitForFunction(() => {
        const b = document.getElementById('start-game-btn');
        return b && !b.disabled;
      }, { timeout: 15000 });
      await cpage.evaluate(tapStage(`
        const mill=createBuilding('MILL',26,26,0); mill.complete=true;
        resourceStore(0).prepaidFarms=3;
        selected=[mill]; window.__pts=()=>({});`));
      const r = await cpage.evaluate(`(()=>{ updateUI();
        const slots=[...document.querySelectorAll('#sel-queue .queue-slot')];
        const reseed=slots.filter(s=>s.querySelector('.icon-reseed')).length;
        const clickable=!!(slots[0]&&slots[0].onclick);
        if(slots[0]) slots[0].click();
        const cancel=window.__cmds.find(c=>c.kind==='cancel-reseed');
        const prepay=[...document.querySelectorAll('#actions .act-btn')].find(b=>b.dataset.tipLabel==='Prepay Farm Reseed');
        return { count:slots.length, reseed, clickable, cancel: !!cancel, prepayFramed: prepay?prepay.classList.contains('framed'):'no-btn' };
      })()`);
      assertEq(r.count, 3, 'three reseed queue slots');
      assertEq(r.reseed, 3, 'every slot shows the reseed icon');
      if (!r.clickable) throw new Error('reseed slots must be clickable');
      if (!r.cancel) throw new Error('clicking a reseed slot must issue cancel-reseed');
      if (r.prepayFramed !== false) throw new Error('Prepay Reseed button must NOT be .framed (needs its own border): ' + r.prepayFramed);
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
