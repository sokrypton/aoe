#!/usr/bin/env node
// ---- Sim behavior tests (Playwright driver) ----
// Fast, targeted PASS/FAIL assertions on GAME MECHANICS, driven headlessly on
// tools/sim.html (and index.html where the real menu flow matters). Covers:
//   1. ram garrison   — riders board/eject/survive, capacity, the REAL
//                       right-click command shape, loaded-ram speed
//   2. forward-building defense — AI attacks an enemy tower in its town
//   3. walled-archer  — a self-acquired unreachable shooter is disengaged
//                       from, not soaked (fixture: scenarios/walled-archer.savegame.json)
//   4. save v5        — RLE map + derived occupied + explored grids + TPS stamp
//                       round-trip checksum-exact; fog-off saves omit grids
//   5. fog option     — All-Visible matches skip the vision grids, AI intel
//                       goes omniscient, the SP menu radio drives the flag
//   6. large-army move — one group order, everyone arrives (movement/
//                       collision/formation regression, ex repro-largearmy)
//   7. walled-TC assault — select-all attack on a sealed TC: the WHOLE army
//                       engages and breaches (ex repro-attack-subset /
//                       repro-unreachable, now asserted)
//
// Complements tools/hud-tests.js (commands + DOM), tools/simulate.sh
// (whole-match health/determinism) and tools/mp-tests.js (live lockstep).
//
//   node tools/behavior-tests.js         # run everything, exit 1 on any FAIL
//   node tools/behavior-tests.js grep=ram  # only sections whose name matches

const fs = require('fs');
const path = require('path');
const { ROOT, requireChromium, parseArgs, startServer, launchBrowser } = require('./lib/harness');
const chromium = requireChromium();

const results = [];
function report(section, r){
  r.pass.forEach(p => { console.log(`PASS  [${section}] ${p}`); results.push(true); });
  r.fail.forEach(f => { console.log(`FAIL  [${section}] ${f}`); results.push(false); });
}

// Every section gets a fresh page on the given entry point. The in-page
// helpers (ok/silence) are injected so section bodies stay assertion-only.
async function withPage(browser, port, entry, fn){
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}${entry}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof update === 'function');
  await page.evaluate(() => {
    window.playSound = () => {}; window.showMsg = () => {}; window.updateUI = window.updateUI || (() => {});
    window.__T = { pass: [], fail: [], ok(n, c){ (c ? this.pass : this.fail).push(n); } };
  });
  const r = await fn(page);
  await page.close();
  return r;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const only = args.grep || null;
  const srv = await startServer('/tools/sim.html');
  const port = srv.address().port;
  const browser = await launchBrowser(chromium, args.headed === '1');

  const sections = {

    // ------------------------------------------------ rollback block-grid sync
    // unitBlock is a derived per-tick pathfinding grid, NOT part of the snapshot.
    // A rollback/resync restore must rebuild it from the restored entities, else
    // a command on the first replayed tick (runScheduledCommands, before
    // update()'s own rebuild) pathfinds against the abandoned-future grid and
    // desyncs. AI self-play can't catch this (updateAI pathfinds AFTER the
    // rebuild), so it's asserted here against the real lockstepRestore path.
    'rollback-block-grid': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 11, numTeams: 2, controllers: ['human', 'ai:hard'], ages: [0, 0],
        resources: [{ f: 200, w: 200, g: 100, s: 200 }, { f: 200, w: 200, g: 100, s: 200 }],
        entities: [{ b: 'TC', x: 6, y: 6, team: 0 }, { b: 'TC', x: 40, y: 40, team: 1 }],
      });
      const eqGrid = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      createUnit('villager', 14, 20, 0);
      const blockers = [];
      for (let y = 17; y <= 23; y++) blockers.push(createUnit('villager', 20, y, 0));
      update(); // stamp the stationary blockers into unitBlock
      const snap = { t: tick, state: lockstepCaptureState() };
      const gridSnap = Int32Array.from(unitBlock); // correct grid for the snapshot world
      // Advance the world so the live grid diverges from the snapshot's.
      for (const b of blockers) b.x = 30;
      update(); // rebuilds unitBlock with the blockers now at x=30
      T.ok('setup: live grid diverged from snapshot', !eqGrid(unitBlock, gridSnap) && gridSnap.some(v => v !== 0));
      lockstepRestore(snap);
      T.ok('rollback restore rebuilds unitBlock to match restored world', eqGrid(unitBlock, gridSnap));
      return T;
    })),

    // --------------------------------------------- honor-system seat reclaim
    // The host offers an unknown-identity mid-match/save-load joiner the list of
    // reclaimable (disconnected, human, not-kicked) seats and binds their claim
    // (js/net.js reclaimableSeats / hostHandleClaimSeat). Driven directly on the
    // host decision logic with stub connections (the live multi-tab path is
    // tools/mp-tests.js).
    'seat-reclaim': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      netRole = 'host';
      mpMatchStarted = false;               // skip persistMpSessionMap (needs a live peer)
      window.onNetConnectionOpen = () => {}; // skip the heavy resume-state send
      teamControllers = [{ type: 'human' }, { type: 'human' }, { type: 'ai' }, { type: 'human' }];
      teamNames = ['Host', 'Red', 'CPU', 'Blue'];
      const stubConn = () => ({ send() {}, close() {}, on() {} });
      netGuests.clear();
      netGuests.set(1, { conn: null, seat: 1, token: 't1', tab: null, name: 'Red', connected: false, kicked: false, lastRecvAt: 0 });
      netGuests.set(2, { conn: null, seat: 2, token: 't2', tab: null, name: 'CPU', connected: false, kicked: false, lastRecvAt: 0 }); // AI seat
      netGuests.set(3, { conn: stubConn(), seat: 3, token: 't3', tab: null, name: 'Blue', connected: true, kicked: false, lastRecvAt: 0 });

      const list = reclaimableSeats();
      T.ok('offers only disconnected human seats', list.length === 1 && list[0].seat === 1 && list[0].name === 'Red');

      const conn = stubConn();
      hostHandleClaimSeat({ type: 'claim-seat', seat: 1, token: 'newdevice', tab: 'tabX', name: 'Red' }, conn);
      const r1 = netGuests.get(1);
      T.ok('claim binds the seat and rebinds the device token', r1.connected === true && r1.conn === conn && r1.token === 'newdevice');
      T.ok('claimed seat drops off the reclaimable list', reclaimableSeats().every(s => s.seat !== 1));

      hostHandleClaimSeat({ type: 'claim-seat', seat: 1, token: 'other', tab: null, name: 'x' }, stubConn());
      T.ok('a second claim cannot steal a taken seat', netGuests.get(1).conn === conn && netGuests.get(1).token === 'newdevice');

      hostHandleClaimSeat({ type: 'claim-seat', seat: 2, token: 'z', tab: null, name: 'z' }, stubConn());
      T.ok('an AI seat cannot be claimed', netGuests.get(2).connected === false && netGuests.get(2).conn === null);
      return T;
    })),

    // ------------------------------------------------ character mode
    // With the town on autopilot, a player-steered unit (possess) is never
    // dispatched by the AI; release hands it back; a save load clears it.
    'character-mode': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      window.__pendingMatchSeed = 21;
      setMapSize('small');
      restartGame('hard');
      gameStarted = true; gamePaused = true;
      const vils = entities.filter(e => e.team === 0 && e.utype === 'villager').sort((a, b) => a.id - b.id);
      const steered = vils[0];
      execCommand({ kind: 'autopilot', on: true }, 0);
      execCommand({ kind: 'possess', unitId: steered.id, on: true }, 0);
      T.ok('autopilot hands the seat to the AI', teamControllers[0].type === 'ai');
      for (let i = 0; i < 1500; i++) update();
      T.ok('the AI is dispatching the other villagers', vils.slice(1).some(v => v.task || v.buildTarget != null));
      T.ok('the steered villager was left alone', steered.possessed && !steered.task && steered.target == null);
      execCommand({ kind: 'possess', unitId: vils[1].id, on: true }, 0);
      T.ok('one steered unit per team', !steered.possessed && vils[1].possessed);
      execCommand({ kind: 'possess', unitId: vils[1].id, on: false }, 0);
      for (let i = 0; i < 1500; i++) update();
      T.ok('released, the AI takes it back', !!steered.task);
      execCommand({ kind: 'possess', unitId: steered.id, on: true }, 0);
      applySavedGame(serializeGameForWire());
      T.ok('a save load clears steering', entities.every(e => !e.possessed));
      T.ok('autopilot marks a person present', seatHasPerson(0) && teamControllers[0].autopilot === true);
      execCommand({ kind: 'autopilot', on: false }, 0);
      T.ok('autopilot off returns the seat', teamControllers[0].type === 'human' && seatHasPerson(0));
      // Kicking a player hands the seat to the AI and frees their steered unit.
      const v1 = entities.find(e => e.team === 1 && e.type === 'unit');
      execCommand({ kind: 'possess', unitId: v1.id, on: true }, 1);
      execCommand({ kind: 'set-controller', t: 1, diff: 'hard' }, 0);
      T.ok('a kick releases the steered unit', !v1.possessed && teamControllers[1].type === 'ai' && !seatHasPerson(1));
      return T;
    })),

    // ------------------------------------------------ free rescue villager
    // Anti-softlock: the first villager queued while a team has 0 living
    // villagers is FREE (unitTrainCost, js/logic.js) — reachable at 0 food, one
    // at a time, and cancelling it refunds nothing (no resource mint).
    'free-villager': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'medium', seed: 3, numTeams: 2, controllers: ['human', 'ai'], ages: [0, 0], entities: [] });
      gameStarted = true; window.__headlessSim = true;
      const tc0 = createBuilding('TC', 15, 15, 0);
      const s0 = resourceStore(0); s0.food = 0; s0.wood = 0; s0.gold = 0; s0.stone = 0;
      T.ok('rescue villager is free at 0 food / 0 villagers', queueUnit(tc0, 'villager').ok === true && s0.food === 0);
      T.ok('only one free — second villager needs resources', queueUnit(tc0, 'villager').reason === 'resources');
      // Give food, queue a paid 2nd, then cancel the FREE first — refund must be 0.
      s0.food = 50;
      queueUnit(tc0, 'villager'); // paid, food -> 0
      const foodBeforeCancel = s0.food;
      execCancelQueue(tc0.id, 0, 0); // cancel the free one (idx 0)
      T.ok('cancelling the free villager refunds nothing (no mint)', s0.food === foodBeforeCancel);
      // A team that still has a villager pays full price.
      const tc1 = createBuilding('TC', 40, 40, 1);
      createUnit('villager', 41, 41, 1);
      resourceStore(1).food = 0;
      T.ok('no free villager while one is still alive', queueUnit(tc1, 'villager').reason === 'resources');
      // Losing the TC with the free villager still queued must not mint food.
      const tc2 = createBuilding('TC', 20, 20, 0);
      s0.food = 0;
      queueUnit(tc2, 'villager'); // free (team 0 still has 0 living villagers)
      tc2.hp = 1;
      damageEntity({ atk: 9999, team: 1, range: 0, type: 'unit', utype: 'militia', id: 77777, x: tc2.x, y: tc2.y }, tc2);
      T.ok('losing the TC with a free villager queued mints nothing', tc2.hp <= 0 && s0.food === 0);
      // ONE free villager per team: a second TC doesn't get its own (that pair could mint food via a cancel).
      const tc3 = createBuilding('TC', 30, 15, 0), tc4 = createBuilding('TC', 30, 30, 0);
      tc0.queue = []; tc0.freeVillagerQueued = false; s0.food = 0;
      T.ok('first TC: free', queueUnit(tc3, 'villager').ok === true);
      T.ok('second TC: not free while one is queued', queueUnit(tc4, 'villager').reason === 'resources');
      // A PAID villager keeps its price even if every villager dies before the cancel (the refund was re-derived).
      tc3.queue = []; tc3.freeVillagerQueued = false;
      const v = createUnit('villager', 31, 31, 0);
      s0.food = 50; queueUnit(tc3, 'villager');          // paid: a villager is alive
      v.hp = 0; handleDeath(v, 1);                        // …then the last villager dies
      execCancelQueue(tc3.id, 0, 0);
      T.ok('cancelling a paid villager refunds 50 food after the villagers died (' + s0.food + ')', s0.food === 50);
      return T;
    })),

    // ---------------------------------------------- town bell: nobody stays
    // Reported: "when I hit the bell some villagers stay to fight". A TC holds
    // 15 and a tower 5, so the overflow hit `if(!best) return` and carried on
    // doing whatever it was doing — including fighting.
    'bell-overflow': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map:'medium', seed:8, numTeams:2, controllers:['human','ai'], ages:[1,1], entities:[] });
      gameStarted = true; window.__headlessSim = true;
      const tc = createBuilding('TC', 30, 30, 0); tc.complete = true;
      const cap = garrisonCap(tc);
      const foe = createUnit('militia', 33, 33, 1);
      const vils = [];
      for (let i = 0; i < cap + 6; i++) {            // MORE villagers than slots
        const v = createUnit('villager', 28 + (i % 6), 28 + ((i / 6) | 0), 0);
        if (v) { v.target = foe.id; vils.push(v); }  // every one of them is fighting
      }
      T.ok('staged more villagers than the TC can hold', vils.length > cap);
      ringTownBell(0);
      const fighting = vils.filter(v => v.target != null);
      const running  = vils.filter(v => v.task === 'garrison');
      T.ok('NO villager is still fighting after the bell', fighting.length === 0);
      T.ok('every villager is running for cover, not just the first ' + cap,
           running.length === vils.length);
      // out-of-range villagers are still exempt (AoE2 bell range)
      const far = createUnit('villager', 30, 30 + 40, 0);
      if (far) { far.target = foe.id; ringTownBell(0);
        T.ok('a villager beyond the bell range is left working (AoE2 range rule)',
             far.task !== 'garrison'); }
      return T;
    })),

    // ---------------------------------------------- human clocks are unscaled
    // aiTimeMult must never touch a HUMAN team, and the research progress bar
    // must finish at exactly the tick the research applies (reported: "the
    // upgrade is applied faster than the progress bar").
    'human-clocks': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map:'medium', seed:7, numTeams:2, controllers:['human','ai'], ages:[1,1], entities:[] });
      gameStarted = true; window.__headlessSim = true;
      T.ok('human team has aiTimeMult 1', aiTimeMult(0) === 1);
      T.ok('AI team is scaled', aiTimeMult(1) > 1);
      // a human research must run exactly the authored ticks...
      T.ok('human research duration is unscaled',
           researchDurationFor(0,'forging') === UPGRADES.forging.researchTicks);
      T.ok('AI research duration IS scaled',
           researchDurationFor(1,'forging') > UPGRADES.forging.researchTicks);
      // ...and human unit training too
      const tc0 = createBuilding('TC', 30, 30, 0); tc0.complete = true;   // pop space, or queueUnit refuses
      const b = createBuilding('BARRACKS', 20, 20, 0); b.complete = true;
      resourceStore(0).food = 9999; resourceStore(0).gold = 9999; resourceStore(0).wood = 9999;
      queueUnit(b, 'militia');
      let ticks = 0; const before = entities.filter(e => e.utype === 'militia' && e.team === 0).length;
      while (ticks < UNITS.militia.trainTime * 3 &&
             entities.filter(e => e.utype === 'militia' && e.team === 0).length === before) {
        updateBuildingTraining(b); ticks++;
      }
      T.ok('a human militia trains in exactly its authored time',
           ticks === UNITS.militia.trainTime, 'took ' + ticks + ' vs ' + UNITS.militia.trainTime);
      // bar vs completion: the fill must read 100% on the tick it applies
      tc0.research = { target: 'forging', tick: 0 };
      const dur = researchDurationFor(0, 'forging');
      let t2 = 0;
      while (tc0.research && t2 < dur * 3) { updateBuildingResearch(tc0); t2++; }
      T.ok('research applies on exactly the bar\'s final tick', t2 === dur, 'applied at ' + t2 + ', bar length ' + dur);
      // AI training: the progress bars read trainDurationFor, so a scaled
      // (slower) AI unit's bar never overshoots and fills on its spawn tick.
      createBuilding('TC', 60, 60, 1).complete = true;
      const b1 = createBuilding('BARRACKS', 50, 50, 1); b1.complete = true;
      resourceStore(1).food = 9999; resourceStore(1).gold = 9999; resourceStore(1).wood = 9999;
      queueUnit(b1, 'militia');
      const n1 = entities.filter(e => e.utype === 'militia' && e.team === 1).length, len = trainDurationFor(1, 'militia');
      let t3 = 0, maxFill = 0;
      while (t3 < len * 3 && entities.filter(e => e.utype === 'militia' && e.team === 1).length === n1) {
        updateBuildingTraining(b1); t3++;
        if (b1.queue.length) maxFill = Math.max(maxFill, b1.trainTick / trainDurationFor(1, b1.queue[0]));
      }
      T.ok('an AI unit spawns on exactly its bar\'s final tick', t3 === len, 'spawned at ' + t3 + ', bar length ' + len);
      T.ok('an AI training bar never runs past full', maxFill <= 1, 'peaked at ' + maxFill);
      return T;
    })),

    // ---------------------------------------------- age-scaled building HP
    // AoE2 buildings gain HP each age (House 550/750/900, Barracks
    // 1200/1500/1800). Ours were flat at the Dark-Age figure forever.
    'building-hp-by-age': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map:'medium', seed:6, numTeams:2, controllers:['human','ai'], ages:[0,0], entities:[] });
      gameStarted = true; window.__headlessSim = true;
      teamAge[0] = 0;
      const h = createBuilding('HOUSE', 20, 20, 0); h.complete = true;
      const b = createBuilding('BARRACKS', 24, 20, 0); b.complete = true;
      const tc = createBuilding('TC', 30, 30, 0); tc.complete = true;
      T.ok('Dark Age house is 550', h.maxHp === 550);
      T.ok('Dark Age barracks is 1200', b.maxHp === 1200);
      // half-wreck the barracks, then advance — damage must stay proportional
      b.hp = b.maxHp / 2;
      teamAge[0] = 1; rescaleTeamBuildingHp(0);
      T.ok('Feudal house rises to 750', h.maxHp === 750);
      T.ok('Feudal barracks rises to 1500', b.maxHp === 1500);
      T.ok('an UNDAMAGED building is topped up exactly', h.hp === 750);
      T.ok('a half-wrecked building stays half-wrecked', b.hp === 750);
      T.ok('the Town Centre does NOT scale (flat in DE)', tc.maxHp === 2400);
      teamAge[0] = 2; rescaleTeamBuildingHp(0);
      T.ok('Castle house rises to 900', h.maxHp === 900);
      T.ok('Castle barracks rises to 1800', b.maxHp === 1800);
      // a building founded later starts at the current age's ceiling
      const h2 = createBuilding('HOUSE', 26, 26, 0);
      T.ok('a house built IN Castle starts at 900', h2.maxHp === 900);
      return T;
    })),

    // ---------------------------------------------- attack-line split (DE)
    // DE's Forging/Iron Casting are infantry+cavalry only; archers have their
    // own line (Fletching -> Bodkin Arrow). Ours gave archers BOTH, so they
    // double-dipped the melee cards.
    'attack-lines': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map:'medium', seed:4, numTeams:2, controllers:['human','ai'], ages:[2,2], entities:[] });
      gameStarted = true; window.__headlessSim = true;
      const mk = t => ({ mil: createUnit('militia',20,20,t), arc: createUnit('archer',22,20,t) });
      const base = mk(0);
      const baseMilAtk = base.mil.atk, baseArcAtk = base.arc.atk, baseArcRange = base.arc.range;
      const give = k => { teamTechs[0] |= (1 << UPGRADE_BITS[k]); UPGRADES[k].apply && UPGRADES[k].apply(0); };
      give('forging');
      T.ok('Forging gives MELEE +1 attack', base.mil.atk === baseMilAtk + 1);
      T.ok('Forging does NOT touch archers (DE: infantry+cavalry only)', base.arc.atk === baseArcAtk);
      give('iron_casting');
      T.ok('Iron Casting is melee-only too', base.mil.atk === baseMilAtk + 2 && base.arc.atk === baseArcAtk);
      give('fletching');
      T.ok('Fletching gives archers +1 attack AND +1 range',
           base.arc.atk === baseArcAtk + 1 && base.arc.range === baseArcRange + 1);
      give('bodkin_arrow');
      T.ok('Bodkin Arrow adds the second archer step',
           base.arc.atk === baseArcAtk + 2 && base.arc.range === baseArcRange + 2);
      T.ok('archer and melee attack lines end level (+2 each)',
           (base.arc.atk - baseArcAtk) === (base.mil.atk - baseMilAtk));
      T.ok('Bodkin needs Fletching first', TECH_PREREQ.bodkin_arrow === 'fletching');
      return T;
    })),

    // ---------------------------------------------- wall ring vs buildings
    // Placement only asked canPlace, so a house could land ON a planned ring
    // tile after the ring was planned; the wall loop then marked it done
    // ("already our building") and the perimeter got a 550hp house where a
    // 1800hp wall belonged.
    'ring-not-houses': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map:'medium', seed:3, numTeams:2, controllers:['ai','ai'], ages:[1,1], entities:[] });
      gameStarted = true; window.__headlessSim = true; window.fogDisabled = true; updateFog();
      const tc = createBuilding('TC', 30, 30, 0);
      const ai = AI_STATES[0];
      ai.wallPlan = computeAIWallRing(ai, tc, 6);
      const onRing = ai.wallPlan[0];
      T.ok('a plan exists to test against', !!onRing);
      // a HOUSE may not be sited on a ring tile...
      T.ok('house placement is refused on the wall ring',
           aiOnWallRing(ai, onRing.x, onRing.y, 1, 1, 'HOUSE') === true);
      // ...but the ring pieces themselves are exempt
      T.ok('walls/gates/towers are exempt (they ARE the ring)',
           aiOnWallRing(ai, onRing.x, onRing.y, 1, 1, 'WALL') === false &&
           aiOnWallRing(ai, onRing.x, onRing.y, 1, 1, 'TOWER') === false);
      // a tile well inside the ring is fine
      T.ok('inside the ring is still buildable', aiOnWallRing(ai, 30, 30, 1, 1, 'HOUSE') === false);
      return T;
    })),

    // ---------------------------------------------- scoutless base survey
    // ai.baseSurveyed only advanced inside controlAIScouts' per-scout loop, so
    // an AI whose scout died early never completed the lap — and planAIWalls
    // blocks on it, meaning that AI silently never walled again for the whole
    // match. Scoutless AIs now fall back to testing whether the ring band is
    // explored (which is what the lap establishes).
    'scoutless-survey': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'medium', seed: 9, numTeams: 2,
                     controllers: ['ai', 'ai'], ages: [1, 1], entities: [] });
      gameStarted = true; window.__headlessSim = true;
      const tc = createBuilding('TC', 30, 30, 0);
      const ai = AI_STATES[0];
      ai.baseSurveyed = false; ai.surveyIdx = 0;
      // Fog OFF makes every tile count as explored, so the ring band reads as
      // surveyed — the same state a real base's own vision reaches.
      window.fogDisabled = true;
      controlAIScouts(ai, [], tc);                       // no scouts at all
      T.ok('scoutless AI with an explored ring band completes the survey',
           ai.baseSurveyed === true);
      // With the band genuinely unknown it must NOT claim to be surveyed.
      const ai2 = AI_STATES[1];
      const tc2 = createBuilding('TC', 70, 70, 1);
      ai2.baseSurveyed = false; ai2.surveyIdx = 0;
      window.fogDisabled = false;
      if (typeof teamExploredGrid !== 'undefined' && teamExploredGrid && teamExploredGrid[1])
        teamExploredGrid[1].fill(0);
      controlAIScouts(ai2, [], tc2);
      T.ok('unexplored ring band does NOT count as surveyed', ai2.baseSurveyed === false);
      window.fogDisabled = true;
      return T;
    })),

    // ---------------------------------------------- ally market / trade route
    // An AI that stalls below its maxAge used to never build a Market, so it
    // never traded — and in a team game that left its ALLY (often the human)
    // with no trade partner either. A standing ally Market is now its own
    // trigger. The Castle-age gate must still hold when there's no partner.
    'ally-market': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      const stage = (withAllyMarket) => {
        loadScenario({ map: 'medium', seed: 5, numTeams: 4,
                       controllers: ['ai', 'ai', 'ai', 'ai'], ages: [1, 1, 1, 1], entities: [] });
        gameStarted = true; window.__headlessSim = true;
        teamAlliance = [0, 0, 1, 1];              // 0+1 allied vs 2+3
        teamAge[0] = 1; teamAge[1] = 1;           // Feudal: Market unlocked, below maxAge (2)
        const tc0 = createBuilding('TC', 20, 20, 0);
        const tc1 = createBuilding('TC', 44, 44, 1);
        if (withAllyMarket) { const m = createBuilding('MARKET', 24, 20, 0); m.complete = true; }
        // Team 1: plenty of villagers + resources, deliberately NO army, so the
        // only thing that can gate it is the tech/army rule under test.
        const vils = [];
        for (let i = 0; i < 12; i++) vils.push(createUnit('villager', 42 + (i % 4), 42 + ((i / 4) | 0), 1));
        const r = resourceStore(1);
        r.food = 500; r.wood = 600; r.gold = 400; r.stone = 200;   // not starving -> emergency path off
        const ai = AI_STATES[1];
        const profile = AI_LEVELS[(teamControllers[1] && teamControllers[1].difficulty) || 'easy'];
        planAIMarket(ai, tc1, vils.filter(Boolean), profile);
        return !!aiOwnMarket(1);
      };
      T.ok('ally Market standing -> a Feudal AI builds its own (trade route opens)', stage(true) === true);
      T.ok('no ally Market -> the Castle-age gate still holds', stage(false) === false);
      return T;
    })),

    // ---------------------------------------------- garrison: foot units only (AoE2)
    // A Town Center / tower takes villagers, infantry and archers — never
    // cavalry. The rule is canGarrisonIn's, so every boarding path (button,
    // bell, AI shelter, rally) shares it.
    'garrison-foot-only': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'medium', seed: 5, numTeams: 2, controllers: ['human', 'human'], ages: [2, 2], entities: [] });
      gameStarted = true; window.__headlessSim = true;
      const tc = createBuilding('TC', 20, 20, 0); tc.complete = true;
      const tw = createBuilding('TOWER', 30, 20, 0); tw.complete = true;
      for (const [ut, ok] of [['villager', true], ['militia', true], ['archer', true], ['knight', false], ['scout', false]])
        for (const b of [tc, tw]) T.ok(`${ut} ${ok ? 'may' : 'may not'} garrison in a ${b.btype}`, canGarrisonIn(b, 0, createUnit(ut, 25, 25, 0)) === ok);
      return T;
    })),

    // ---------------------------------------------- logic review 2026-10-04
    // Archer range techs reach combat (not just the acquire scan) and reach archers trained after them; buildings
    // shelter foot units only; a carcass on a foundation doesn't hold its construction forever.
    'logic-review': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      const stage = () => { loadScenario({ map: 'medium', seed: 5, numTeams: 2, controllers: ['human', 'human'], ages: [2, 2], entities: [] });
        gameStarted = true; window.__headlessSim = true; };
      stage();
      applyTech(0, 'fletching'); applyTech(0, 'bodkin_arrow');
      const a = createUnit('archer', 20, 20, 0), foe = createUnit('militia', 25.5, 20, 1);
      T.ok('an archer trained after Fletching + Bodkin has range 6', a.range === 6);
      T.ok('…and can strike a foe 5.5 tiles off', inWeaponRange(a, foe));
      stage();
      const tc = createBuilding('TC', 20, 20, 0); tc.complete = true;
      for (const [ut, ok] of [['militia', true], ['villager', true], ['ram', false], ['tradecart', false], ['scout', false]])
        T.ok(`a ${ut} ${ok ? 'may' : 'may not'} garrison in a TC`, canGarrisonIn(tc, 0, createUnit(ut, 26, 26, 0)) === ok);
      stage();
      const h = createBuilding('HOUSE', 30, 30, 0); h.complete = false; h.buildProgress = 0;
      const c = createUnit('sheep_carcass', 30, 30, GAIA_TEAM);
      T.ok('a carcass on a foundation does not hold its construction', !footprintOccupiedByOther(h));
      const v = createUnit('villager', 29, 30, 0); v.task = 'build'; v.buildTarget = h.id;
      for (let i = 0; i < 120; i++) update();
      const inside = Math.round(c.x) >= h.x && Math.round(c.x) < h.x + h.w && Math.round(c.y) >= h.y && Math.round(c.y) < h.y + h.h;
      T.ok('…the site goes up and the carcass is set down outside it, not walled in', h.buildProgress > 0 && !inside && c.hp > 0);
      stage();
      const m = createUnit('militia', 40, 40, 0), far = createUnit('militia', 60, 40, 1), stab = createUnit('militia', 41, 40, 1);
      m.target = far.id; stampUnreachable(m, far.id, UNREACH_UNIT_TICKS);
      damageEntity(stab, m);
      T.ok('a unit waiting out an unreachable target fights back at one stabbing it', m.target === stab.id);
      const m2 = createUnit('militia', 44, 44, 0), far2 = createUnit('militia', 47, 44, 1), stab2 = createUnit('militia', 45, 44, 1);
      m2.target = far2.id; damageEntity(stab2, m2);
      T.ok('…while one on a reachable target keeps it (no AoE2 target-hopping)', m2.target === far2.id);
      return T;
    })),

    // ---------------------------------------------- build-over parity
    // A stone tower placed on its wooden counterpart IS the upgrade, for the AI exactly as for a player (both go
    // through placeBuilding): never two buildings on one tile.
    'build-over-parity': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      const stage = (complete) => {
        loadScenario({ map: 'medium', seed: 5, numTeams: 2, controllers: ['ai', 'ai'], ages: [1, 1], entities: [] });
        gameStarted = true; window.__headlessSim = true;
        for (let i = 0; i < teamExploredGrid[0].length; i++) teamExploredGrid[0][i] = 1;
        const st = resourceStore(0); st.wood = 1000; st.stone = 1000;
        const pt = createBuilding('PTOWER', 30, 20, 0); pt.complete = complete; if (complete) pt.hp = pt.maxHp;
        const got = placeAIBuilding(AI_STATES[0], 'TOWER', 30, 20);
        const here = entities.filter(e => e.type === 'building' && e.x === 30 && e.y === 20);
        return { got: !!got, n: here.length, btype: here[0] && here[0].btype, complete: here[0] && here[0].complete, sameId: here[0] && here[0].id === pt.id };
      };
      const a = stage(true);
      T.ok('AI tower over a finished PTOWER: one building, upgraded in place', a.got && a.n === 1 && a.btype === 'TOWER' && !a.complete && a.sameId);
      const b = stage(false);
      T.ok('AI tower over an unbuilt PTOWER: the foundation is replaced, not stacked', b.got && b.n === 1 && b.btype === 'TOWER' && !b.sameId);
      return T;
    })),

    // ---------------------------------------------- sheep donation (AoE2)
    // A sheep goes to another player's unit that reaches it first — an ALLY's
    // too (donating a sheep). Against an ally only the owner's own units guard
    // it; against an enemy the owner's allies guard as well.
    'sheep-donation': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      const stage = (units) => {
        loadScenario({ map: 'medium', seed: 5, numTeams: 3, controllers: ['ai', 'ai', 'ai'], ages: [0, 0, 0], entities: [] });
        gameStarted = true; window.__headlessSim = true;
        teamAlliance = [0, 0, 1];                 // 0+1 allied vs 2
        for (const tm of [0, 1, 2]) teamControllers[tm] = { type: 'human' };   // (no AI moving them)
        const sh = createUnit('sheep', 30, 30, 0); sh.speed = 0;
        for (const [tm, x, y] of units) { const u = createUnit('villager', x, y, tm); u.speed = 0; }
        for (let i = 0; i < 9; i++) update();
        return sh.team;
      };
      T.ok('an ally reaching it alone takes the sheep (donated)', stage([[1, 32, 30]]) === 1);
      T.ok('the owner nearer than the ally keeps it', stage([[1, 33, 30], [0, 31, 30]]) === 0);
      T.ok('an enemy loses it to an ally standing nearer (the ally takes it, not the enemy)', stage([[2, 33, 30], [1, 31, 30]]) === 1);
      T.ok('an enemy is held off by the owner and an ally both nearer', stage([[2, 34, 30], [0, 31, 30], [1, 32, 30]]) === 0);
      T.ok('an enemy alone takes it', stage([[2, 32, 30]]) === 2);
      return T;
    })),

    // ---------------------------------------------- checksum-coverage guard
    // detEntityHash coverage is hand-maintained; an unhashed sim-read field is
    // an invisible desync. detEntityCoverageGaps flags any entity key that is
    // neither hashed nor allow-listed (js/determinism.js). Run a real war so
    // combat/eco/AI/lifecycle fields all appear, then assert no gaps — a new
    // field forces a classify-it-here decision instead of a mystery desync.
    // (Played through runSimulation — a bare update() loop never started the match and checked nothing.)
    'checksum-coverage': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(async () => {
      const T = window.__T;
      let gaps = new Set(), real = window.update, ticks = 0;
      window.update = function(){ real.apply(this, arguments); if (++ticks % 120 === 0) for (const g of detEntityCoverageGaps()) gaps.add(g); };
      try { await runSimulation({ mode: '1v1', diff: 'hard', map: 'medium', seed: 7100, ticks: 30000 }); }
      finally { window.update = real; }
      for (const g of detEntityCoverageGaps()) gaps.add(g);
      T.ok('the coverage run actually played (' + ticks + ' ticks)', ticks >= 29000);
      T.ok('all sim-read entity fields hashed or allow-listed'
        + (gaps.size ? ' — UNCLASSIFIED: ' + Array.from(gaps).sort().join(', ') : ''), gaps.size === 0);
      return T;
    })),

    // ---------------------------------------------------------- ram garrison
    'ram-garrison': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [2, 2],
        resources: [{ f: 500, w: 500, g: 500, s: 500 }, { f: 500, w: 500, g: 500, s: 500 }],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { u: 'ram', x: 16, y: 16, team: 0 },
          { u: 'militia', x: 14, y: 16, team: 0 },
          { u: 'spearman', x: 15, y: 14, team: 0 },
          { u: 'archer', x: 17, y: 14, team: 0 },
          { u: 'villager', x: 10, y: 10, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
        ],
      });
      const byType = (t, ut) => entities.find(e => e.team === t && e.utype === ut);
      const ram = byType(0, 'ram'), mil = byType(0, 'militia'), spear = byType(0, 'spearman'),
            arch = byType(0, 'archer'), vil = byType(0, 'villager');

      // eligibility
      T.ok('canGarrisonIn(ram, militia)', canGarrisonIn(ram, 0, mil) === true);
      T.ok('archer/villager rejected', !canGarrisonIn(ram, 0, arch) && !canGarrisonIn(ram, 0, vil));
      T.ok('cap = 4', garrisonCap(ram) === 4);

      // boarding walk; the archer's walk must self-cancel (walker re-validation)
      for (const u of [mil, spear]) { u.task = 'garrison'; u.garrisonTarget = ram.id; }
      arch.task = 'garrison'; arch.garrisonTarget = ram.id;
      for (let i = 0; i < 300 && !(mil.garrisonedIn && spear.garrisonedIn); i++) update();
      T.ok('infantry boarded (2 seated)', garrisonCount(ram) === 2 && mil.garrisonedIn === ram.id);
      T.ok('archer walk cancelled', arch.garrisonedIn == null && arch.task !== 'garrison');

      // loaded speed + riders track the moving ram (1-tick sync lag allowed)
      T.ok('loaded ram speed boosted', unitMoveSpeed(ram) > UNITS.ram.speed + 0.05);
      T.ok('ram ignores groupSpeed', (ram.groupSpeed = 0.4, unitMoveSpeed(ram) > UNITS.ram.speed + 0.05));
      ram.groupSpeed = undefined;
      pathUnitTo(ram, 26, 16);
      for (let i = 0; i < 400 && ram.path.length; i++) update();
      T.ok('riders track ram', Math.abs(mil.x - ram.x) < 0.5 && Math.abs(mil.y - ram.y) < 0.5);

      // town bell never shelters villagers in a ram
      ringTownBell(0);
      T.ok('bell ignores ram as shelter', vil.garrisonTarget !== ram.id);
      soundAllClear(0);

      // riders survive the wreck
      ram.hp = 1;
      damageEntity({ atk: 50, team: 1, range: 0, type: 'unit', utype: 'militia', id: 99999, x: ram.x, y: ram.y }, ram);
      T.ok('riders alive + free after wreck', mil.hp > 0 && spear.hp > 0 && mil.garrisonedIn == null);

      // the REAL command shape (input.js ships an own-ram click as targetId +
      // followId): riders board to capacity, surplus + non-riders escort.
      const ram2 = createUnit('ram', 20, 20, 0);
      const crew = [];
      for (let i = 0; i < 5; i++) crew.push(createUnit('militia', 22 + (i % 3), 20 + Math.floor(i / 3), 0));
      const bowman = createUnit('archer', 22, 22, 0);
      selected = [...crew, bowman];
      execUnitCommand({ targetId: ram2.id, followId: ram2.id, tileX: 20, tileY: 20 });
      const boarding = crew.filter(c => c.task === 'garrison' && c.garrisonTarget === ram2.id);
      T.ok('cmd: boards to capacity (4/5)', boarding.length === 4);
      T.ok('cmd: surplus rider escorts', crew.filter(c => c.order && c.order.kind === 'follow' && c.order.id === ram2.id).length === 1);
      T.ok('cmd: archer follows, never boards', bowman.order && bowman.order.kind === 'follow' && bowman.order.id === ram2.id && bowman.task !== 'garrison');
      for (let i = 0; i < 400 && boarding.some(c => !c.garrisonedIn); i++) update();
      T.ok('cmd: all 4 seated', garrisonCount(ram2) === 4);
      selected = [];
      return T;
    })),

    // Click-to-board a ram is DISABLED — the only way to board is the ram's
    // Garrison button (load mode, see garrison-loadmode). A right-click/tap on a
    // ram must NOT issue a garrison command; a tap just re-selects the ram (so
    // its Garrison button shows), and the guard/escort shortcut is off.
    'ram-input': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      window.fogDisabled = true; myTeam = 0;
      const scrOf = (u) => {
        const iso = toIso(u.x, u.y), { ox, oy } = getUnitGroupOffset(u.id);
        return { sx: (iso.ix - camX + ox) * ZOOM + W / 2, sy: (iso.iy - camY + HALF_TH + oy) * ZOOM + H / 2 + topH };
      };
      const setup = (n) => {
        entities.length = 0; entitiesById.clear(); selected.length = 0;
        const ram = createUnit('ram', 40, 40, 0), crew = [];
        for (let i = 0; i < n; i++) crew.push(createUnit('militia', 42 + (i % 3), 42 + ((i / 3) | 0), 0));
        const iso = toIso(ram.x, ram.y); camX = iso.ix; camY = iso.iy; ZOOM = 2;
        selected = [...crew];
        return { ram, crew };
      };
      const capture = (fn) => {
        const orig = window.submitCommand; let cmd = null;
        window.submitCommand = (c) => { cmd = c; };
        try { fn(); } finally { window.submitCommand = orig; }
        return cmd;
      };

      // RIGHT-CLICK a ram: guard/escort shortcut off, doCommand does NOT board.
      { const { ram, crew } = setup(2); const { sx, sy } = scrOf(ram);
        T.ok('rightclick: guard/escort shortcut disabled', tryRightClickGuard(sx, sy) === false);
        const cmd = capture(() => doCommand(sx, sy));
        T.ok('rightclick: no garrison command', !cmd || cmd.kind !== 'garrison');
        T.ok('rightclick: crew not tasked to board', crew.every(c => c.task !== 'garrison')); }

      // TAP a ram: re-selects it (so its Garrison button appears), no board.
      { const { ram, crew } = setup(2); const { sx, sy } = scrOf(ram);
        const cmd = capture(() => handleTap(sx, sy));
        T.ok('tap: no garrison command', !cmd || cmd.kind !== 'garrison');
        T.ok('tap: re-selects the ram', selected.length === 1 && selected[0] === ram);
        T.ok('tap: crew not tasked to board', crew.every(c => c.task !== 'garrison')); }

      selected = [];
      return T;
    })),

    // ------------------------------------------- garrison INTO a TC/tower/ram
    // The 'garrison' command (container-first load mode): soldiers/villagers seat
    // into a building, riders into a ram, capacity is reserved, invalid targets
    // no-op. Drives the REAL execCommand (not raw field pokes).
    'garrison-command': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      window.fogDisabled = true; myTeam = 0; localHumanTeam = 0;
      gameStarted = true; gamePaused = false; // else update() no-ops unit movement
      const mkBldg = (bt, x, y) => { let b = createBuilding(bt, x, y, 0); b.complete = true; b.hp = b.maxHp; return b; };
      const reset = () => { entities.length = 0; entitiesById.clear(); selected.length = 0; };
      const seatLoop = () => { for (let i = 0; i < 400 && entities.some(e => e.task === 'garrison'); i++) update(); };

      // 1. Soldiers AND a villager seat into a forced tower (any unit into a building).
      { reset();
        const tower = mkBldg('TOWER', 30, 30);
        const crew = [createUnit('militia', 33, 30, 0), createUnit('militia', 33, 31, 0), createUnit('villager', 34, 30, 0)];
        execCommand({ kind: 'garrison', unitIds: crew.map(u => u.id), bldgId: tower.id }, 0);
        T.ok('cmd: crew tasked to tower', crew.every(u => u.task === 'garrison' && u.garrisonTarget === tower.id));
        seatLoop();
        T.ok('cmd: all 3 seated (soldiers + villager)', garrisonCount(tower) === 3 && crew.every(u => u.garrisonedIn === tower.id)); }

      // 2. Ram: rider (militia) tasked, non-rider (archer) rejected by canGarrisonIn.
      { reset();
        const ram = createUnit('ram', 30, 30, 0);
        const mil = createUnit('militia', 32, 30, 0), arc = createUnit('archer', 32, 31, 0);
        execCommand({ kind: 'garrison', unitIds: [mil.id, arc.id], bldgId: ram.id }, 0);
        T.ok('ram: rider tasked, archer rejected', mil.task === 'garrison' && arc.task !== 'garrison'); }

      // 3. Reservation: tower (cap 5) pre-filled to 4 → only 1 of 3 more boards.
      { reset();
        const tower = mkBldg('TOWER', 30, 30);
        tower.garrison = [];
        for (let i = 0; i < 4; i++) { let u = createUnit('militia', 35 + i, 35, 0); u.garrisonedIn = tower.id; tower.garrison.push(u.id); }
        const extra = [createUnit('militia', 33, 30, 0), createUnit('militia', 33, 31, 0), createUnit('militia', 33, 32, 0)];
        execCommand({ kind: 'garrison', unitIds: extra.map(u => u.id), bldgId: tower.id }, 0);
        T.ok('reservation: only 1 of 3 boards (cap-1 free)', extra.filter(u => u.task === 'garrison').length === 1); }

      // 4. Invalid bldgId → no-op (re-validation drop).
      { reset();
        const mil = createUnit('militia', 30, 30, 0);
        execCommand({ kind: 'garrison', unitIds: [mil.id], bldgId: 99999 }, 0);
        T.ok('invalid target: no-op', mil.task !== 'garrison'); }

      // 5. Ungarrison ALL (the garrison-out button): eject-garrison {all:true}
      //    releases everyone inside at once.
      { reset();
        const ram = createUnit('ram', 30, 30, 0); ram.garrison = [];
        const riders = [];
        for (let i = 0; i < 3; i++) { let u = createUnit('militia', 35 + i, 35, 0); u.garrisonedIn = ram.id; ram.garrison.push(u.id); riders.push(u); }
        execCommand({ kind: 'eject-garrison', bldgId: ram.id, all: true }, 0);
        T.ok('eject-all: ram emptied, riders freed', garrisonCount(ram) === 0 && riders.every(u => u.garrisonedIn == null)); }

      selected = [];
      return T;
    })),

    // ------------------------------------------- garrison load-mode dispatch
    // The REAL persistent handler garrisonLoadTap (not just the command): a tap
    // on a unit emits the garrison command and STAYS armed; a tap on empty
    // ground ends the mode. Entry-point coverage (cf. the ram-boarding lesson).
    'garrison-loadmode': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      window.fogDisabled = true; myTeam = 0;
      window.updateUI = () => {}; window.showMsg = () => {};
      entities.length = 0; entitiesById.clear(); selected.length = 0;
      const tower = createBuilding('TOWER', 30, 30, 0); tower.complete = true; tower.hp = tower.maxHp;
      const mil = createUnit('militia', 33, 30, 0);
      const iso = toIso(mil.x, mil.y); camX = iso.ix; camY = iso.iy; ZOOM = 2;
      const scr = (u) => { const i = toIso(u.x, u.y), { ox, oy } = getUnitGroupOffset(u.id); return { sx: (i.ix - camX + ox) * ZOOM + W / 2, sy: (i.iy - camY + HALF_TH + oy) * ZOOM + H / 2 + topH }; };

      window.settingGarrison = tower.id;
      let cap = null; const orig = window.submitCommand; window.submitCommand = (c) => { cap = c; };
      const s = scr(mil);
      try { garrisonLoadTap(s.sx, s.sy); } finally { window.submitCommand = orig; }
      T.ok('loadmode: unit tap emits garrison cmd', !!cap && cap.kind === 'garrison' && cap.bldgId === tower.id && cap.unitIds[0] === mil.id);
      T.ok('loadmode: stays armed after unit tap', window.settingGarrison === tower.id);

      window.submitCommand = () => {};
      garrisonLoadTap(4, 4); // top-left, no unit under cursor
      window.submitCommand = orig;
      T.ok('loadmode: empty-ground tap ends mode', window.settingGarrison == null);

      selected = [];
      return T;
    })),

    // ------------------------------------------- anti-forward-building defense
    'forward-building': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
          { u: 'militia', x: 46, y: 46, team: 1 }, { u: 'militia', x: 47, y: 46, team: 1 },
          { u: 'militia', x: 46, y: 47, team: 1 }, { u: 'spearman', x: 47, y: 47, team: 1 },
          { b: 'PTOWER', x: 40, y: 40, team: 0 }, // enemy tower inside team1's town radius
        ],
      });
      const tower = entities.find(e => e.btype === 'PTOWER' && e.team === 0);
      const hp0 = tower.hp;
      for (let i = 0; i < 2400 && tower.hp > 0; i++) update();
      T.ok(`AI razes/pressures the forward tower (hp ${hp0} -> ${Math.max(0, tower.hp)})`,
           tower.hp <= 0 || tower.hp < hp0 - 100);
      return T;
    })),

    // ------------------------------------- foundation build gate (no trap)
    // AoE2: a foundation is walkable until work starts, and construction can't
    // begin until the footprint is clear — so the tiles never harden under a
    // unit and seal it in. Your OWN units scatter off the site when a builder
    // commits; an ENEMY on it can't be shoved, so it just blocks the build.
    'build-gate': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'small', seed: 3, numTeams: 2, controllers: ['human', 'human'],
        ages: [4, 4], entities: [{ b: 'TC', x: 8, y: 8, team: 0 }, { b: 'TC', x: 44, y: 44, team: 1 }] });
      const inFP = (u, bx, by) => { let x = Math.round(u.x), y = Math.round(u.y);
        return x >= bx && x < bx + 3 && y >= by && y < by + 3; };

      // (1) An OWN idle villager parked inside is auto-cleared; the site builds
      //     itself and nobody is sealed in.
      const bar = createBuilding('BARRACKS', 20, 20, 0); // 3x3 -> tiles 20..22
      bar.complete = false; bar.buildProgress = 0; bar.hp = 1;
      const builder = createUnit('villager', 19, 20, 0); // west edge, OFF the footprint
      builder.task = 'build'; builder.buildTarget = bar.id;
      const mine = createUnit('villager', 21, 21, 0); // own idle unit parked INSIDE
      for (let i = 0; i < bar.buildTime + T30(600) && !bar.complete; i++) update();
      T.ok('own unit is auto-cleared and the site finishes on its own', bar.complete);
      T.ok('the cleared unit walked OUT (not teleported, not sealed)', mine.hp > 0 && !inFP(mine, 20, 20));

      // (2) An ENEMY unit parked inside is NOT shoved — it blocks construction.
      const bar2 = createBuilding('BARRACKS', 30, 30, 0);
      bar2.complete = false; bar2.buildProgress = 0; bar2.hp = 1;
      const b2 = createUnit('villager', 29, 30, 0); b2.task = 'build'; b2.buildTarget = bar2.id;
      // A non-threatening enemy (villager) — the builder won't flee it, it just
      // can't shove it, so the site is blocked. (An enemy SOLDIER would trigger
      // flee instead, which is a separate, correct behavior.)
      const foe = createUnit('villager', 31, 31, 1); // enemy parked INSIDE (team 1)
      for (let i = 0; i < T30(240) + 60; i++) update(); // PAST the 8s stuck-watchdog window
      T.ok('an enemy on the footprint blocks construction (no progress)', bar2.buildProgress === 0 && !bar2.complete);
      T.ok('the enemy is NOT teleported away', inFP(foe, 30, 30));
      T.ok('a lone blocked site: the builder WAITS (not abandoned by the watchdog)', b2.task === 'build' && b2.buildTarget === bar2.id);

      // (3) With more work queued, a blocked site is skipped for the next one,
      //     then circled back to once it clears.
      loadScenario({ map: 'small', seed: 3, numTeams: 2, controllers: ['human', 'human'],
        ages: [4, 4], entities: [{ b: 'TC', x: 8, y: 8, team: 0 }, { b: 'TC', x: 44, y: 44, team: 1 }] });
      const h1 = createBuilding('HOUSE', 20, 20, 0); h1.complete = false; h1.buildProgress = 0; h1.hp = 1; // 1x1
      const h2 = createBuilding('HOUSE', 24, 20, 0); h2.complete = false; h2.buildProgress = 0; h2.hp = 1;
      const vb = createUnit('villager', 19, 20, 0); vb.task = 'build'; vb.buildTarget = h1.id; vb.buildQueue = [h1.id, h2.id];
      const camper = createUnit('villager', 20, 20, 1); // enemy on h1's tile — blocks it
      for (let i = 0; i < h2.buildTime + T30(600) && !h2.complete; i++) update();
      T.ok('blocked site is skipped: builder finishes the next queued building', h2.complete);
      T.ok('the blocked site stays unbuilt and still queued', !h1.complete && vb.buildQueue.includes(h1.id));
      camper.x = camper.fromX = camper.lastX = 40; camper.y = camper.fromY = camper.lastY = 40; camper.path = [];
      for (let i = 0; i < h1.buildTime + T30(1200) && !h1.complete; i++) update();
      T.ok('builder circles back and finishes the once-blocked site', h1.complete);
      return T;
    })),

    // ------------------------------------- editor: no build on occupied tile
    // The editor drops an instantly-SOLID building, so it must refuse an
    // occupied tile (canPlace rejectUnits) — no shove/teleport, the author
    // clears the unit first. Gameplay leaves rejectUnits false: building over
    // your own units is fine (foundation walkable + build-gate).
    'editor-reject-occupied': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'human'],
        ages: [4, 4], entities: [{ b: 'TC', x: 8, y: 8, team: 0 }, { b: 'TC', x: 44, y: 44, team: 1 }] });
      createUnit('villager', 20.4, 20.4, 0); // sits on tile 20,20 of a 3x3 footprint at (20,20)
      T.ok('editor (rejectUnits) refuses a footprint with a unit on it',
        canPlace('BARRACKS', 20, 20, 0, true, true) === false);
      T.ok('editor allows the SAME spot once no unit is on it',
        canPlace('BARRACKS', 30, 30, 0, true, true) === true);
      T.ok('gameplay (rejectUnits off) still allows building over your own unit',
        canPlace('BARRACKS', 20, 20, 0, false, false) === true);
      return T;
    })),

    // ------------------------------------- AoE2 army-size attack trigger
    // Launches are army-size driven: a group of profile.attackSize (hard: 5)
    // launches once attackTick passes; one soldier fewer holds. The old
    // eco-scaled hold (aiWaveSize ≈ 14) + 8-unit stalemate valve locked a
    // raided AI out of ever counter-attacking (under-attack doctrine).
    // Zero resources = no training, so the staged group size IS the test.
    'attack-trigger': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      const stage = (n) => {
        loadScenario({
          map: 'small', seed: 11, numTeams: 2, controllers: ['human', 'ai:hard'],
          ages: [1, 1],
          entities: [
            { b: 'TC', x: 8, y: 8, team: 0 },
            { b: 'TC', x: 44, y: 44, team: 1 },
            ...Array.from({ length: n }, (_, i) => ({ u: 'militia', x: 40 + (i % 3), y: 40 + Math.floor(i / 3), team: 1 })),
          ],
        });
        resources[1] = { food: 0, wood: 0, gold: 0, stone: 0, prepaidFarms: 0 };
      };
      const horizon = T30(3600) + T30(600); // hard attackTick + a couple of decision intervals
      stage(5); // == attackSize
      let launched = false;
      for (let i = 0; i < horizon && !launched; i++) { update(); launched = (AI_STATES[1].waveCount || 0) > 0; }
      T.ok('attackSize soldiers: wave launches after attackTick', launched);
      stage(4); // one below the minimum group
      for (let i = 0; i < horizon; i++) update();
      T.ok('attackSize-1 soldiers: launch holds', (AI_STATES[1].waveCount || 0) === 0);
      return T;
    })),

    // ------------------------------------------ soldier garrison (doctrine)
    // Outmatched home defenders SHELTER in the TC (AoE2 sn-number-garrison-
    // units) instead of standing to die piecemeal, then eject on all-clear.
    'soldier-garrison': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 12, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
          // Militia AT the TC doorstep (one-tile garrison walk) so the shelter
          // decision beats the knights' charge — the contract under test is
          // the decision, not a footrace.
          { u: 'militia', x: 43, y: 43, team: 1 }, { u: 'militia', x: 44, y: 43, team: 1 },
          { u: 'militia', x: 43, y: 44, team: 1 },
          // Overwhelming raid parked west of the TC: nearest knight (35,46) is
          // 11 tiles from the TC CENTER (46,46) — inside the 12-tile threat
          // scan (findEnemyThreatNear) — but 8.5+ from the militia at (43,43),
          // outside BOTH sides' 8-tile auto-acquire, so the shelter decision
          // runs before any melee starts. 6 knights ≈ 900 power vs 3 militia
          // ≈ 180 — far over the 1.6x shelter bar.
          ...Array.from({ length: 6 }, (_, i) => ({ u: 'knight', x: 33 + (i % 3), y: 45 + Math.floor(i / 3), team: 0 })),
        ],
      });
      resources[1] = { food: 0, wood: 0, gold: 0, stone: 0, prepaidFarms: 0 };
      const mine = () => entities.filter(e => e.team === 1 && e.utype === 'militia' && e.hp > 0);
      let sheltered = 0;
      for (let i = 0; i < T30(1200) && sheltered < 2; i++) {
        update();
        sheltered = mine().filter(m => m.garrisonedIn != null).length;
      }
      T.ok(`outmatched defenders garrison the TC (${sheltered}/3 sheltered, ${mine().length} alive)`, sheltered >= 2);
      // Raid ends: knights die → all-clear window passes → recall ejects.
      entities.forEach(e => { if (e.team === 0 && e.utype === 'knight') e.hp = 0; });
      let out = false;
      for (let i = 0; i < T30(1200) && !out; i++) {
        update();
        out = mine().length > 0 && mine().every(m => m.garrisonedIn == null && m.task !== 'garrison');
      }
      T.ok('all-clear: sheltered soldiers eject and survive', out);
      return T;
    })),

    // ---------------------------------------- counter-raid targeting
    // Waves hunt the enemy ECONOMY: spotted villagers outrank the TC in
    // chooseAIAttackTarget (raid economics milestone — seed-2001's waves
    // sieged the TC past raidable villagers and killed zero all game).
    'counter-raid': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 14, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
          // Enemy villagers in the open, nearer the AI than the enemy TC.
          { u: 'villager', x: 26, y: 26, team: 0 }, { u: 'villager', x: 27, y: 26, team: 0 },
          { u: 'villager', x: 26, y: 27, team: 0 },
          ...Array.from({ length: 5 }, (_, i) => ({ u: 'militia', x: 40 + (i % 3), y: 40 + Math.floor(i / 3), team: 1 })),
        ],
      });
      window.fogDisabled = true; // All-Visible: targeting is deterministic at launch (every read short-circuits)
      resources[1] = { food: 0, wood: 0, gold: 0, stone: 0, prepaidFarms: 0 };
      const tc0 = entities.find(e => e.btype === 'TC' && e.team === 0);
      const vilsAlive = () => entities.filter(e => e.team === 0 && e.utype === 'villager' && e.hp > 0).length;
      let killed = false;
      for (let i = 0; i < T30(6000) && !killed; i++) { update(); killed = vilsAlive() < 3; }
      T.ok('wave hunts enemy villagers (kills at least one)', killed);
      T.ok(`enemy TC not the raid's first meal (hp ${tc0.hp}/${tc0.maxHp})`, tc0.hp > tc0.maxHp * 0.9);
      return T;
    })),

    // ---------------------------------------- raid danger memory
    // An AI villager killed by an enemy stamps a bearless danger zone;
    // canGatherTile refuses tiles near it; the zone SURVIVES a bear-maul
    // prune (the old bear-only predicate wiped raid zones — regression).
    'raid-memory': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 15, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
          { u: 'villager', x: 30, y: 30, team: 1 },  // the victim, in the field
          { u: 'knight', x: 31, y: 30, team: 0 },    // the raider, adjacent
          { u: 'villager', x: 50, y: 50, team: 1 },  // bear bait (prune trigger)
          { u: 'bear', x: 51, y: 50, team: 255 },
        ],
      });
      const victim = entities.find(e => e.team === 1 && e.utype === 'villager' && e.x === 30);
      const zones = () => (AI_STATES[1].dangerZones || []).filter(z => z.bearId == null);
      // HIT-stamped (not death-stamped): the zone must exist while the
      // victim still lives — the first victim no longer dies "for free".
      for (let i = 0; i < T30(1200) && !zones().length && victim.hp > 0; i++) update();
      T.ok('FIRST hit stamps a bearless raid zone (victim still alive)', zones().length >= 1 && victim.hp > 0);
      T.ok('zone sits at the villager tile', zones().some(z => Math.abs(z.x - 30) <= 2 && Math.abs(z.y - 30) <= 2));
      // Field-hit flee is event-driven: same hit dropped its task and sent
      // it walking home (the villager is ~22 tiles from its TC, beyond the
      // 18-tile alarm radius — bell can't cover it).
      T.ok('field-hit villager flees (task dropped, walking)', victim.task == null && victim.path.length > 0);
      const probe = { team: 1, x: 30, y: 30 };
      T.ok('canGatherTile rejects tiles inside the zone', !canGatherTile(probe, TERRAIN.FOREST, 30, 30));
      // Let the bear maul the bait — the prune inside that stamp must KEEP
      // the bearless raid zone (the old predicate required a live bear).
      for (let i = 0; i < T30(1200) && zones().length && !AI_STATES[1].dangerZones.some(z => z.bearId != null); i++) update();
      T.ok('raid zone survives a bear-maul prune', zones().length >= 1);
      const z = zones()[0];
      z.until = tick; // force expiry
      // Also clear the war-state: the villager's death set a core hit, and
      // the gather CONTRACTION (separate mechanism) would keep rejecting
      // this far-from-TC tile even with the zone expired.
      lastTeamHit[1] = null; AI_STATES[1].lastBaseHitTick = null;
      T.ok('expired zone frees the tile', canGatherTile(probe, TERRAIN.FOREST, z.x, z.y));
      return T;
    })),

    // ---------------------------------------- war-state gather contraction
    // While the base takes core hits, gather tiles beyond the alarm radius
    // of the TC are rejected (sn-minimum-town-size spirit); the contraction
    // lifts once the war-state decays.
    'gather-contraction': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 16, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'TC', x: 30, y: 30, team: 1 },
        ],
      });
      const probe = { team: 1, x: 32, y: 32 };
      const R = AI_BASE_ALARM_RADIUS * aiScale();
      const farX = 32 + Math.ceil(R) + 8, nearX = 34;
      AI_STATES[1].lastBaseHitTick = tick; // war-state on
      T.ok('war-state: far tile rejected', !canGatherTile(probe, TERRAIN.FOREST, farX, 32));
      T.ok('war-state: tile inside the umbrella accepted', canGatherTile(probe, TERRAIN.FOREST, nearX, 32));
      AI_STATES[1].lastBaseHitTick = tick - T30(3600) - 1; // war-state decayed
      lastTeamHit[1] = null;
      T.ok('peace: far tile accepted again', canGatherTile(probe, TERRAIN.FOREST, farX, 32));
      return T;
    })),

    // ------------------------------------- bell task-resume (regression)
    // A bell cycle must not cost a villager its assignment: stashVillagerTask
    // at the ring, restoreSavedTask after the all-clear (farms included).
    'bell-task-resume': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 13, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
          { b: 'FARM', x: 41, y: 44, team: 1 },
          { u: 'villager', x: 41, y: 45, team: 1 },
        ],
      });
      const v = entities.find(e => e.team === 1 && e.utype === 'villager');
      const farm = entities.find(e => e.team === 1 && e.btype === 'FARM');
      v.task = 'farm'; v.gatherX = farm.x; v.gatherY = farm.y;
      // Simulate an ongoing base raid: keep the core-hit stamp fresh so
      // updateAIGarrisonReaction holds the bell (a bare ringTownBell would be
      // all-cleared by the AI's own reaction machinery the very next tick).
      ringTownBell(1);
      let inTC = false;
      for (let i = 0; i < T30(900) && !inTC; i++) {
        AI_STATES[1].lastBaseHitTick = tick;
        update();
        inTC = v.garrisonedIn != null;
      }
      T.ok('bell: farmer shelters in the TC', inTC);
      // Raid ends: stop stamping — the AI's own all-clear fires after the
      // hold window and restoreSavedTask resumes the farm assignment.
      let resumed = false;
      for (let i = 0; i < T30(1200) && !resumed; i++) {
        update();
        resumed = v.garrisonedIn == null && v.task === 'farm' && v.gatherX === farm.x && v.gatherY === farm.y;
      }
      T.ok('all-clear: farmer resumes the SAME farm (stash/restore)', resumed);
      return T;
    })),

    // ---------------------------------- bell butcher-resume (regression)
    // The sheep line rides TARGET with no task — the stash must carry it
    // too, or a bell cycle left released villagers idle by their carcass.
    'bell-butcher-resume': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 14, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
          { u: 'sheep_carcass', x: 41, y: 45, team: 1 },
          { u: 'villager', x: 41, y: 44, team: 1 },
        ],
      });
      const v = entities.find(e => e.team === 1 && e.utype === 'villager');
      const car = entities.find(e => e.utype === 'sheep_carcass');
      v.target = car.id; // butchering = target-with-no-task (the sheep line)
      ringTownBell(1);
      let inTC = false;
      for (let i = 0; i < T30(900) && !inTC; i++) {
        AI_STATES[1].lastBaseHitTick = tick;
        update();
        inTC = v.garrisonedIn != null;
      }
      T.ok('bell: butcher shelters in the TC', inTC);
      let resumed = false;
      for (let i = 0; i < T30(1200) && !resumed; i++) {
        update();
        resumed = v.garrisonedIn == null && v.target === car.id;
      }
      T.ok('all-clear: butcher resumes the SAME carcass (stash/restore)', resumed);
      return T;
    })),

    // -------------------------------------------- explicit farm reseed (wood)
    // Sending a villager to an exhausted farm pays wood directly (like fixing
    // a building), bypassing the Mill prepaid queue. The AUTOMATIC paths must
    // NOT spend a human's wood without prepaid credit.
    'farm-explicit-reseed': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      const setup = () => {
        loadScenario({
          map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
          ages: [1, 1],
          entities: [
            { b: 'TC', x: 8, y: 8, team: 0 },
            { b: 'FARM', x: 11, y: 9, team: 0 },
            { u: 'villager', x: 13, y: 9, team: 0 },
            { b: 'TC', x: 44, y: 44, team: 1 },
          ],
        });
        const farm = entities.find(e => e.team === 0 && e.btype === 'FARM');
        const v = entities.find(e => e.team === 0 && e.utype === 'villager');
        // Reproduce a real exhaustion (see updateBuilding): food depleted,
        // marked incomplete, tile drained — hp stays at maxHp.
        farm.exhausted = true; farm.complete = false; farm.buildProgress = 0;
        map[farm.y][farm.x].res = 0;
        resources[0].wood = 100; resources[0].prepaidFarms = 0;
        return { farm, v };
      };

      // (1) Explicit send → reseeds by spending 60 wood, then works the plot.
      let { farm, v } = setup();
      v.task = 'build'; v.buildTarget = farm.id; v.explicitReseed = true;
      pathToBuilding(v, farm);
      let done = false;
      for (let i = 0; i < T30(1200) && !done; i++) { update(); done = !farm.exhausted; }
      T.ok('explicit send reseeds the exhausted farm', !farm.exhausted);
      T.ok('explicit reseed spent exactly 60 wood', resources[0].wood === 40);
      T.ok('flag cleared after reseed', !v.explicitReseed);
      T.ok('farmer works the reseeded plot', v.task === 'farm');

      // (2) Automatic continuity (no flag, no prepaid) → NO silent wood spend.
      ({ farm, v } = setup());
      v.task = 'build'; v.buildTarget = farm.id; // no explicitReseed
      pathToBuilding(v, farm);
      for (let i = 0; i < T30(600); i++) update();
      T.ok('auto path does NOT spend a human\'s wood without prepaid', resources[0].wood === 100);
      T.ok('farm stays exhausted until reseeded deliberately', farm.exhausted);
      return T;
    })),

    // ------------------------------------------------------ farmers per farm
    // A farm takes FARM_MAX_FARMERS; a third villager sent to a full farm farms the next free plot. Real command shape.
    'farm-max-farmers': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'FARM', x: 13, y: 9, team: 0 },
          { b: 'FARM', x: 13, y: 12, team: 0 },
          { u: 'villager', x: 16, y: 9, team: 0 },
          { u: 'villager', x: 16, y: 10, team: 0 },
          { u: 'villager', x: 16, y: 11, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
        ],
      });
      const farms = entities.filter(e => e.team === 0 && e.btype === 'FARM');
      const vils = entities.filter(e => e.team === 0 && e.utype === 'villager');
      selected = vils;
      execUnitCommand({ tileX: farms[0].x, tileY: farms[0].y });
      for (let i = 0; i < T30(900); i++) update();
      const on = f => vils.filter(v => (v.task === 'farm' || v.prevTask === 'farm') && farmAtTile(v.gatherX, v.gatherY, 0, false) === f).length;
      T.ok('no farm over ' + FARM_MAX_FARMERS + ' farmers (' + on(farms[0]) + '+' + on(farms[1]) + ')', on(farms[0]) <= FARM_MAX_FARMERS && on(farms[1]) <= FARM_MAX_FARMERS);
      T.ok('all three villagers farm', on(farms[0]) + on(farms[1]) === 3);
      T.ok('farmers bring food home', resources[0].food > 0 || vils.some(v => v.carrying > 0));

      // One farm, three villagers: two farm it, the third walks there idle, stays selected, and the player is told.
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'FARM', x: 13, y: 9, team: 0 },
          { u: 'villager', x: 16, y: 9, team: 0 },
          { u: 'villager', x: 16, y: 10, team: 0 },
          { u: 'villager', x: 16, y: 11, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
        ],
      });
      const farm1 = entities.find(e => e.team === 0 && e.btype === 'FARM');
      const vils1 = entities.filter(e => e.team === 0 && e.utype === 'villager');
      const msgs = [], showMsg0 = window.showMsg;
      window.showMsg = m => msgs.push(m);
      selected = vils1;
      // the tap's shape: a healthy farm resolves as a dispatch buildTarget (input.js doCommand)
      execUnitCommand({ tileX: farm1.x, tileY: farm1.y, buildTargetId: farm1.id });
      window.showMsg = showMsg0;
      const tasked = vils1.filter(v => v.task === 'farm').length;
      T.ok('one farm: exactly ' + FARM_MAX_FARMERS + ' tasked (' + tasked + ')', tasked === FARM_MAX_FARMERS);
      T.ok('the extra villager walks there untasked', vils1.some(v => !v.task && v.path.length > 0));
      T.ok('player told the farm is full (' + msgs.join(' / ') + ')', msgs.some(m => /farmers per farm/.test(m)));
      T.ok('selection kept', selected.length === 3);
      for (let i = 0; i < T30(900); i++) update();
      T.ok('never more than ' + FARM_MAX_FARMERS + ' on the farm', vils1.filter(v => v.task === 'farm' || v.prevTask === 'farm').length <= FARM_MAX_FARMERS);
      return T;
    })),

    // ------------------------------------------------- builders take the near side, spread out
    'build-crew-near-edge': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 6, y: 6, team: 0 },
          { u: 'villager', x: 27, y: 21, team: 0 },
          { u: 'villager', x: 27, y: 21, team: 0 },
          { u: 'villager', x: 27, y: 22, team: 0 },
          { u: 'villager', x: 27, y: 22, team: 0 },
          { u: 'villager', x: 19, y: 10, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
        ],
      });
      const rax = createBuilding('BARRACKS', 20, 20, 0);   // foundation: x 20..22
      const farm = createBuilding('FARM', 13, 9, 0);       // foundation: x 13..14
      for (const b of [rax, farm]) { b.complete = false; b.buildProgress = 0; b.hp = 1; } // unbuilt sites
      const vils = entities.filter(e => e.team === 0 && e.utype === 'villager');
      const crew = vils.filter(v => v.x === 27), farmer = vils.find(v => v.x === 19);
      selected = crew;
      execUnitCommand({ tileX: 21, tileY: 21, buildTargetId: rax.id });
      selected = [farmer];
      execUnitCommand({ tileX: 13, tileY: 9, buildTargetId: farm.id });
      const dest = u => u.path.length ? u.path[u.path.length - 1] : { x: Math.round(u.x), y: Math.round(u.y) };
      const ends = crew.map(dest);
      T.ok('each builder heads for its own tile (' + ends.map(t => t.x + ',' + t.y).join(' ') + ')', new Set(ends.map(t => t.x + ',' + t.y)).size === crew.length);
      T.ok('all on the near (east) side', ends.every(t => t.x === 23));
      const fd = dest(farmer);
      T.ok('farm builder takes the near plot column (' + fd.x + ',' + fd.y + ')', fd.x === 14);
      for (let i = 0; i < T30(600); i++) update();
      T.ok('the crew is building', crew.every(v => v.task === 'build' && atBuildSite(v, rax)));
      return T;
    })),

    // ------------------------------------------------- a destroyed building's garrison survives (AoE2)
    'garrison-survives-destruction': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 6, y: 6, team: 0 },
          { b: 'HOUSE', x: 20, y: 20, team: 0 },
          { u: 'villager', x: 19, y: 20, team: 0 },
          { u: 'villager', x: 19, y: 21, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
        ],
      });
      const tower = createBuilding('TOWER', 24, 24, 0);
      const vils = entities.filter(e => e.team === 0 && e.utype === 'villager');
      for (const v of vils) { v.garrisonedIn = tower.id; tower.garrison.push(v.id); }
      tower.hp = 0; handleDeath(tower, 1);
      T.ok('the tower is gone', !entitiesById.has(tower.id));
      T.ok('its villagers are alive and outside', vils.every(v => v.hp > 0 && entitiesById.has(v.id) && !v.garrisonedIn));
      T.ok('ejected onto tile centres', vils.every(v => Number.isInteger(v.x) && Number.isInteger(v.y)));
      return T;
    })),

    // ------------------------------------------------- character mode: let go = stop on the spot
    'possess-halt': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'], ages: [1, 1],
        entities: [ { b: 'TC', x: 6, y: 6, team: 0 }, { u: 'villager', x: 20, y: 20, team: 0 }, { u: 'villager', x: 20, y: 24, team: 0 }, { b: 'TC', x: 44, y: 44, team: 1 } ],
      });
      const [v, w] = entities.filter(e => e.team === 0 && e.utype === 'villager');
      execCommand({ kind: 'possess', unitId: v.id, on: true }, 0);
      for (const u of [v, w]) { selected = [u]; execUnitCommand({ tileX: u.x + 6, tileY: u.y + 3 }); }
      for (let i = 0; i < T30(25); i++) update();
      execCommand({ kind: 'halt', unitId: v.id }, 0);
      execCommand({ kind: 'halt', unitId: w.id }, 0);           // not possessed: no effect
      const at = [v.x, v.y];
      T.ok('the possessed unit stops (path cleared)', v.path.length === 0);
      update(); update();
      T.ok('…on the spot, not snapped to a tile centre (' + v.x.toFixed(2) + ',' + v.y.toFixed(2) + ')', Math.hypot(v.x - at[0], v.y - at[1]) < 0.05);
      T.ok('a unit not possessed ignores halt', w.path.length > 0);
      // steer: a straight off-grid line, exactly along the heading (no tile zigzag)
      const s0 = [v.x, v.y], hx = Math.cos(0.4), hy = Math.sin(0.4);
      execCommand({ kind: 'steer', unitId: v.id, x: +(v.x + hx * 2.5).toFixed(3), y: +(v.y + hy * 2.5).toFixed(3) }, 0);
      T.ok('steer walks one straight off-grid leg', v.path.length === 1 && !Number.isInteger(v.path[0].x));
      let off = 0;
      for (let i = 0; i < T30(30); i++) { update(); const ox = v.x - s0[0], oy = v.y - s0[1]; off = Math.max(off, Math.abs(-ox * hy + oy * hx)); }
      T.ok('…never off the heading line (max ' + off.toFixed(3) + ')', off < 0.01);
      // a line through a wall falls back to the tile path
      for (let y = 10; y <= 30; y++) { const t = map[y][Math.round(v.x) + 2]; t.t = TERRAIN.WATER; markMapDirty(Math.round(v.x) + 2, y); }
      execCommand({ kind: 'steer', unitId: v.id, x: v.x + 3.4, y: v.y }, 0);
      T.ok('a blocked line walks the tiles instead', v.path.length === 0 || Number.isInteger(v.path[0].x));
      return T;
    })),

    // ------------------------------------------------- the line-on-the-grid primitive (any-angle walking)
    'walk-line-tiles': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      let r = 12345; const rnd = () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648;
      let bad = 0, ex = null;
      for (let n = 0; n < 300; n++) {
        const ax = rnd() * 20, ay = rnd() * 20, bx = rnd() * 20, by = rnd() * 20;
        const got = [[Math.round(ax), Math.round(ay)]];
        walkLineTiles(ax, ay, bx, by, (tx, ty) => { got.push([tx, ty]); });
        // brute force: every tile a very fine sampling of the line touches, in order
        const want = [[Math.round(ax), Math.round(ay)]];
        for (let i = 1; i <= 20000; i++) { const t = i / 20000, k = [Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t)];
          const l = want[want.length - 1]; if (k[0] !== l[0] || k[1] !== l[1]) want.push(k); }
        // exact: every reported tile really meets the segment (clip it to the tile's square), and nothing the sampling
        // sees is missed or out of order (sampling itself can jump a corner the line just clips, so it isn't the oracle)
        const meets = ([tx, ty]) => { let t0 = 0, t1 = 1; const d = [bx - ax, by - ay], o = [ax, ay], lo = [tx - 0.5, ty - 0.5], hi = [tx + 0.5, ty + 0.5];
          for (let k = 0; k < 2; k++) { if (d[k] === 0) { if (o[k] < lo[k] || o[k] > hi[k]) return false; continue; }
            let u = (lo[k] - o[k]) / d[k], v = (hi[k] - o[k]) / d[k]; if (u > v) [u, v] = [v, u]; t0 = Math.max(t0, u); t1 = Math.min(t1, v); }
          return t0 <= t1 + 1e-9; };
        let k = 0; for (const w of want) { while (k < got.length && (got[k][0] !== w[0] || got[k][1] !== w[1])) k++; if (k === got.length) break; }
        if (!got.every(meets) || k === got.length) { bad++; ex = ex || { ax, ay, bx, by, got, want }; }
      }
      T.ok('the DDA visits exactly the tiles the line crosses, in order (' + bad + '/300 wrong' + (ex ? ': ' + JSON.stringify(ex).slice(0, 200) : '') + ')', bad === 0);
      const diag = []; walkLineTiles(0, 0, 2, 2, (tx, ty, px, py) => { diag.push([tx, ty, px, py]); });
      T.ok('a line exactly through corners steps diagonally', JSON.stringify(diag) === '[[1,1,0,0],[2,2,1,1]]');
      return T;
    })),

    // ------------------------------------------------- straight legs keep the body clear of walls and corners
    'walk-clearance': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'], ages: [0, 0],
        entities: [ { b: 'TC', x: 4, y: 4, team: 0 }, { b: 'TC', x: 50, y: 50, team: 1 }, { b: 'HOUSE', x: 30, y: 30, team: 0 } ] });
      for (let y = 20; y < 42; y++) for (let x = 20; x < 42; x++) { const t = map[y][x]; if (!t.occupied) { t.t = TERRAIN.GRASS; t.res = 0; } }
      const house = entities.find(e => e.btype === 'HOUSE');
      let worst = 9, legs = 0;
      const pairs = [];   // every start round the house to every goal on the far sides: some straight lines must graze a corner
      for (let k = 26; k <= 35; k++) { pairs.push([k, 27, 61 - k, 34], [27, k, 34, 61 - k], [k, 27, 34, k], [27, k, k, 34]); }
      for (const [sx, sy, gx, gy] of pairs) {
        const v = createUnit('villager', sx, sy, 0);
        selected = [v]; execUnitCommand({ tileX: gx, tileY: gy });
        legs = Math.max(legs, v.path.length);
        for (let i = 0; i < 1500 && v.path.length; i++) { update();
          const dx = Math.max(house.x - 0.5 - v.x, 0, v.x - (house.x + house.w - 0.5)), dy = Math.max(house.y - 0.5 - v.y, 0, v.y - (house.y + house.h - 0.5));
          worst = Math.min(worst, Math.hypot(dx, dy)); }
        v.hp = 0; handleDeath(v, 1);
      }
      T.ok('around a corner the body stays clear (closest ' + worst.toFixed(2) + ' >= ' + UNIT_BODY_R + ')', worst >= UNIT_BODY_R - 1e-9);
      T.ok('…and walks are straight legs, not a staircase (most ' + legs + ' legs)', legs <= 4);
      return T;
    })),

    // ------------------------------------------------- one ground speed in every direction (AoE2)
    'walk-speed-isotropic': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'], ages: [0, 0],
        entities: [ { b: 'TC', x: 4, y: 4, team: 0 }, { b: 'TC', x: 50, y: 50, team: 1 } ] });
      for (let y = 15; y < 45; y++) for (let x = 15; x < 45; x++) { const t = map[y][x]; t.t = TERRAIN.GRASS; t.res = 0; t.occupied = null; }
      const speeds = [];
      for (const [dx, dy] of [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
        const v = createUnit('villager', 30, 30, 0);
        selected = [v]; execUnitCommand({ tileX: 30 + dx * 6, tileY: 30 + dy * 6 });
        let n = 0; while ((v.path.length || Math.hypot(v.x - (30 + dx * 6), v.y - (30 + dy * 6)) > 0.01) && n < 2000) { update(); n++; }
        speeds.push(Math.hypot(dx * 6, dy * 6) / n);
        v.hp = 0; handleDeath(v, 1);
      }
      const lo = Math.min(...speeds), hi = Math.max(...speeds);
      T.ok('same ground speed every way (tiles/tick ' + speeds.map(s => s.toFixed(4)).join(' ') + ')', hi / lo < 1.06);
      return T;
    })),

    // ------------------------------------------------- spawn never into a sealed pocket
    // A training building whose spawn corner is wedged into forest must not birth units there (they could never leave).
    'spawn-not-in-pocket': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 6, y: 6, team: 0 },
          { b: 'BARRACKS', x: 20, y: 20, team: 0 },   // x,y 20..22: the spawn corner is (23,23)
          { b: 'TC', x: 44, y: 44, team: 1 },
        ],
      });
      for (const [x, y] of [[22,23],[22,24],[23,24],[24,24],[24,23],[24,22],[23,22]]) {
        const t = map[y][x]; t.t = TERRAIN.FOREST; t.res = 100; t.occupied = null; markMapDirty(x, y);
      }
      T.ok('the corner is a sealed pocket', walkable(23, 23) && !tileOpensOut(23, 23));
      const rax = entities.find(e => e.btype === 'BARRACKS');
      resources[0].food = 500; resources[0].gold = 500;
      rax.queue.push('militia');
      for (let i = 0; i < T30(1200) && !entities.some(e => e.utype === 'militia'); i++) update();
      const m = entities.find(e => e.utype === 'militia');
      T.ok('the militia was trained', !!m);
      T.ok('it spawned onto open ground (' + (m && m.x) + ',' + (m && m.y) + ')', !!m && !(Math.round(m.x) === 23 && Math.round(m.y) === 23) && tileOpensOut(Math.round(m.x), Math.round(m.y)));
      return T;
    })),

    // ------------------------------------------------- two farmers keep their own rows
    'farm-two-lanes': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 6, y: 6, team: 0 },
          { b: 'FARM', x: 13, y: 9, team: 0 },
          { u: 'villager', x: 17, y: 10, team: 0 },
          { u: 'villager', x: 17, y: 10, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
        ],
      });
      const farm = entities.find(e => e.team === 0 && e.btype === 'FARM');
      const [a, b] = entities.filter(e => e.team === 0 && e.utype === 'villager');
      selected = [a, b];
      execUnitCommand({ tileX: farm.x, tileY: farm.y, buildTargetId: farm.id });
      let shared = 0, working = 0;
      for (let i = 0; i < T30(1500); i++) {
        update();
        const on = u => u.task === 'farm' && u.path.length === 0 && u.carrying > 0;
        if (on(a) && on(b)) { working++; if (Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y)) shared++; }
      }
      T.ok('both farmers worked the plot together (' + working + ' ticks)', working > 100);
      T.ok('never on the same tile (' + shared + ' shared ticks)', shared === 0);
      T.ok('each keeps its own row', Math.round(a.y) !== Math.round(b.y));
      return T;
    })),

    // ------------------------------------------------- exhausted farm: idle in the middle
    // AoE2: with no reseed paid, the player's farmer stands idle in the centre of its dry plot; any order ends that.
    'farm-exhausted-idle': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'FARM', x: 13, y: 9, team: 0 },
          { u: 'villager', x: 13, y: 9, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
        ],
      });
      const farm = entities.find(e => e.team === 0 && e.btype === 'FARM');
      const v = entities.find(e => e.team === 0 && e.utype === 'villager');
      v.task = 'farm'; v.gatherX = farm.x; v.gatherY = farm.y;
      resources[0].wood = 0; resources[0].prepaidFarms = 0;
      map[farm.y][farm.x].res = 3; // the next bites drain it: the real exhaustion path
      let exhaustedAt = -1;
      for (let i = 0; i < T30(1500); i++) { update(); if (exhaustedAt < 0 && farm.exhausted) exhaustedAt = i; }
      const cx = farm.x + 0.5, cy = farm.y + 0.5, d = Math.hypot(v.x - cx, v.y - cy);
      T.ok('the farm ran dry', farm.exhausted);
      T.ok('farmer idles (task=' + v.task + ')', !v.task && v.idleFarm === farm.id);
      T.ok('farmer stands in the middle of the plot (d=' + d.toFixed(2) + ')', d <= 0.25);
      selected = [v];
      execUnitCommand({ tileX: 20, tileY: 14 });
      for (let i = 0; i < T30(900); i++) update();
      T.ok('a move order ends the wait', v.idleFarm == null && Math.hypot(v.x - 20, v.y - 14) < 1.5);
      return T;
    })),

    // ----------------------------------------------------- farm stroll parity
    // Farmers walk a ring over their 2×2 plot between bites (AoE2 stroll).
    // The legs must not change the food rate: extraction stays cooldown-bound
    // (the leg is far shorter than the cycle and the cooldown ticks mid-walk).
    'farm-stroll': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [1, 1],
        entities: [
          { b: 'TC', x: 8, y: 8, team: 0 },
          { b: 'FARM', x: 11, y: 9, team: 0 },
          { u: 'villager', x: 13, y: 9, team: 0 },
          { b: 'TC', x: 44, y: 44, team: 1 },
        ],
      });
      const farm = entities.find(e => e.team === 0 && e.btype === 'FARM');
      const v = entities.find(e => e.team === 0 && e.utype === 'villager');
      v.task = 'farm'; v.gatherX = farm.x; v.gatherY = farm.y;
      const biteTicks = [], visited = new Set();
      let prevCarry = 0, returnAfterFull = false;
      for (let i = 0; i < T30(1600); i++) {
        update();
        if (v.task === 'farm') visited.add(Math.round(v.x) + ',' + Math.round(v.y));
        if (v.carrying > prevCarry) biteTicks.push(i);
        if (prevCarry < v.carryMax && v.carrying >= v.carryMax) returnAfterFull = v.task === 'return' || v.path.length === 0;
        prevCarry = v.carrying;
        if (biteTicks.length >= 6) break;
      }
      // (a) rate parity: every inter-bite delta equals the cooldown formula
      const cd = gatherCooldownFor(0, 'food', T30(94));
      const deltas = biteTicks.slice(1).map((t, k) => t - biteTicks[k]);
      T.ok('stroll keeps extraction cooldown-bound (deltas=' + deltas.join(',') + ' cd=' + cd + ')',
           deltas.length >= 4 && deltas.every(d => d === cd));
      // (b) the ring actually covers the whole 2×2 plot
      const plot = [[0,0],[1,0],[1,1],[0,1]].map(([dx,dy]) => (farm.x+dx) + ',' + (farm.y+dy));
      T.ok('farmer visits all 4 plot tiles', plot.every(k => visited.has(k)));
      // (c) HEAVY PLOW works straight furrows: passes pace E/W along the
      // grain (world X), headland shifts N/S only every 3rd bite.
      applyTech(0, 'heavy_plow');
      // Measure ONE clean load from the origin (deposit boundaries reset
      // the row phase and this farm deposits IN PLACE at the adjacent TC,
      // so mid-stream windows mix haul legs into the count).
      v.carrying = 0; v.carryType = null;
      v.x = farm.x; v.y = farm.y; clearUnitPath(v);
      const stands = [];
      let pc = 0;
      for (let i = 0; i < T30(2400); i++) {
        update();
        if (v.carrying === pc + 1) { stands.push({ x: Math.round(v.x), y: Math.round(v.y), c: v.carrying }); pc = v.carrying; }
        if (stands.length >= 10) break;
      }
      const pairs = stands.slice(1).map((s, k) => ({ ax: Math.abs(s.x - stands[k].x), ay: Math.abs(s.y - stands[k].y) }));
      const passes = pairs.filter(l => l.ax === 1 && l.ay === 0).length;
      const shifts = pairs.filter(l => l.ax === 0 && l.ay === 1).length;
      T.ok('plow furrows: grain passes 2:1 over headland shifts (' + passes + ':' + shifts + ' of ' + pairs.length + ')',
           passes === 6 && shifts === 3 && pairs.length === 9);
      T.ok('plow still covers both rows', new Set(stands.map(s => s.y)).size === 2);
      // (d) a depleting bite hands the farmer to the reseed flow (no stroll)
      resources[0].prepaidFarms = 0;
      map[farm.y][farm.x].res = 1;
      let flipped = false;
      for (let i = 0; i < T30(400) && !flipped; i++) {
        update();
        flipped = farm.exhausted && v.task === 'build' && v.buildTarget === farm.id;
      }
      T.ok('depleting bite flips straight to the reseed flow', flipped);
      return T;
    })),

    // ------------------------------------- tower line of sight scales with age
    // Watch towers double as scouting outposts (AoE2 Outpost): LOS 6 (Dark) →
    // 9 (Feudal) → 12 (Castle), keyed off the owner's teamAge.
    'tower-los-by-age': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'ai:hard'],
        ages: [0, 0], entities: [ { b: 'TC', x: 8, y: 8, team: 0 }, { b: 'TC', x: 50, y: 50, team: 1 } ] });
      window.fogDisabled = false;
      const tx = 30, ty = 30;
      const tower = createBuilding('PTOWER', tx, ty, 0); // 1x1 → disk centered on (tx,ty)
      tower.complete = true; tower.hp = tower.maxHp;
      // Recompute vision from scratch (forced rebuild) and read team 0's grid.
      const seen = (x, y) => { visionFreshTick = -1; visionRebuild = true; updateTeamVision(); return teamVisGrid[0][y * MAP + x] > 0; };
      teamAge[0] = 0;
      T.ok('dark: sees 6 tiles out', seen(tx + 6, ty));
      T.ok('dark: does NOT see 9 tiles out', !seen(tx + 9, ty));
      teamAge[0] = 1;
      T.ok('feudal: now sees 9 tiles out', seen(tx + 9, ty));
      T.ok('feudal: does NOT see 12 tiles out', !seen(tx + 12, ty));
      teamAge[0] = 2;
      T.ok('castle: now sees 12 tiles out', seen(tx + 12, ty));
      return T;
    })),

    // ------------------------------------------------------------ walled archer
    'walled-archer': async (page) => {
      const save = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios/walled-archer.savegame.json'), 'utf8'));
      return withPage(browser, port, '/tools/sim.html', p => p.evaluate((save) => {
        const T = window.__T;
        loadGame(save);
        gameStarted = true; gamePaused = false; gameOver = false;
        const archer = entities.find(e => e.utype === 'archer');
        const knight = entities.find(e => e.utype === 'knight');
        let lastHitAt = -1;
        for (let i = 0; i < 3000 && knight.hp > 0; i++) {
          update();
          if (knight.lastHitTick === tick) lastHitAt = tick;
        }
        T.ok('knight survives the boxed archer', knight.hp > 0);
        T.ok('knight disengaged out of range', dist(knight, archer) > archer.range + 0.5);
        T.ok('knight stopped taking hits', tick - lastHitAt > 400); // 20 game-s at 20tps
        T.ok('archer stayed in its box, alive', archer.hp > 0);
        return T;
      }, save));
    },

    // -------------------------------------------------------- save v4 roundtrip
    'save-v4': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      window.__pendingMatchSeed = 77;
      setMapSize('small');
      restartGame('hard');
      window.fogDisabled = false;
      gameStarted = true; gamePaused = true;
      for (let i = 0; i < 3000; i++) update();
      const cksum = simChecksum(), tick0 = tick;
      const occ = map.map(r => r.map(c => c.occupied).join(',')).join(';');
      const grids = teamExploredGrid.map(g => Array.from(g).join('')).join('|');
      const save = serializeGameForWire();
      T.ok('v9 stamp + tps', save.version === 9 && save.tps === TPS);
      T.ok('fog-on save carries RLE grids', Array.isArray(save.teamExploredGrids));
      T.ok(`compact (${(JSON.stringify(save).length / 1024).toFixed(1)}KB < 40KB)`, JSON.stringify(save).length < 40 * 1024);
      T.ok('occupied never serialized', JSON.stringify(save.map).indexOf('occupied') < 0);
      for (let i = 0; i < 800; i++) update(); // dirty the world past the save point
      applySavedGame(save);
      T.ok('tick + checksum restored EXACTLY', tick === tick0 && simChecksum() === cksum);
      T.ok('occupied rebuilt exactly', map.map(r => r.map(c => c.occupied).join(',')).join(';') === occ);
      T.ok('explored grids restored exactly', teamExploredGrid.map(g => Array.from(g).join('')).join('|') === grids);
      window.fogDisabled = true;
      T.ok('fog-off save omits grids', serializeGameForWire().teamExploredGrids === null);
      window.fogDisabled = false;
      return T;
    })),

    // ------------------------------------------------------------- fog option
    'fog-option': async (page) => {
      const a = await withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
        const T = window.__T;
        const setup = (fogOff) => {
          NUM_TEAMS = 2;
          window.__pendingMatchSeed = 99;
          window.fogDisabled = fogOff;
          setMapSize('small');
          restartGame('hard');
          teamControllers = [0, 1].map(() => ({ type: 'ai', difficulty: 'hard' }));
          resetAIStates();
          gameStarted = true; gamePaused = true;
        };
        const gridSum = () => teamExploredGrid.reduce((s, g) => { for (let i = 0; i < g.length; i++) s += g[i]; return s; }, 0);
        setup(true);
        for (let i = 0; i < 300; i++) update();
        T.ok('no-fog: grids unmaintained', gridSum() === 0);
        T.ok('no-fog: AI intel omniscient', AI_STATES[0].intel && AI_STATES[0].intel.tcSeen === true);
        T.ok('no-fog: teamHasExplored/CanSeeTile short-circuit', teamHasExplored(0, 0) && teamCanSeeTile(1, 0));
        setup(false);
        for (let i = 0; i < 300; i++) update();
        T.ok('fog: grids grow normally', gridSum() > 0);
        T.ok('fog: intel NOT omniscient at start', !(AI_STATES[0].intel && AI_STATES[0].intel.tcSeen));
        return T;
      }));
      const b = await withPage(browser, port, '/index.html', p => p.evaluate(() => {
        const T = window.__T;
        T.ok('SP fogmode radios exist (Fog default)',
             document.querySelector('input[name="fogmode"][value="fog"]').checked === true);
        document.querySelector('input[name="fogmode"][value="open"]').checked = true;
        onStartClicked();
        T.ok('Start with "Open" -> fogDisabled true', window.fogDisabled === true);
        window.fogDisabled = false; gameOver = true;
        seeMap();
        T.ok('seeMap never mutates the match flag', window.fogDisabled === false && window.seeMapMode === true);
        T.ok('lobby fog radios exist', !!document.querySelector('input[name="lobbyfog"]'));
        return T;
      }));
      return { pass: [...a.pass, ...b.pass], fail: [...a.fail, ...b.fail] };
    },

    // ---------------------------------- lane-shunt: no bulldozing idle units
    'lane-shunt': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'small', seed: 3, numTeams: 2, controllers: ['human', 'human'], entities: [] });
      gameStarted = true; gamePaused = false; myTeam = 0;
      // A villager commutes the same lane 6+ times over an idle soldier
      // standing on it. Separation must shunt the soldier SIDEWAYS once
      // (perpendicular to the lane) — the old radial push scooted it ~0.3
      // tiles DOWN the lane per pass, walking it across the map over a game.
      const soldier = createUnit('militia', 30, 20, 0);
      const vil = createUnit('villager', 10, 20, 0);
      issueMoveOrder(vil, 50, 20);
      let leg = 0;
      for (let i = 0; i < 9400; i++) { // ~7.8 game-min soak at 20tps
        update();
        if (vil.path.length === 0 && !(vil.order && vil.order.kind === 'move')) {
          leg++;
          issueMoveOrder(vil, leg % 2 ? 10 : 50, 20);
        }
      }
      T.ok(`soldier not bulldozed along the lane (|dx| ${Math.abs(soldier.x - 30).toFixed(2)} < 1)`, Math.abs(soldier.x - 30) < 1);
      T.ok(`soldier settled just beside the lane (total ${Math.hypot(soldier.x - 30, soldier.y - 20).toFixed(2)} < 1.5)`,
           Math.hypot(soldier.x - 30, soldier.y - 20) < 1.5);
      T.ok('villager commuted freely', leg >= 6);
      return T;
    })),

    // -------------------------------------------- large-army group move (ex repro)
    'large-army-move': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'medium', seed: 1, numTeams: 2, controllers: ['human', 'human'], entities: [] });
      gameStarted = true; gamePaused = false; myTeam = 0;
      const n = 40, cols = Math.ceil(Math.sqrt(n)), army = [];
      for (let i = 0; i < n; i++) army.push(createUnit('knight', 12 + (i % cols), 12 + Math.floor(i / cols), 0));
      const fOff = formationOffsets(army, false), gs = Math.min(...army.map(m => m.speed || 1));
      army.forEach(s => {
        s.groupSpeed = gs;
        const [ox, oy] = fOff.get(s.id) || [0, 0];
        issueMoveOrder(s, 50 + ox, 50 + oy);
      });
      T.ok('every unit got a path', army.every(u => u.path.length > 0 || (u.order && u.order.kind === 'move')));
      for (let i = 0; i < 1500; i++) update();
      const arrived = army.filter(u => Math.hypot(u.x - 50, u.y - 50) < 6).length;
      T.ok(`whole block arrives (${arrived}/${n} >= 38)`, arrived >= 38);
      return T;
    })),

    // ------------------------------- select-all assault on a sealed TC (ex repro)
    // ------------------------------------------------------------ ballistics
    // AoE2's answer to cavalry outrunning arrows: without the tech a shot flies
    // at the spot the target occupied at launch (a scout drifts ~0.83 tiles
    // during a 4-tile flight vs a 0.45 impact radius); with it the aim leads.
    'ballistics': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      const rate = (utype, researched) => {
        loadScenario({ map: 'small', seed: 11, numTeams: 2, controllers: ['human', 'human'],
                       entities: [{ b: 'TC', x: 2, y: 2, team: 0 }, { b: 'TC', x: 50, y: 50, team: 1 }] });
        gameStarted = true; gamePaused = false; myTeam = 0;
        for (let y = 18; y < 48; y++) for (let x = 18; x < 48; x++) { const c = map[y][x]; c.t = TERRAIN.GRASS; c.res = 0; markMapDirty(x, y); }
        const a = createUnit('archer', 30, 30, 0); a.stance = 'aggressive';
        if (researched) applyTech(0, 'ballistics');
        const t = createUnit(utype, 27, 22, 1); t.stance = 'passive'; t.hp = 100000; t.maxHp = 100000;
        let shots = 0, hits = 0, prevCd = a.atkCooldown, prevHp = t.hp;
        for (let i = 0; i < 3000; i++) {
          if (t.path.length === 0) issueMoveOrder(t, 27, (Math.floor(i / 400) % 2) ? 22 : 40);
          update();
          if (a.atkCooldown > prevCd) shots++;
          prevCd = a.atkCooldown;
          if (t.hp < prevHp) hits++;
          prevHp = t.hp;
        }
        return shots ? hits / shots : 0;
      };
      const scoutOff = rate('scout', false), scoutOn = rate('scout', true);
      T.ok(`cavalry outruns un-led arrows (${Math.round(scoutOff * 100)}% hits, want <60%)`, scoutOff < 0.6);
      T.ok(`Ballistics leads them (${Math.round(scoutOn * 100)}% hits, want >75%)`, scoutOn > 0.75);
      T.ok('Ballistics is a real improvement (+20pts or better)', scoutOn - scoutOff >= 0.2);
      // and it is a Castle-age Barracks card, not a freebie
      T.ok('researched at the Barracks', BLDGS.BARRACKS.researches.includes('ballistics'));
      T.ok('Castle age, 300F 175W (DE)', UPGRADES.ballistics.age === 2 &&
           UPGRADES.ballistics.cost.f === 300 && UPGRADES.ballistics.cost.w === 175);
      return T;
    })),

    // ------------------------------------------- work-vs-animation parity
    // The renderer's "is this unit working" gates call the SIM's predicates
    // (atBuildSite / atGatherTile / inWeaponRange) rather than re-spelling
    // them. Assert the contract they encode: work only ever happens while its
    // predicate is true, so a swing never lands in silence and a villager
    // never mimes work that isn't happening.
    'work-anim-parity': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({ map: 'small', seed: 5, numTeams: 2, controllers: ['human', 'human'],
                     entities: [{ b: 'TC', x: 4, y: 4, team: 0 }, { b: 'TC', x: 48, y: 48, team: 1 }] });
      gameStarted = true; gamePaused = false; myTeam = 0;
      const run = (n, fn) => { for (let i = 0; i < n; i++) { update(); fn && fn(); } };

      // BUILD: progress must never tick while the render gate reads "not at site"
      {
        const v = createUnit('villager', 20, 20, 0);
        const store = resourceStore(0); store.wood = 900; store.stone = 900;
        const site = createBuilding('HOUSE', 26, 20, 0); site.complete = false; site.buildProgress = 0;
        v.task = 'build'; v.buildTarget = site.id;
        let prog = site.buildProgress, ticks = 0, silent = 0;
        run(900, () => {
          if (site.buildProgress > prog) { ticks++; if (!atBuildSite(v, site)) silent++; }
          prog = site.buildProgress;
        });
        T.ok(`build: progress only while at the site (${ticks} work ticks, ${silent} off-site)`, ticks > 0 && silent === 0);
      }

      // GATHER: same for chopping — carrying only rises while at the tile
      {
        const v = createUnit('villager', 30, 30, 0);
        let tile = null;
        for (let y = 26; y < 36 && !tile; y++) for (let x = 26; x < 36; x++)
          if (map[y][x].t === TERRAIN.GRASS) { map[y][x].t = TERRAIN.FOREST; map[y][x].res = 200; markMapDirty(x, y); tile = { x, y }; break; }
        v.task = 'chop';
        let carried = v.carrying, ticks = 0, silent = 0;
        run(900, () => {
          if (v.carrying > carried) { ticks++; if (!atGatherTile(v, v.gatherX, v.gatherY)) silent++; }
          carried = v.carrying;
        });
        T.ok(`chop: carrying only rises at the tile (${ticks} work ticks, ${silent} off-tile)`, ticks > 0 && silent === 0);
      }
      return T;
    })),

    'walled-tc-assault': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      const ents = [{ b: 'TC', x: 28, y: 28, team: 1 }];
      for (let x = 26; x <= 33; x++) { ents.push({ b: 'SWALL', x, y: 26, team: 1 }); ents.push({ b: 'SWALL', x, y: 33, team: 1 }); }
      for (let y = 27; y < 33; y++) { ents.push({ b: 'SWALL', x: 26, y, team: 1 }); ents.push({ b: 'SWALL', x: 33, y, team: 1 }); }
      loadScenario({ map: 'medium', seed: 1, numTeams: 2, controllers: ['human', 'human'], entities: ents });
      gameStarted = true; gamePaused = false; myTeam = 0;
      const n = 30, cols = Math.ceil(Math.sqrt(n)), army = [];
      for (let i = 0; i < n; i++) army.push(createUnit('knight', 10 + (i % cols), 10 + Math.floor(i / cols), 0));
      const tc = entities.find(e => e.btype === 'TC' && e.team === 1);
      const wallHp0 = entities.filter(e => isWallBtype(e.btype)).reduce((s, w) => s + w.hp, 0);
      // Drive the REAL attack command (not raw target pokes) — this is also
      // what stamps the anchor/flag semantics the disposition tests cover.
      execCommand({ kind: 'command', unitIds: army.map(u => u.id), targetId: tc.id, tileX: 29, tileY: 29 }, 0);
      let maxMs = 0;
      for (let i = 0; i < 4000 && tc.hp > 0; i++) {
        const t0 = performance.now();
        update();
        maxMs = Math.max(maxMs, performance.now() - t0);
      }
      const engaged = army.filter(u => u.hp > 0 && Math.hypot(u.x - 29.5, u.y - 29.5) < 8).length;
      const wallHp = entities.filter(e => isWallBtype(e.btype)).reduce((s, w) => s + w.hp, 0);
      T.ok(`whole army engages the ring (${engaged}/${n} >= 27)`, engaged >= 27);
      T.ok('walls take real damage (breach in progress)', wallHp < wallHp0 - 300 || tc.hp <= 0);
      T.ok(`no pathfinding storm (worst tick ${maxMs.toFixed(0)}ms < 120ms)`, maxMs < 120);
      return T;
    })),

    // ------------------------------------------- ordered onto an unreachable foe
    // AoE2: an attack order on something you can't walk to still WALKS the unit
    // as close as the terrain allows (and it fires the moment the foe drifts
    // into range). Two ways the old code left units standing where the order was
    // given: the 15-tick re-aim replaced a good approach with an empty path, and
    // a unit whose reachable region is small enough to search exhaustively never
    // got a path at all.
    'unreachable-approach': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      const run = (n) => { for (let i = 0; i < n; i++) update(); };
      const flatScenario = (ents) => {
        loadScenario({ map: 'small', seed: 3, numTeams: 2, controllers: ['human', 'human'],
                       entities: [{ b: 'TC', x: 2, y: 2, team: 0 }, { b: 'TC', x: 48, y: 48, team: 1 }].concat(ents) });
        gameStarted = true; gamePaused = false; myTeam = 0;
      };
      const order = (u, t) => execCommand({ kind: 'command', unitIds: [u.id], targetId: t.id,
                                            tileX: Math.round(t.x), tileY: Math.round(t.y) }, 0);

      // 1. foe on an island: close to the shore, hold there, keep the order
      {
        flatScenario([]);
        for (let y = 24; y <= 36; y++) for (let x = 24; x <= 36; x++)
          if (x === 24 || x === 36 || y === 24 || y === 36) { map[y][x].t = TERRAIN.WATER; markMapDirty(x, y); }
        const foe = createUnit('militia', 30, 30, 1);
        const a = createUnit('archer', 30, 45, 0);
        run(900);
        T.ok('island: no approach yet (nothing ordered)', Math.abs(a.y - 45) < 0.5);
        order(a, foe);
        run(900);
        // The moat is 6 tiles out from the foe, so "as close as possible" is a
        // shore tile ~7 away — from 15 at the start, and still out of range.
        const closed = Math.hypot(a.x - foe.x, a.y - foe.y);
        T.ok(`island: archer closed to the shore (d=${closed.toFixed(1)}, want <=7.5)`, closed <= 7.5);
        T.ok('island: keeps the ordered target', a.target === foe.id);
        // and then HOLDS: no twitching between equally-close tiles forever
        const parked = [a.x, a.y];
        run(900);
        T.ok('island: parks and stays put', Math.hypot(a.x - parked[0], a.y - parked[1]) < 0.3);
        // and it shoots the moment the foe comes within range
        foe.x = 30; foe.y = 34.5;
        const hp0 = foe.hp;
        run(300);
        T.ok('island: fires once the foe drifts into range', foe.hp < hp0);
      }

      // 2. archer sealed inside its own pen (small reachable region — the case
      //    where A* finishes the search and reports "no route")
      {
        const pen = [];
        for (let y = 40; y <= 50; y++) for (let x = 25; x <= 35; x++)
          if (x === 25 || x === 35 || y === 40 || y === 50) pen.push({ b: 'SWALL', x, y, team: 0 });
        flatScenario(pen);
        const foe = createUnit('militia', 30, 20, 1);
        const a = createUnit('archer', 30, 48, 0);
        order(a, foe);
        run(900);
        T.ok(`sealed pen: archer walks to the wall (y=${a.y.toFixed(1)}, want <=42)`, a.y <= 42);
      }

      // 3. a plain MOVE order out of a sealed pen: walk to the wall, park, and
      //    retire the order (same AoE2 rule as the attack order above)
      {
        const pen = [];
        for (let y = 40; y <= 50; y++) for (let x = 25; x <= 35; x++)
          if (x === 25 || x === 35 || y === 40 || y === 50) pen.push({ b: 'SWALL', x, y, team: 0 });
        flatScenario(pen);
        const squad = [];
        for (let i = 0; i < 6; i++) squad.push(createUnit('militia', 28 + i, 48, 0));
        execCommand({ kind: 'command', unitIds: squad.map(u => u.id), tileX: 30, tileY: 20 }, 0);
        run(900);
        const atWall = squad.filter(u => u.y <= 43).length;
        T.ok(`sealed pen move: squad walks to the wall (${atWall}/6 within 3 tiles of it)`, atWall === 6);
        T.ok('sealed pen move: order retired, nobody still churning', squad.every(u => !u.order && u.path.length === 0));
        const parked = squad.map(u => [u.x, u.y]);
        run(600);
        T.ok('sealed pen move: they stay put',
             squad.every((u, i) => Math.hypot(u.x - parked[i][0], u.y - parked[i][1]) < 0.3));
        // the same order with a hole in the pen still walks all the way out
        const gap = entities.find(e => e.btype === 'SWALL' && e.x === 30 && e.y === 40);
        gap.hp = 0; handleDeath(gap, 1);
        const runner = createUnit('militia', 30, 48, 0);
        execCommand({ kind: 'command', unitIds: [runner.id], tileX: 30, tileY: 20 }, 0);
        run(1200);
        T.ok(`pen with a hole: walks out to the goal (y=${runner.y.toFixed(1)})`, runner.y <= 22);
      }

      // 4. shooting a BUILDING from inside your own wall box (the user's save):
      //    the firing tile exists only under footprint geometry — measuring range
      //    to the mill's origin tile hides it and the archer parks a tile short.
      {
        const box = [];
        for (let y = 38; y <= 43; y++) for (let x = 36; x <= 41; x++)
          if (x === 36 || x === 41 || y === 38 || y === 43) box.push({ b: 'WALL', x, y, team: 0 });
        flatScenario(box.concat([{ b: 'MILL', x: 31, y: 42, team: 1 }]));
        const a = createUnit('archer', 40, 40, 0);
        const mill = entities.find(e => e.btype === 'MILL');
        const hp0 = mill.hp;
        order(a, mill);
        run(1200);
        T.ok(`boxed archer walks to the near wall (${a.x.toFixed(0)},${a.y.toFixed(0)})`, a.x <= 37.5);
        T.ok(`boxed archer shoots the mill over the wall (hp ${hp0}->${mill.hp})`, mill.hp < hp0);
        // Every shot must coincide with the DRAW ANIMATION: the render gate and
        // the sim gate are one predicate (inWeaponRange), and this is the
        // geometry that caught them drifting — damage landing in total silence.
        let shots = 0, silent = 0;
        for (let i = 0; i < 600; i++) {
          const cd = a.atkCooldown;
          update();
          if (a.atkCooldown > cd) { shots++; if (!inActionRange(a)) silent++; }
        }
        T.ok(`every shot plays the attack animation (${shots} shots, ${silent} silent)`, shots > 0 && silent === 0);
      }

      // 5. AUTO attack/defense from inside the box — no order at all. Acquiring
      //    asks "can I reach a firing tile", not "can I walk onto its tile", so
      //    a boxed archer repositions to shoot a raider it could never reach.
      {
        const box = [];
        for (let y = 38; y <= 43; y++) for (let x = 36; x <= 41; x++)
          if (x === 36 || x === 41 || y === 38 || y === 43) box.push({ b: 'WALL', x, y, team: 0 });
        for (const [stance, wantMove] of [['aggressive', true], ['defensive', true], ['standground', false]]) {
          flatScenario(box);
          const a = createUnit('archer', 40, 40, 0); a.stance = stance;
          const foe = createUnit('militia', 34, 40, 1); foe.stance = 'standground';
          run(600);
          const moved = Math.hypot(a.x - 40, a.y - 40);
          if (wantMove) {
            T.ok(`${stance}: boxed archer repositions and engages unordered (moved ${moved.toFixed(1)}, foe ${foe.hp}/${foe.maxHp})`,
                 moved > 0.5 && foe.hp < foe.maxHp);
          } else {
            // Stand Ground never repositions — it only fires at what is already
            // in range. Pinning it here so the acquire change can't erode it.
            T.ok(`${stance}: holds position (moved ${moved.toFixed(1)})`, moved < 0.3);
          }
        }
      }

      // 6. control: a REACHABLE foe is still closed on and engaged
      {
        flatScenario([]);
        const foe = createUnit('militia', 30, 30, 1); foe.stance = 'standground';
        const a = createUnit('archer', 30, 45, 0);
        order(a, foe);
        run(600);
        T.ok('reachable foe: closed to firing range', distToTarget(a, foe) <= UNITS.archer.range + 0.5);
        T.ok('reachable foe: taking damage', foe.hp < foe.maxHp);
      }
      return T;
    })),

    // ------------------------------------------------------- stance matrix
    // THE disposition contract, one section per stance, driven through the
    // REAL command pipeline (execCommand) — never raw field pokes. Guards
    // against the class of bug where implicit posture systems (guard posts,
    // anchors, leashes) fight the stance the player actually picked.
    'stance-matrix': (page) => withPage(browser, port, '/tools/sim.html', p => p.evaluate(() => {
      const T = window.__T;
      loadScenario({
        map: 'medium', seed: 9, numTeams: 2, controllers: ['human', 'human'],
        entities: [
          { b: 'TC', x: 4, y: 4, team: 0 },
          { b: 'TC', x: 80, y: 80, team: 1 },
        ],
      });
      gameStarted = true; gamePaused = false; myTeam = 0;
      const mk = (ut, x, y, team) => createUnit(ut, x, y, team);
      const order = (kind, u, extra) => execCommand(Object.assign({ kind, unitIds: [u.id] }, extra), u.team);
      const run = (n) => { for (let i = 0; i < n; i++) update(); };

      // AGGRESSIVE: acquires within 8, chases freely, holds ground where the
      // fight ends — no post, no walk-home (the reported bug).
      {
        const m = mk('knight', 30, 30, 0);
        order('command', m, { tileX: 30, tileY: 30 }); run(10); // ordered here: anchor=here
        const foe = mk('militia', 36, 30, 1);
        run(300);
        T.ok('aggressive: acquired within 8', foe.hp <= 0);
        const endX = m.x;
        run(400);
        T.ok('aggressive: no post planted by orders', m.guardX == null);
        T.ok('aggressive: holds ground after the kill (no walk-home)', Math.abs(m.x - endX) < 2);
        m.hp = 0; handleDeath(m, 1);
      }

      // DEFENSIVE: leashes to its anchor — chases, gets reeled back inside
      // ~6 tiles of the ordered spot, never marches across the map.
      {
        const d = mk('knight', 30, 50, 0);
        order('set-stance', d, { stance: 'defensive' });
        order('command', d, { tileX: 30, tileY: 50 }); run(10);
        const bait = mk('scout', 35, 50, 1); // faster than the knight: an endless chase if unleashed
        bait.stance = 'passive';
        pathUnitTo(bait, 75, 50); // flees across the map
        run(900);
        T.ok('defensive: leashed near its anchor', Math.hypot(d.x - 30, d.y - 50) < 10);
        bait.hp = 0; handleDeath(bait, 0); d.hp = 0; handleDeath(d, 1);
      }

      // STANDGROUND: never moves to fight; no acquire→drop churn when shot
      // from beyond its reach.
      {
        const sg = mk('militia', 30, 70, 0);
        order('set-stance', sg, { stance: 'standground' });
        const archerFoe = mk('archer', 36, 70, 1); // shoots from range 4+, militia reach 1.5
        archerFoe.stance = 'standground'; // keep it parked
        run(200);
        T.ok('standground: does not chase its shooter', Math.hypot(sg.x - 30, sg.y - 70) < 1.5);
        T.ok('standground: no target churn at unreachable shooter', sg.target == null);
        archerFoe.hp = 0; handleDeath(archerFoe, 0); sg.hp = 0; handleDeath(sg, 1);
      }

      // PASSIVE: never auto-engages or retaliates — but an EXPLICIT attack
      // order is still obeyed (AoE2), and a Guard order un-passives.
      {
        const pv = mk('knight', 50, 30, 0);
        order('set-stance', pv, { stance: 'passive' });
        const poker = mk('militia', 52, 30, 1);
        run(150);
        T.ok('passive: no auto-acquire, no retaliation', pv.target == null && poker.hp > 0);
        order('command', pv, { targetId: poker.id, tileX: 52, tileY: 30 });
        run(300);
        T.ok('passive: explicit attack order still obeyed', poker.hp <= 0);
        order('set-stance', pv, { stance: 'passive' });
        order('guard', pv, { x: 50, y: 30 });
        T.ok('guard order un-passives (no inert guards)', pv.stance !== 'passive');
        pv.hp = 0; handleDeath(pv, 1);
      }
      return T;
    })),
  };

  for (const [name, run] of Object.entries(sections)) {
    if (only && !name.includes(only)) continue;
    try {
      report(name, await run());
    } catch (err) {
      console.log(`FAIL  [${name}] harness error: ${err.message}`);
      results.push(false);
    }
  }

  await browser.close(); srv.close();
  const fails = results.filter(r => !r).length;
  console.log(`\n${results.length - fails}/${results.length} assertions passed`);
  process.exit(fails ? 1 : 0);
})();
