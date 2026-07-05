// Determinism-harness smoke test (js/determinism.js): checksum runs, is a
// stable uint32 for identical state, changes as the sim advances, per-entity
// hashes cover every entity, and the strict-mode Math.random tripwire
// actually traps. (Full replay determinism is asserted by a later suite once
// the seeded PRNG + command queue land.)
const { chromium } = require('playwright');
const { BASE, sleep, check, finish } = require('./helpers');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE + '?autostart');
  await sleep(1500);

  const r = await page.evaluate(async () => {
    const out = {};
    // Stable for identical state, twice in the same synchronous slice.
    const a = simChecksum(), b = simChecksum();
    out.stable = a === b;
    out.uint32 = Number.isInteger(a) && a >= 0 && a <= 0xffffffff;
    out.entityHashCount = simEntityHashes().length === entities.length;

    // Changes as the sim advances.
    DET.enabled = true;
    const before = simChecksum();
    await new Promise(res => setTimeout(res, 1500));
    out.changed = simChecksum() !== before;
    out.historyGrew = DET.history.length > 10;
    out.historyTicksMonotonic = DET.history.every((h, i, arr) => i === 0 || h.tick > arr[i - 1].tick);
    DET.enabled = false;

    // Tripwire mechanism: inside a strict sim section Math.random throws,
    // and is restored afterwards (both by the trap itself and by exit).
    DET.strict = true;
    detEnterSim();
    out.trapped = false;
    try { Math.random(); } catch (e) { out.trapped = /simRandom/.test(e.message); }
    out.restoredAfterTrap = Math.random() >= 0; // must not throw
    detEnterSim(); detExitSim();
    out.restoredAfterExit = Math.random() >= 0;
    DET.strict = false;

    // Command journal scaffolding.
    detStartLog(1234, { mapSize: 'small' });
    detRecordCommand(100, 0, 1, { kind: 'move', tx: 5, ty: 5 });
    const log = JSON.parse(detDumpLog());
    out.journal = log.seed === 1234 && log.commands.length === 1 && log.commands[0].execTick === 100;
    return out;
  });

  check(r.stable, 'checksum stable for identical state');
  check(r.uint32, 'checksum is a uint32');
  check(r.entityHashCount, 'per-entity hashes cover every entity');
  check(r.changed, 'checksum changes as sim advances');
  check(r.historyGrew, 'DET.history collects per-tick checksums');
  check(r.historyTicksMonotonic, 'history ticks strictly increase');
  check(r.trapped, 'strict mode traps Math.random inside sim');
  check(r.restoredAfterTrap, 'Math.random restored after trap fires');
  check(r.restoredAfterExit, 'Math.random restored after detExitSim');
  check(r.journal, 'command journal records and dumps');
  check(errors.length === 0, 'no page errors (' + errors.join('; ') + ')');

  // ---- Same-seed reproducibility across independent pages ----
  // Seed the sim PRNG, regenerate the world, then step the sim 300 ticks
  // synchronously (no rAF interleaving inside one evaluate) and fingerprint
  // map + per-tick checksums. Two pages with the same seed must agree on
  // every tick; a third page with a different seed must not.
  async function seededRun(seed) {
    const p = await browser.newPage();
    p.on('pageerror', e => errors.push('seeded(' + seed + '): ' + String(e)));
    await p.goto(BASE);
    await sleep(800);
    const out = await p.evaluate((seed) => {
      window.__pendingMatchSeed = seed;
      window.fogDisabled = true;
      setMapSize('medium');
      restartGame('standard');
      let mh = 0x811c9dc5;
      for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
        mh = detMix(mh, map[y][x].t); mh = detMix(mh, map[y][x].res || 0);
      }
      const sums = [simChecksum()];
      for (let i = 0; i < 300; i++) { update(); sums.push(simChecksum()); }
      return { mapHash: mh >>> 0, sums: sums, n: entities.length, starts: JSON.stringify(STARTS) };
    }, seed);
    await p.close();
    return out;
  }
  const runA = await seededRun(123456789);
  const runB = await seededRun(123456789);
  const runC = await seededRun(987654321);
  check(runA.mapHash === runB.mapHash, 'same seed: identical map');
  check(runA.starts === runB.starts, 'same seed: identical start corners');
  check(runA.n === runB.n, 'same seed: identical entity count');
  check(runA.sums.length === runB.sums.length && runA.sums.every((s, i) => s === runB.sums[i]),
    'same seed: identical checksum stream over 300 ticks');
  check(runA.mapHash !== runC.mapHash || runA.sums[300] !== runC.sums[300],
    'different seed: different world');
  check(errors.length === 0, 'no page errors in seeded runs (' + errors.join('; ') + ')');

  await browser.close();
  finish();
})();
