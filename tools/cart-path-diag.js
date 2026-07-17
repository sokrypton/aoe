// One-off diagnostic: load a save, and for every team-0 trade cart compare the
// current-code findPath (A*, iteration-capped) against a full uncapped Dijkstra
// ground-truth of the true shortest walk to its target Market. A gap = the cart
// is NOT taking the shortest path (iteration-cap truncation / detour).
const path = require('path');
const fs = require('fs');
const { requireChromium, startServer, launchBrowser } = require('./lib/harness.js');

(async () => {
  const chromium = requireChromium();
  const srv = await startServer('/tools/sim.html');
  const port = srv.address().port;
  const browser = await launchBrowser(chromium, false);
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://127.0.0.1:${port}/tools/sim.html`);
  await page.waitForFunction(() => typeof loadGame === 'function' && typeof findPath === 'function' && typeof walkable === 'function');
  const saveText = fs.readFileSync(path.resolve(__dirname, '..', 'aoe-save-2026-07-17T01-14-20-864Z.json'), 'utf8');

  const result = await page.evaluate((saveText) => {
    loadGame(JSON.parse(saveText));
    const dijkstra = (sx, sy, goal, ignore) => {
      const N = MAP * MAP, dist = new Float64Array(N).fill(Infinity), heap = [];
      const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { let l = 2 * k + 1, r = 2 * k + 2, m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break;[heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top; };
      dist[sx + sy * MAP] = 0; push(0, sx + sy * MAP);
      while (heap.length) {
        const [d, idx] = pop(); if (d > dist[idx]) continue;
        const x = idx % MAP, y = (idx / MAP) | 0;
        if (adjToBuilding(x, y, goal)) return d;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= MAP || ny >= MAP) continue;
          if (!walkable(nx, ny, ignore)) continue;
          if (dx && dy && (!walkable(x + dx, y, ignore) || !walkable(x, y + dy, ignore))) continue;
          const nd = d + (dx && dy ? 1.41 : 1), ni = nx + ny * MAP;
          if (nd < dist[ni]) { dist[ni] = nd; push(nd, ni); }
        }
      }
      return Infinity;
    };
    const out = [];
    const carts = entities.filter(e => (e.btype === 'tradecart' || e.utype === 'tradecart') && e.team === 0 && (e.tradeHomeId != null || e.tradeDestId != null));
    for (const c of carts) {
      // test BOTH legs: to the target market (current phase) AND the other one
      for (const which of ['home', 'dest']) {
      const goal = entitiesById.get(which === 'dest' ? c.tradeDestId : c.tradeHomeId);
      if (!goal) continue;
      const sx = Math.round(c.x), sy = Math.round(c.y);
      const cost = (pth, x0, y0) => { let a = 0, px = x0, py = y0; for (const s of pth) { a += (s.x !== px && s.y !== py) ? 1.41 : 1; px = s.x; py = s.y; } return { a, ex: px, ey: py }; };
      // NEW: goalBldg A* (cheapest-walk edge)
      const pNew = findPath(sx, sy, goal.x, goal.y, c.id, 0, goal);
      const rNew = cost(pNew, sx, sy);
      // OLD: Manhattan-nearest perimeter tile, then path to that exact tile
      const pt = nearestBldgPerimeter(sx, sy, goal, c.id);
      const pOld = findPath(sx, sy, pt.x, pt.y, c.id);
      const rOld = cost(pOld, sx, sy);
      const truth = dijkstra(sx, sy, goal, c.id);
      out.push({ id: c.id, leg: which, from: [sx, sy], goal: [goal.x, goal.y], goalTeam: goal.team,
        shortest: isFinite(truth) ? +truth.toFixed(1) : null,
        newA: +rNew.a.toFixed(1), newReached: adjToBuilding(rNew.ex, rNew.ey, goal),
        oldA: +rOld.a.toFixed(1), oldReached: adjToBuilding(rOld.ex, rOld.ey, goal) });
      }
    }
    return { map: MAP, carts: out };
  }, saveText);

  console.log('MAP', result.map, '  (shortest = uncapped Dijkstra ground-truth; only distinct cart shown once per leg)');
  const seen = new Set();
  result.carts.forEach(c => {
    const key = c.id + c.leg; if (seen.has(key)) return; seen.add(key);
    const s = c.shortest;
    console.log(
      `cart#${c.id} →${c.leg}(team${c.goalTeam})@${JSON.stringify(c.goal)} from ${JSON.stringify(c.from)} | shortest=${s == null ? 'UNREACHABLE' : s}` +
      (s == null ? '' : ` | NEW=${c.newA}${c.newReached ? '' : '(PARTIAL)'} +${(c.newA - s).toFixed(1)} | OLD=${c.oldA}${c.oldReached ? '' : '(PARTIAL)'} +${(c.oldA - s).toFixed(1)}`)
    );
  });
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
