#!/usr/bin/env node
// Save-file watch: load a save, run it headless, report how each team's units spend their time.
//   node tools/watch-save.js save=aoe-save-….json [ticks=6000] [every=20] [root=<other checkout>]
// Per team: villager working / idle / sheltered / walking %, soldier fighting / wall-bash / moving / idle %,
// trade carts moving / idle %, units stuck (a target, path or task but no movement for 1 000+ ticks; how many of
// them at a gate), banked resources; plus the worst tick time and
// the final checksum. root= runs another checkout's engine on the same save (a baseline for A/B).
const fs = require('fs');
const path = require('path');
const { requireChromium, parseArgs } = require('./lib/harness');
const a = parseArgs(process.argv.slice(2));
if (!a.save) { console.error('usage: node tools/watch-save.js save=<file.json> [ticks=6000] [every=20] [root=<dir>]'); process.exit(2); }
const root = path.resolve(a.root || path.join(__dirname, '..'));
const { startServer, launchBrowser } = require(path.join(root, 'tools/lib/harness'));
const TICKS = +(a.ticks || 6000), EVERY = +(a.every || 20);
const save = fs.readFileSync(path.resolve(a.save), 'utf8');

(async () => {
  const srv = await startServer('/index.html');
  const browser = await launchBrowser(requireChromium(), false);
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  await ctx.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }); });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.address().port}/index.html?view=2d`);
  await page.waitForFunction(() => typeof loadGame === 'function');
  await page.evaluate(d => { loadGame(JSON.parse(d)); gamePaused = true; }, save);
  const report = await page.evaluate(({ TICKS, EVERY }) => {
    const WALLISH = b => /WALL|GATE|TOWER/.test(b.btype);
    const teams = {}, last = new Map(), still = new Map(), stuck = new Map(), times = [];
    const T = t => teams[t] || (teams[t] = { vil: { n: 0, work: 0, idle: 0, shelter: 0, walk: 0 },
      army: { n: 0, fight: 0, wallBash: 0, move: 0, idle: 0 }, carts: { n: 0, move: 0, idle: 0 } });
    const nearGate = e => entities.some(b => b.type === 'building' && isGateBtype(b.btype) && distToBuilding(e.x, e.y, b) <= 2);
    const t0 = tick;
    for (let i = 0; i < TICKS; i++) {
      const s = performance.now(); update(); times.push(performance.now() - s);
      if (i % EVERY) continue;
      for (const e of entities) {
        if (e.type !== 'unit' || e.hp <= 0 || !isPlayerTeam(e.team)) continue;
        const busy = !!(e.target || e.path.length || e.task);
        if (e.utype === 'villager') {
          const v = T(e.team).vil; v.n++;
          if (e.garrisonedIn || e.task === 'garrison') v.shelter++;
          else if (e.task && !e.path.length) v.work++;
          else if (e.path.length) v.walk++;
          else v.idle++;
        } else if (MILITARY.has(e.utype) || e.utype === 'ram') {
          if (e.garrisonedIn) continue;
          const m = T(e.team).army, t = e.target && entitiesById.get(e.target); m.n++;
          if (t && t.type === 'building' && WALLISH(t)) m.wallBash++;
          else if (t) m.fight++;
          else if (e.path.length) m.move++;
          else m.idle++;
        } else if (e.utype === 'tradecart') {
          const c = T(e.team).carts; c.n++;
          if (e.path.length) c.move++; else c.idle++;
        } else continue;
        if (e.garrisonedIn) { still.delete(e.id); continue; }
        // stuck: busy (a target, a path or a task) yet on the same spot for 1 000+ ticks — not a farmer or a builder at work
        const p = last.get(e.id), here = Math.round(e.x * 2) + ',' + Math.round(e.y * 2);
        last.set(e.id, here);
        const tg = e.target && entitiesById.get(e.target);
        const working = (e.utype === 'villager' && e.task && !e.path.length) || (tg && inWeaponRange(e, tg));   // (a farmer, a builder, a unit hitting its target)
        if (p === here && busy && !working) {
          const since = still.get(e.id) ?? tick; still.set(e.id, since);
          if (tick - since >= 1000) stuck.set(e.id, { id: e.id, team: e.team, utype: e.utype, x: Math.round(e.x), y: Math.round(e.y),
            target: e.target && entitiesById.get(e.target) ? (entitiesById.get(e.target).btype || entitiesById.get(e.target).utype) : null,
            task: e.task || null, ticks: tick - since, gate: nearGate(e) });
        } else { still.delete(e.id); stuck.delete(e.id); }
      }
    }
    const pct = (o) => { const r = { n: +(o.n / Math.ceil(TICKS / EVERY)).toFixed(1) };
      for (const k in o) if (k !== 'n') r[k] = o.n ? Math.round(100 * o[k] / o.n) : 0; return r; };
    const out = {};
    for (const t in teams) {
      const left = entities.some(e => e.team === +t && e.hp > 0 && (e.type === 'unit' || e.type === 'building'));
      out[t] = { villagers: pct(teams[t].vil), army: pct(teams[t].army), carts: pct(teams[t].carts),
        stuck: [...stuck.values()].filter(s => s.team === +t).length,
        stuckAtGates: [...stuck.values()].filter(s => s.team === +t && s.gate).length,
        bank: resources[t] ? Object.fromEntries(Object.entries(resources[t]).map(([k, v]) => [k, Math.round(v)])) : null,
        alive: left };
    }
    times.sort((x, y) => x - y);
    return { from: t0, to: tick, teams: out, stuckUnits: [...stuck.values()].slice(0, 20),
      tickMs: { median: +times[times.length >> 1].toFixed(2), p99: +times[Math.floor(times.length * 0.99)].toFixed(1), max: +times[times.length - 1].toFixed(1) },
      checksum: simChecksum() };
  }, { TICKS, EVERY });
  report.errors = errors.slice(0, 5);
  console.log(JSON.stringify(report, null, 1));
  await browser.close(); srv.close();
})();
