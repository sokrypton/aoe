#!/usr/bin/env node
// ---- Repro: attacking an unreachable (walled-off) target ----
// Loads scenarios/unreachable-attack.json in the full engine, orders the
// team-0 army to ATTACK the sealed-in enemy TC (as a human right-click would),
// then steps the sim and reports the behavior we care about:
//   - do the units march to the wall and attack it (breach), or storm the
//     pathfinder and freeze?
//   - per-tick ms (the perf-storm canary)
//   - are any targets flagged unreachable (unreachId), and do units end up
//     hitting the wall / breaching into the TC?
// Expected AoE2 behavior: get as close as possible, attack what's blocking you
// (the wall), pour through the breach — never an infinite repath.
//
//   node tools/repro-unreachable.js [ticks=4000] [headed=1]

const path = require('path');
const { requireChromium, parseArgs, startServer, launchBrowser } = require('./lib/harness');
const fs = require('fs');
const chromium = requireChromium();

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const ticks = parseInt(args.ticks || '4000', 10);
  const file = args.scenario === 'island' ? 'unreachable-island.json' : 'unreachable-attack.json';
  const specText = fs.readFileSync(path.join(__dirname, '..', 'scenarios', file), 'utf8');
  const spec = JSON.parse(specText); // _comment is an ignored key

  const srv = await startServer('/tools/sim.html');
  const port = srv.address().port;
  const browser = await launchBrowser(chromium, args.headed === '1');
  const page = await browser.newPage();
  page.on('console', m => { const t = m.text(); if (/error|Error|NaN|undefined is not/.test(t)) console.log('[page]', t); });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/tools/sim.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof loadScenario === 'function' && typeof update === 'function');

  const result = await page.evaluate(({ spec, ticks }) => {
    window.playSound = () => {}; window.showMsg = () => {}; window.updateUI = () => {};
    loadScenario(spec);
    gameStarted = true; gamePaused = false;

    // Issue the human attack order: every team-0 military unit targets the TC.
    const tc = entities.find(e => e.type === 'building' && e.btype === 'TC' && e.team === 1);
    const army = entities.filter(e => e.type === 'unit' && e.team === 0);
    army.forEach(u => {
      u.target = tc.id; u.explicitAttack = true; u.task = null;
      if (typeof clearUnitPath === 'function') clearUnitPath(u);
    });

    const tcMaxHp = tc.hp;
    const wallStart = entities.filter(e => e.type === 'building' && e.btype === 'SWALL').reduce((s, w) => s + w.hp, 0);
    const wallCount0 = entities.filter(e => e.type === 'building' && e.btype === 'SWALL').length;

    let maxMs = 0, sumMs = 0, slowTicks = 0;
    const samples = [];
    for (let i = 0; i < ticks; i++) {
      const t0 = performance.now();
      update();
      const dt = performance.now() - t0;
      sumMs += dt; if (dt > maxMs) maxMs = dt; if (dt > 2) slowTicks++;
      if (i % 500 === 0 || i === ticks - 1) {
        const wallNow = entities.filter(e => e.type === 'building' && e.btype === 'SWALL');
        const unreach = entities.filter(e => e.type === 'unit' && e.team === 0 && e.unreachId != null && e.unreachUntil > tick).length;
        const attackingWall = entities.filter(e => e.type === 'unit' && e.team === 0 && (() => { const t = entitiesById.get(e.target); return t && t.type === 'building' && (t.btype === 'SWALL'); })()).length;
        const attackingTC = entities.filter(e => e.type === 'unit' && e.team === 0 && e.target === tc.id).length;
        const byType = {};
        entities.filter(e => e.type === 'unit' && e.team === 0 && e.hp > 0).forEach(e => {
          const tgt = entitiesById.get(e.target);
          const what = !tgt ? 'none' : (tgt.id === tc.id ? 'TC' : (tgt.btype === 'SWALL' ? 'wall' : tgt.btype || tgt.utype));
          byType[e.utype] = byType[e.utype] || {};
          byType[e.utype][what] = (byType[e.utype][what] || 0) + 1;
        });
        samples.push({
          tick: i,
          tcHp: Math.round(tc.hp),
          wallHp: wallNow.reduce((s, w) => s + w.hp, 0),
          wallsLeft: wallNow.length,
          unreach, attackingWall, attackingTC,
          armyAlive: entities.filter(e => e.type === 'unit' && e.team === 0 && e.hp > 0).length,
          byType,
          meleePos: entities.filter(e => e.type === 'unit' && e.team === 0 && e.hp > 0 && (UNITS[e.utype].range || 0) === 0)
            .map(e => `${e.utype[0]}(${e.x.toFixed(0)},${e.y.toFixed(0)})`).join(' '),
        });
      }
    }
    return {
      tcMaxHp, wallStart, wallCount0,
      tcHpEnd: Math.round(tc.hp), tcDead: tc.hp <= 0,
      maxMs: +maxMs.toFixed(3), avgMs: +(sumMs / ticks).toFixed(4), slowTicks,
      samples,
      jsErrors: (window.health && window.health.jsErrors) || 0,
    };
  }, { spec, ticks });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  srv.close();
})();
