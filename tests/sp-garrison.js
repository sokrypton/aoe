// Single-player town-bell regression test. Guards the exact failure that
// shipped once: updateUnit's garrison branch returned WITHOUT running the
// movement step further down the function, so any belled villager not
// already within arrival radius of the TC froze mid-approach ("only one
// goes in, the rest stand outside"). Villagers here are deliberately
// spawned/sent BEYOND the arrival radius, across multiple bell cycles.
const { chromium } = require('playwright');
const { BASE, sleep, check, finish } = require('./helpers');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(BASE + '?autostart');
  await sleep(1500);

  const cycles = await page.evaluate(async () => {
    const tc = entities.find(e => e.btype === 'TC' && e.team === 0);
    resources[0].food = 1000;
    while (entities.filter(e => e.utype === 'villager' && e.team === 0).length < 8) {
      const v = entities.find(e => e.utype === 'villager' && e.team === 0);
      const spawn = findSpawnTile(tc.x + tc.w, tc.y + tc.h, 6);
      const n = { ...v, id: nextId++, x: spawn.x, y: spawn.y, fromX: spawn.x, fromY: spawn.y,
        path: [], target: null, task: null, gatherX: -1, gatherY: -1, carrying: 0,
        savedTask: null, garrisonTarget: null, garrisonedIn: undefined };
      entities.push(n); entitiesById.set(n.id, n);
    }
    // One villager working FAR away with a FULL load — covers the historic
    // "walks its wood to the drop-off through the raid" detour bug too.
    let fx, fy;
    outer: for (let y = 1; y < MAP - 1; y++) for (let x = 1; x < MAP - 1; x++) {
      if (map[y][x].t === TERRAIN.FOREST && map[y][x].res > 0) { fx = x; fy = y; break outer; }
    }
    const vs = entities.filter(e => e.utype === 'villager' && e.team === 0);
    vs[0].task = 'chop'; vs[0].gatherX = fx; vs[0].gatherY = fy;
    vs[0].carrying = 10; vs[0].carryType = 'wood'; vs[0].carryMax = 10;

    const out = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      toggleTownBell();
      await new Promise(r => setTimeout(r, 9000));
      const vils = entities.filter(e => e.utype === 'villager' && e.team === 0);
      out.push({
        garrisoned: vils.filter(v => v.garrisonedIn).length,
        total: vils.length,
        stuck: vils.filter(v => !v.garrisonedIn && v.task === 'garrison').length
      });
      toggleTownBell(); // all clear
      await new Promise(r => setTimeout(r, 3000));
      const after = entities.filter(e => e.utype === 'villager' && e.team === 0);
      out[out.length - 1].releasedAll = after.every(v => !v.garrisonedIn);
    }
    return out;
  });

  cycles.forEach((c, i) => {
    check(c.garrisoned === c.total && c.stuck === 0,
      `bell cycle ${i}: all ${c.total} villagers garrisoned (got ${c.garrisoned}, ${c.stuck} stuck)`);
    check(c.releasedAll, `bell cycle ${i}: all-clear released everyone`);
  });
  check(errors.length === 0, 'no page errors (' + errors.join(' | ') + ')');
  await browser.close();
  finish();
})();
