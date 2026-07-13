#!/usr/bin/env node
// ---- Sim behavior tests (Playwright driver) ----
// Fast, targeted PASS/FAIL assertions on GAME MECHANICS, driven headlessly on
// tools/sim.html (and index.html where the real menu flow matters). Covers:
//   1. ram garrison   — riders board/eject/survive, capacity, the REAL
//                       right-click command shape, loaded-ram speed
//   2. forward-building defense — AI attacks an enemy tower in its town
//   3. walled-archer  — a self-acquired unreachable shooter is disengaged
//                       from, not soaked (fixture: scenarios/walled-archer.savegame.json)
//   4. save v4        — RLE map + derived occupied + explored grids
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
      T.ok('cmd: surplus rider escorts', crew.filter(c => c.followId === ram2.id).length === 1);
      T.ok('cmd: archer follows, never boards', bowman.followId === ram2.id && bowman.task !== 'garrison');
      for (let i = 0; i < 400 && boarding.some(c => !c.garrisonedIn); i++) update();
      T.ok('cmd: all 4 seated', garrisonCount(ram2) === 4);
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
        T.ok('knight stopped taking hits', tick - lastHitAt > 600);
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
      T.ok('v4 stamp', save.version === 4);
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
      for (let i = 0; i < 14000; i++) {
        update();
        if (vil.path.length === 0 && vil.moveGoalX === undefined) {
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
      const offsets = getFormation(n), gs = Math.min(...army.map(m => m.speed || 1));
      army.forEach((s, i) => {
        s.groupSpeed = gs;
        issueMoveOrder(s, 50 + (offsets[i] ? offsets[i][0] : 0), 50 + (offsets[i] ? offsets[i][1] : 0));
      });
      T.ok('every unit got a path', army.every(u => u.path.length > 0 || u.moveGoalX !== undefined));
      for (let i = 0; i < 1500; i++) update();
      const arrived = army.filter(u => Math.hypot(u.x - 50, u.y - 50) < 6).length;
      T.ok(`whole block arrives (${arrived}/${n} >= 38)`, arrived >= 38);
      return T;
    })),

    // ------------------------------- select-all assault on a sealed TC (ex repro)
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
      army.forEach(u => { u.target = tc.id; u.explicitAttack = true; clearUnitPath(u); });
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
