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

  await browser.close();
  finish();
})();
