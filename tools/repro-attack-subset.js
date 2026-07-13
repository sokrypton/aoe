#!/usr/bin/env node
// ---- Repro: "only a subset is sent" attacking an inaccessible building ----
// Standing army (N units) on open grass, select-all + attack a team-1 TC sealed
// in a stone-wall ring (no gate). Reports how many units actually ENGAGE (move
// toward / attack the wall) vs. how many stay behind idle at spawn.
// Expected AoE2-ish: the whole army marches to the wall and piles onto the
// reachable segments (spreading to a breach), not just the handful that fit.
//
//   node tools/repro-attack-subset.js [n=40] [ticks=1200] [utype=knight]

const path = require('path');
const { requireChromium, parseArgs, startServer, launchBrowser } = require('./lib/harness');
const chromium = requireChromium();

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const n = parseInt(args.n || '40', 10);
  const ticks = parseInt(args.ticks || '1200', 10);
  const utype = args.utype || 'knight';
  const wall = args.wall || 'SWALL';
  const stance = args.stance || 'aggressive';
  const city = args.city === '1';

  const srv = await startServer('/tools/sim.html');
  const port = srv.address().port;
  const browser = await launchBrowser(chromium, args.headed === '1');
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/tools/sim.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof loadScenario === 'function' && typeof update === 'function');

  const result = await page.evaluate(({ n, ticks, utype, wall, stance, city }) => {
    window.playSound = () => {}; window.showMsg = () => {}; window.updateUI = () => {};
    // Wall ring around either a lone TC (tight ring) or a small CITY (bigger
    // ring + interior buildings). lo/hi are the ring perimeter rows/cols;
    // cx/cy is the enclosure center used by the metrics below.
    const lo = city ? 22 : 26, hi = city ? 39 : 33;
    const cx = (lo + hi) / 2, cy = (lo + hi) / 2;
    const ents = [{ b: 'TC', x: city ? 29 : 28, y: city ? 29 : 28, team: 1 }];
    if (city) {
      ents.push({ b: 'TC', x: 34, y: 34, team: 1 }); // 2nd TC so razing the 1st doesn't end the game
      ents.push({ b: 'HOUSE', x: 24, y: 24, team: 1 });
      ents.push({ b: 'HOUSE', x: 37, y: 24, team: 1 });
      ents.push({ b: 'BARRACKS', x: 24, y: 35, team: 1 });
      ents.push({ b: 'MILL', x: 37, y: 37, team: 1 });
    }
    for (let x = lo; x <= hi; x++) { ents.push({ b: wall, x, y: lo, team: 1 }); ents.push({ b: wall, x, y: hi, team: 1 }); }
    for (let y = lo + 1; y < hi; y++) { ents.push({ b: wall, x: lo, y, team: 1 }); ents.push({ b: wall, x: hi, y, team: 1 }); }
    loadScenario({ map: 'medium', seed: 1, numTeams: 2, controllers: ['human', 'human'], entities: ents });
    gameStarted = true; gamePaused = false; myTeam = 0;

    // Standing army block near (12,12).
    const cols = Math.ceil(Math.sqrt(n));
    const army = [];
    for (let i = 0; i < n; i++) { const u2=createUnit(utype, 10 + (i % cols), 10 + Math.floor(i / cols), 0); u2.stance=stance; army.push(u2); }
    const spawn = army.map(u => ({ x: u.x, y: u.y }));

    // Select-all + attack the TC (exactly execUnitCommand's target branch).
    const tc = entities.find(e => e.type === 'building' && e.btype === 'TC' && e.team === 1);
    selected.length = 0; army.forEach(u => selected.push(u));
    army.forEach(u => {
      u.gatherX = -1; u.gatherY = -1; u.task = null; u.buildTarget = null; u.followId = undefined;
      u.defendX = u.x; u.defendY = u.y; // execUnitCommand sets this on every order
      u.target = tc.id; clearUnitPath(u); u.explicitAttack = true;
    });

    // Count building-damage events per 200-tick window (monkeypatch).
    let dmgWindow = 0; const dmgLog = [];
    const _de = window.damageEntity;
    window.damageEntity = function (a, b) {
      if (b && b.type === 'building' && b.team === 1) dmgWindow++;
      return _de.apply(this, arguments);
    };
    let deepTrace = [];
    let watchU = null; // a stuck unit reference, set after TC death
    window.__probe = null; window.__probeLog = [];
    const trace = [];
    let result_follow = [];
    const everEngaged = new Array(army.length).fill(false); // ever reached the wall ring
    const maxFromSpawn = new Array(army.length).fill(0);
    const minToCenter = new Array(army.length).fill(1e9);
    const tcId = tc.id;
    const isWall = id => { const b = entitiesById.get(id); return b && (b.btype === 'SWALL' || b.btype === 'WALL'); };
    const snaps = [];
    const preChk = [];
    for (let i = 0; i < ticks; i++) {
      if (watchU && preChk.length < 12) {
        preChk.push({ t: i, preInArr: entities.indexOf(watchU) >= 0, preInDb: entitiesById.has(watchU.id),
          preType: watchU.type, preHp: watchU.hp, preCd: watchU.atkCooldown });
      }
      update();
      if (watchU == null && tc.hp <= 0) {
        watchU = army.find(u => {
          if (u.hp <= 0) return false;
          const t = entitiesById.get(u.target);
          return t && t.type === 'building' && t.hp > 0 && adjToBuilding(u.x, u.y, t);
        }) || null;
        if (watchU) { window.__probe = watchU.id; window.__probeLog = []; }
      }
      if (watchU && deepTrace.length < 25) {
        const t = entitiesById.get(watchU.target);
        deepTrace.push({ t: i, cd: watchU.atkCooldown,
          tgt: t ? t.btype : null, tgtHp: t ? Math.round(t.hp) : null,
          adj: t && t.type === 'building' ? adjToBuilding(watchU.x, watchU.y, t) : null,
          d: t ? +distToTarget(watchU, t).toFixed(2) : null,
          task: watchU.task || null, expl: !!watchU.explicitAttack, pl: watchU.path.length,
          stance: watchU.stance, siege: watchU.siegeSpot ? `${watchU.siegeSpot.x},${watchU.siegeSpot.y}` : null,
          pos: `${watchU.x.toFixed(1)},${watchU.y.toFixed(1)}`,
          unreach: watchU.unreachId != null && watchU.unreachUntil > tick,
          inArr: entities.indexOf(watchU) >= 0, inDb: entitiesById.has(watchU.id), stuck: watchU.stuckTicks||0 });
      }
      army.forEach((u, k) => {
        if (u.hp <= 0) return;
        if (Math.hypot(u.x - cx, u.y - cy) < 7) everEngaged[k] = true;
        maxFromSpawn[k] = Math.max(maxFromSpawn[k], Math.hypot(u.x - spawn[k].x, u.y - spawn[k].y));
        minToCenter[k] = Math.min(minToCenter[k], Math.hypot(u.x - cx, u.y - cy));
      });
      if (i <= 400 && (i % 20 === 0)) {
        // follow the 3 back-corner units (most likely stragglers)
        const follow = [army[0], army[1], army[2]].map(u => ({
          p: `${u.x.toFixed(1)},${u.y.toFixed(1)}`, pl: u.path ? u.path.length : 0,
          tg: u.target === tcId ? 'TC' : (isWall(u.target) ? 'W' : (u.target == null ? '-' : '?')),
          un: (u.unreachId != null && u.unreachUntil > tick) ? 1 : 0,
          st: u.stuckTicks || 0,
        }));
        (result_follow = result_follow || []).push({ t: i, follow });
      }
      if (i < 120 && (i % 10 === 0)) {
        let onTC = 0, onWall = 0, none = 0, other = 0, withPath = 0, moved = 0;
        army.forEach((u, k) => {
          if (u.hp <= 0) return;
          if (u.target === tcId) onTC++;
          else if (isWall(u.target)) onWall++;
          else if (u.target == null) none++;
          else other++;
          if (u.path && u.path.length) withPath++;
          if (Math.hypot(u.x - spawn[k].x, u.y - spawn[k].y) > 2) moved++;
        });
        trace.push({ t: i, onTC, onWall, none, other, withPath, moved });
      }
      if (i % 200 === 0 || i === ticks - 1) {
        let engaged = 0, idleAtSpawn = 0, moving = 0;
        army.forEach((u, k) => {
          if (u.hp <= 0) return;
          const movedFromSpawn = Math.hypot(u.x - spawn[k].x, u.y - spawn[k].y) > 3;
          const nearWall = Math.hypot(u.x - cx, u.y - cy) < 6; // near the ring
          const hasPath = u.path && u.path.length > 0;
          if (hasPath) moving++;
          if (nearWall) engaged++;
          if (!movedFromSpawn && !hasPath) idleAtSpawn++;
        });
        let idle = 0, inside = 0;
        army.forEach(u => {
          if (u.hp <= 0) return;
          if (u.target == null && (!u.path || u.path.length === 0)) idle++;
          if (u.x >= lo && u.x <= hi && u.y >= lo && u.y <= hi) inside++;
        });
        const walls = entities.filter(e => e.type === 'building' && (e.btype === 'WALL' || e.btype === 'SWALL'));
        const wl = walls.length;
        const whp = Math.round(walls.reduce((s, w) => s + w.hp, 0));
        const bldgs = entities.filter(e => e.type === 'building' && e.team === 1 && e.hp > 0 && !isWall(e.id)).length;
        snaps.push({ tick: i, engaged, moving, idleAtSpawn, idle, inside,
          tcHp: Math.round(tc.hp), wallsLeft: wl, wallHp: whp, otherBldgs: bldgs,
          bldgDmgHits: dmgWindow,
          alive: army.filter(u => u.hp > 0).length });
        dmgWindow = 0;
      }
    }
    // Final classification of every unit that never reached the wall.
    const stragglers = army.filter(u => u.hp > 0 && Math.hypot(u.x - cx, u.y - cy) >= 6).map((u, _) => ({
      pos: `${u.x.toFixed(1)},${u.y.toFixed(1)}`,
      pathLen: u.path ? u.path.length : 0,
      tgt: u.target, tgtType: (entitiesById.get(u.target) || {}).btype || null,
      unreach: u.unreachId != null && u.unreachUntil > tick,
      stuck: u.stuckTicks || 0,
    }));

    return {
      n, alive: army.filter(u => u.hp > 0).length,
      trace, follow: result_follow, watchId: watchU ? watchU.id : null,
      probeLog: (window.__probeLog||[]).slice(0,30), preChk,
      engagedThenLeft: army.map((u, k) => ({ k, engaged: everEngaged[k], alive: u.hp > 0,
          endDistWall: +Math.hypot(u.x - cx, u.y - cy).toFixed(1),
          endPos: `${u.x.toFixed(0)},${u.y.toFixed(0)}` }))
        .filter(o => o.alive && o.engaged && o.endDistWall >= 9),
      snaps, stragglerCount: stragglers.length, stragglers: stragglers.slice(0, 20),
      perUnit: army.map((u, k) => ({ k, spawn: `${spawn[k].x},${spawn[k].y}`,
        end: `${u.x.toFixed(0)},${u.y.toFixed(0)}`, alive: u.hp > 0,
        maxFromSpawn: +maxFromSpawn[k].toFixed(1), minToCenter: +minToCenter[k].toFixed(1),
        endToCenter: +Math.hypot(u.x - cx, u.y - cy).toFixed(1) })),
      endState: (() => {
        let idle = 0, onTC = 0, onWall = 0, onOther = 0, inside = 0;
        army.forEach(u => {
          if (u.hp <= 0) return;
          const t = entitiesById.get(u.target);
          if (u.x >= lo && u.x <= hi && u.y >= lo && u.y <= hi) inside++;
          if (u.target == null && (!u.path || u.path.length === 0)) idle++;
          else if (u.target === tcId) onTC++;
          else if (isWall(u.target)) onWall++;
          else if (u.target != null) onOther++;
        });
        return { idle, onTC, onWall, onOther, inside,
          tcHp: Math.round(tc.hp), tcMaxHp: tc.maxHp,
          wallsLeft: entities.filter(e => e.type === 'building' && (e.btype === 'WALL' || e.btype === 'SWALL')).length };
      })(),
      endUnits: army.filter(u => u.hp > 0).map(u => {
        const t = entitiesById.get(u.target);
        return {
          pos: `${u.x.toFixed(0)},${u.y.toFixed(0)}`,
          tgt: t ? (t.btype || t.utype) : (u.target == null ? 'idle' : 'deadTgt'),
          tgtAlive: t ? t.hp > 0 : false,
          d: t ? +distToTarget(u, t).toFixed(1) : null,
          adj: t && t.type === 'building' ? adjToBuilding(u.x, u.y, t) : null,
          pathLen: u.path ? u.path.length : 0,
          unreach: u.unreachId != null && u.unreachUntil > tick,
          explicit: !!u.explicitAttack, gar: !!u.garrisonedIn, inDb: entitiesById.has(u.id),
        };
      }),
      jsErrors: (window.health && window.health.jsErrors) || 0,
    };
  }, { n, ticks, utype, wall, stance, city });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  srv.close();
})();
