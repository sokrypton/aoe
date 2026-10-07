// ---- RENDERING ----

// Offscreen-culling check for a point already in pre-scale/logical screen
// space (before render()'s translate/scale(ZOOM)/translate transform is
// applied). The actual visible logical window grows/shrinks with 1/ZOOM
// (zooming out reveals more world), so the margin must scale with it too —
// a fixed-pixel margin here would wrongly cull tiles/entities that are
// genuinely on screen once zoomed out.
function isOffscreen(sx, sy, margin){
  let halfW = (W/2)/ZOOM + margin;
  let halfH = (H/2)/ZOOM + margin;
  let cy = H/2 + topH;
  return sx < W/2-halfW || sx > W/2+halfW || sy < cy-halfH || sy > cy+halfH;
}

// Returns the effective fog level for a building across its whole footprint:
//   0 = all tiles unexplored (skip drawing)
//   1 = some explored but none currently visible (draw with shadow)
//   2 = at least one tile actively visible (draw normally)
// Memoized per building until the fog actually changes (updateFog in
// js/core.js calls invalidateBuildingFogMemo) — otherwise the w×h tile scan
// re-runs 2-3× per building per FRAME (render collect + draw loops, outline
// extent, minimap), pure waste since fog only mutates once per tick.
let _bflMemo = new Map();
function invalidateBuildingFogMemo(){ _bflMemo.clear(); }
function buildingFogLevel(e) {
  let memo = _bflMemo.get(e.id);
  if (memo !== undefined) return memo;
  let b = BLDGS[e.btype];
  let w = e.w !== undefined ? e.w : (b ? b.w : 1);
  let h = e.h !== undefined ? e.h : (b ? b.h : 1);
  let maxF = 0;
  outer: for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) {
      let tf = (fog[e.y+dy] && fog[e.y+dy][e.x+dx]) || 0;
      if (tf > maxF) maxF = tf;
      if (maxF === 2) break outer;
    }
  _bflMemo.set(e.id, maxF);
  return maxF;
}

// The gold / stone / berry art standing on a tile, ground point (sx, cy).
// Shared by the map (drawTile) and the 3D eye view's billboards (js/pov3d.js).
// ---- Gold and stone: pov3d's ore boulders (refreshFeatures), projected ----
// Per tile a main boulder and two smaller ones round it, each a low seven-sided spun rock, flat-shaded by the 3D's
// light, worn lower as the deposit is mined. Drawn once per tile, state and zoom into a small cached image.
const ORE_PROFILE = [[0, 0], [0.95, 0], [1.02, 0.35], [0.82, 0.74], [0.4, 0.98], [0, 1]];
const oreCache = new Map();
const srgbToLin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const linToSrgb = c => Math.round(255 * Math.min(1, c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
// a face lit as the 3D lights it: ambient 0.69, the sun (0, 0.36, 0.31) — the left (+z) face its own colour, the top brighter
const oreLit = (hex, n) => { const l = Math.hypot(...n), f = 0.69 + Math.max(0, (0.36 * n[1] + 0.31 * n[2]) / l), v = parseInt(hex.slice(1), 16);
  return 'rgb(' + [v >> 16, (v >> 8) & 255, v & 255].map(c => linToSrgb(srgbToLin(c) * f)).join(',') + ')'; };
// A fixed 0..1 value per tile and channel n: natural variety that never flickers (both views)
function tileHash(x, y, n){ let v = (x * 73856093) ^ (y * 19349663) ^ (n * 83492791); v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; }
function drawOreTile(t, x, y, sx, cy){
  const gold = t.t === TERRAIN.GOLD, lvl = Math.round(Math.min(1, t.res / (gold ? 800 : 350)) * 16), sc = Math.max(0.25, Math.round((Math.abs(X.getTransform().a) || 1) * 8) / 8);   // (the zoom in eighths: a pinch reuses the images)
  const key = x + ',' + y + ',' + gold + ',' + lvl + ',' + sc.toFixed(2), W = 96, H = 72, OX = 48, OY = 52;
  let c = oreCache.get(key);
  if (!c) { if (oreCache.size > 3000) oreCache.clear(); c = document.createElement('canvas'); c.width = Math.ceil(W * sc); c.height = Math.ceil(H * sc);
    const Y = c.getContext('2d'); Y.scale(sc, sc); Y.translate(OX, OY); const keep = X; X = Y; oreRocks(gold, lvl / 16, x, y); X = keep; oreCache.set(key, c); }
  X.drawImage(c, sx - OX, cy - OY, W, H);
}
// (in the cached image: the tile's centre at the origin, screen px; the 3D's numbers, in tiles — heights ×√3/2, the 2:1
// view's 30° elevation)
// One ore boulder q {bx, bz (tiles, its foot), ax, ay, az (half-width, height, half-depth), rot, col} at the origin:
// the 3D's low seven-sided spun rock, flat-shaded by its light, outlined (lw: half of it under the facets)
// A lone boulder at the origin (a camp's heap: q.bx = q.bz = 0) is the same rock every frame: baked once per shape and
// device scale, then blitted (oreRocks' whole tile is cached already: oreCache)
const _boulderArt = new Map();
function oreBoulder(q, lw = 3){
  if (!q.bx && !q.bz && !window._maskDraw) {
    const m = X.getTransform(), sc = Math.max(1, Math.ceil(Math.hypot(m.a, m.b) - 1e-6));
    const T = HALF_TW * Math.SQRT2, rr = Math.max(q.ax, q.az) * T * 1.2 + lw + 2, up = q.ay * T * Math.sqrt(3) / 2 + rr;
    const key = q.ax + ',' + q.ay + ',' + q.az + ',' + q.rot + ',' + q.col + ',' + lw + '|' + sc;
    let c = _boulderArt.get(key);
    if (!c) { if (_boulderArt.size > 500) _boulderArt.clear();
      c = document.createElement('canvas'); c.width = Math.ceil(2 * rr * sc); c.height = Math.ceil((up + rr) * sc);
      const cx = c.getContext('2d'); cx.scale(sc, sc); cx.translate(rr, up);
      const sv = X; X = cx; try { oreBoulderPaint(q, lw); } finally { X = sv; }
      _boulderArt.set(key, c); }
    X.drawImage(c, -rr, -up, 2 * rr, up + rr);
    return;
  }
  oreBoulderPaint(q, lw);
}
function oreBoulderPaint(q, lw){
  const T = HALF_TW * Math.SQRT2, TH3 = T * Math.sqrt(3) / 2, k = projKit(0), cr = Math.cos(q.rot), sr = Math.sin(q.rot);
  // the spun profile's rings (three's LatheGeometry: x = r·sin φ, z = r·cos φ), scaled, turned, placed — in tiles
  const ring = ORE_PROFILE.map(([pr, py]) => Array.from({ length: 7 }, (_, i) => { const ph = i / 7 * 2 * Math.PI, lx = pr * Math.sin(ph) * q.ax, lz = pr * Math.cos(ph) * q.az;
    return [q.bx + lx * cr + lz * sr, py * q.ay, q.bz - lx * sr + lz * cr]; }));
  const S = ring.map(rw => rw.map(([a, b, c2]) => k.P(a * T, b * TH3, c2 * T))), hull = loadHull(S.flat());
  X.beginPath(); X.moveTo(...hull[0]); for (const h of hull.slice(1)) X.lineTo(...h); X.closePath(); X.strokeStyle = '#000'; X.lineWidth = lw; X.lineJoin = 'round'; X.stroke();
  for (let j = 1; j < ring.length - 1; j++) for (let i = 0; i < 7; i++) { const i2 = (i + 1) % 7, A = ring[j][i], Bq = ring[j][i2], C = ring[j + 1][i2];
    const u = [Bq[0] - A[0], Bq[1] - A[1], Bq[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const mx = (A[0] + C[0]) / 2 - q.bx, mz = (A[2] + C[2]) / 2 - q.bz; if (n[0] * mx + n[2] * mz + n[1] * 0.3 < 0) n = n.map(e => -e);   // (outward)
    if (k.faces(n) <= 0) continue;
    const P4 = [S[j][i], S[j][i2], S[j + 1][i2], S[j + 1][i]]; X.beginPath(); X.moveTo(...P4[0]); for (const h of P4.slice(1)) X.lineTo(...h); X.closePath();
    X.fillStyle = oreLit(q.col, n); X.fill(); X.strokeStyle = X.fillStyle; X.lineWidth = 0.5; X.stroke(); }   // (its own colour round the edge: no hairline seams)
}
function oreRocks(gold, p, x, y){
  const T = HALF_TW * Math.SQRT2, TH3 = T * Math.sqrt(3) / 2, k = projKit(0), r = n => tileHash(x, y, n), size = 0.85 + 0.25 * r(20), kh = 0.25 + 0.75 * p, w = 0.8 + 0.2 * p;
  const cols = gold ? ['#e8b90f', '#d1a017', '#c99815'] : ['#9d9d9d', '#8c8c8c', '#95958f'];
  const B = [[0.19, 0.32, 1.08, 0.94], [0.11, 0.2, 0.94, 1.06], [0.1, 0.18, 1, 0.92]];   // [half, height, x-, z-stretch]: fat and squat
  const V = B.map((_, i) => size * (0.9 + r(4 + i * 5) * 0.2)), R = B.map(([half, , sx, sz], i) => half * Math.max(sx, sz) * w * V[i] * 1.02);
  const a1 = r(31) * 2 * Math.PI, rocks = B.map(([half, h, sx, sz], i) => {
    let bx = 0, bz = 0;
    if (i) { const a = i === 1 ? a1 : a1 + 1.2 + r(32) * (2 * Math.PI - 2.4), d = R[0] + R[i] + 0.03 + r(33 + i) * 0.05; bx = d * Math.cos(a); bz = d * Math.sin(a); }
    return { bx, bz, ax: half * sx * w * V[i], ay: h * kh * size * (0.9 + r(3 + i * 5) * 0.2), az: half * sz * w * V[i], rot: i * 0.7 + r(5 + i * 5) * 6.283, col: cols[i], R: R[i], half, v: V[i] }; });
  rocks.sort((a, b) => k.depth(a.bx, a.bz) - k.depth(b.bx, b.bz));
  for (const q of rocks) { const g = k.P(q.bx * T, 0, q.bz * T); X.fillStyle = 'rgba(0,0,0,0.22)'; X.beginPath(); X.ellipse(g[0], g[1], q.R * T * 1.05, q.R * T * 0.55, 0, 0, Math.PI * 2); X.fill(); }   // its shadow on the ground
  for (const q of rocks) {
    oreBoulder(q);
    if (gold) for (const [u, v] of q === rocks.find(o => o.half === 0.19) ? [[0.3, -0.2], [-0.35, 0.3]] : [[0.1, 0.1]]) {   // glints on the gold (the 3D's spots)
      const g = k.P((q.bx + u * q.half * q.v) * T, q.ay * 1.02 * TH3, (q.bz + v * q.half * q.v) * T), rr = (q.half === 0.19 ? 2.6 : 1.8) * size;
      X.fillStyle = '#fff8dc'; X.strokeStyle = 'rgba(120,80,0,0.5)'; X.lineWidth = 0.6; X.beginPath();
      for (let n = 0; n < 8; n++) { const a = n / 8 * 2 * Math.PI - Math.PI / 2, m = n % 2 ? rr * 0.4 : rr; X.lineTo(g[0] + Math.cos(a) * m, g[1] + Math.sin(a) * m); }
      X.closePath(); X.fill(); X.stroke(); }
  }
}
// ---- The berry bush: pov3d's (refreshFeatures), projected, cel-shaded as the trees ----
// A low mound of leaf puffs (three tiers), stripped in two steps as it's picked; berries on the leaves' upper sides,
// picked one by one (seeded per tile). Puffs and berries sorted by depth together: a berry round the back stays hidden.
const BUSH_PUFFS = [[-7, 0, 5.5, 0], [7, 0, 5, 0], [0, 0.07, 6.5, 0], [0, -0.1, 5.5, 0], [-3.5, 0, 5, 1], [4, -0.04, 4.5, 1], [0, 0, 4.5, 2]];   // [screen-x px, depth (tiles), r px, tier]
function drawBerryBush(t, x, y, sx, cy){
  const p = Math.min(1, t.res / 125), seed = x * 7 + y * 13, S = Math.SQRT1_2;
  const scr = (dx, dy, dz) => [sx + (dx - dz) * HALF_TW, cy + (dx + dz) * HALF_TH - dy * TREE_HPX, dx + dz];
  const puffs = BUSH_PUFFS.slice(0, p <= 0.33 ? 4 : p <= 0.66 ? 6 : 7).map(([px, depth, rPx, tier]) => { const r = rPx / TREE_PX;
    return { dx: px / TREE_PX * S + depth * S, dz: -px / TREE_PX * S + depth * S, dy: r * 0.8 + tier * 0.085, r }; });
  const items = puffs.map(q => ({ q, s: scr(q.dx, q.dy, q.dz), rr: q.r * TREE_PX }));
  for (let i = 0, n = Math.round(12 * p); i < n; i++) { const q = puffs[(seed + i * 5) % puffs.length], a = (seed + i) * 2.39996, up = 0.15 + 0.5 * (((seed + i * 3) % 4) / 4), h = Math.sqrt(1 - up * up);
    items.push({ berry: true, s: scr(q.dx + Math.cos(a) * h * q.r, q.dy + up * q.r, q.dz + Math.sin(a) * h * q.r), rr: 2.6 }); }
  items.sort((a, b) => a.s[2] - b.s[2]);
  X.fillStyle = 'rgba(0,0,0,0.25)'; X.beginPath(); X.ellipse(sx, cy + 1.5, 13, 4, 0, 0, Math.PI * 2); X.fill();   // on the ground, not floating
  X.strokeStyle = '#000'; X.lineWidth = 2.6; X.beginPath(); for (const it of items) if (!it.berry) { X.moveTo(it.s[0] + it.rr, it.s[1]); X.arc(it.s[0], it.s[1], it.rr, 0, Math.PI * 2); } X.stroke();   // one outline round the leaves
  // the leaves one lit mass (as the trees); a berry over them unless a nearer leaf puff covers it (round the back)
  const leafs = items.filter(it => !it.berry);
  litMass(leafs.map(it => ({ px: it.s[0], py: it.s[1], r: it.rr })), '#3c8a25', '#2a631b', 2.5, 3);
  for (const it of items) { if (!it.berry) continue; const [px, py, d] = it.s, r = it.rr;
    if (leafs.some(l => l.s[2] > d && Math.hypot(l.s[0] - px, l.s[1] - py) < l.rr - r * 0.5)) continue;
    X.fillStyle = '#cc3344'; X.beginPath(); X.arc(px, py, r, 0, Math.PI * 2); X.fill(); X.strokeStyle = '#000'; X.lineWidth = 0.8; X.stroke();
    X.fillStyle = '#ff99a8'; X.beginPath(); X.arc(px - r * 0.3, py - r * 0.3, r * 0.33, 0, Math.PI * 2); X.fill(); }   // (a glint)
}
// Resources with height (ore boulders, bushes) on a visible tile sort with the units (render.js 'res' records: a
// villager behind a bush is behind it); fogged, nothing walks there — they stay in the ground pass, under its fog
const isSortedRes = t => t === TERRAIN.GOLD || t === TERRAIN.STONE || t === TERRAIN.BERRIES;
function drawTileResourceAt(x, y){
  const p = mapToScreen(x, y), sx = Math.round(p.sx), sy = Math.round(p.sy);
  if (!isOffscreen(sx, sy, TW * 2)) drawTileResource(map[y][x], x, y, sx, sy + HALF_TH);
}
function drawTileResource(t, x, y, sx, cy){
  if(t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE){ drawOreTile(t, x, y, sx, cy); return; }
  if(t.t===TERRAIN.BERRIES) drawBerryBush(t, x, y, sx, cy);
}

// The ground as one image: a MAP×MAP canvas, a pixel per tile in its base colour, drawn through the iso grid's affine
// map (tile (x,y)'s top corner = origin + x·(HALF_TW, HALF_TH) + y·(−HALF_TW, HALF_TH)) lands every pixel as its
// tile's diamond — one drawImage for what was a path fill per tile. The fog overlay is a second such image, laid over
// the fogged tiles' ore and bushes.
let _gnd=null;
const _rgbOf = new Map();
function drawGround(minX, maxX, minY, maxY){
  if (!_gnd || _gnd.n !== MAP) {
    const mk = () => { const c = document.createElement('canvas'); c.width = MAP; c.height = MAP; const x = c.getContext('2d'); return { c, x, d: x.createImageData(MAP, MAP) }; };
    _gnd = { n: MAP, base: mk(), fog: mk() };
  }
  const g = _gnd.base.d.data, fd = _gnd.fog.d.data;
  for (let y = 0; y < MAP; y++) { const fr = fog[y], row = map[y]; for (let x = 0; x < MAP; x++) {
    const i = (y * MAP + x) * 4, f = fr ? fr[x] : 0;
    if (!f) { g[i + 3] = 0; fd[i + 3] = 0; continue; }
    const t = row[x], cols = TCOL[t.t] || TCOL[0], col = cols[(x * 7 + y * 13) % cols.length];
    let rgb = _rgbOf.get(col); if (!rgb) { rgb = [1, 3, 5].map(k => parseInt(col.slice(k, k + 2), 16)); _rgbOf.set(col, rgb); }
    g[i] = rgb[0]; g[i + 1] = rgb[1]; g[i + 2] = rgb[2]; g[i + 3] = 255;
    fd[i] = fd[i + 1] = fd[i + 2] = 0; fd[i + 3] = f === 1 ? 140 : 0;   // (rgba(0,0,0,0.55))
  } }
  _gnd.base.x.putImageData(_gnd.base.d, 0, 0); _gnd.fog.x.putImageData(_gnd.fog.d, 0, 0);
  const o = mapToScreen(0, 0), lay = c => { X.save(); X.transform(HALF_TW, HALF_TH, -HALF_TW, HALF_TH, Math.round(o.sx), Math.round(o.sy)); X.imageSmoothingEnabled = false; X.drawImage(c, 0, 0); X.restore(); };
  lay(_gnd.base.c);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) if (fog[y] && fog[y][x] === 1 && isSortedRes(map[y][x].t)) drawTileResourceAt(x, y);
  lay(_gnd.fog.c);
}

function drawStump(sx, cy, s, darken = false) {
  X.fillStyle = '#000000';
  X.beginPath();
  X.moveTo(sx - 4.5 * s, cy + 2 * s);
  X.lineTo(sx + 4.5 * s, cy + 2 * s);
  X.lineTo(sx + 3.2 * s, cy - 8 * s);
  X.lineTo(sx - 3.2 * s, cy - 8 * s);
  X.closePath(); X.fill();
  
  X.fillStyle = darken ? darkenColor(TREE_BARK) : TREE_BARK;
  X.beginPath();
  X.moveTo(sx - 3.5 * s, cy + 2 * s);
  X.lineTo(sx + 3.5 * s, cy + 2 * s);
  X.lineTo(sx + 2.2 * s, cy - 8 * s);
  X.lineTo(sx - 2.2 * s, cy - 8 * s);
  X.closePath(); X.fill();
  
  X.fillStyle = darken ? darkenColor(TREE_CUT) : TREE_CUT;
  X.beginPath();
  X.ellipse(sx, cy - 8 * s, 2.2 * s, 1.0 * s, 0, 0, Math.PI * 2); X.fill();
  X.strokeStyle = '#000000'; X.lineWidth = 1; X.stroke();
}

// One lit mass of puffs ({px, py, r}): all of it lit, then the base colour over it shifted (dx, dy) away from the light,
// clipped to it — the light's side keeps a rim that follows the bumps, with no highlight inside on each puff
function litMass(puffs, lit, base, dx, dy){
  const path = (ox, oy) => { X.beginPath(); for (const q of puffs) { X.moveTo(q.px + ox + q.r, q.py + oy); X.arc(q.px + ox, q.py + oy, q.r, 0, Math.PI * 2); } };
  X.fillStyle = lit; path(0, 0); X.fill();
  X.save(); path(0, 0); X.clip(); X.fillStyle = base; path(dx, dy); X.fill(); X.restore();
}
// ---- The tree: pov3d's (initFeatures / refreshFeatures), projected ----
// A round trunk into a cloud of puffs, one of three crown shapes (the round one, a taller, a wide spreading one), at
// the 3D's proportions (trunk ×1.8, crown ×1.5 the old art), turned per tree, its green a shade lighter or darker.
// World units (tiles); the 2:1 view: ground (x, z) → screen by the iso axes, heights ×√3/2.
const TREE_PX = HALF_TW * Math.SQRT2, TREE_HPX = TREE_PX * Math.sqrt(3) / 2;
const TREE_ART_H = 24 / TREE_HPX, TREE_TRUNK_H = TREE_ART_H * 1.8, TREE_CROWN_K = 1.5, TREE_TRUNK_R = 2.2 / TREE_PX * 1.35;
const TREE_CROWNS = (() => { const cr = 12 / TREE_PX, sm = 9 / TREE_PX, H = TREE_ART_H, S = Math.SQRT1_2;   // [r, x, y, z] puffs about the art's trunk top
  const ring = (n, rad, y, r, rot = Math.PI / 4) => Array.from({ length: n }, (_, i) => { const a = rot + i * 2 * Math.PI / n; return [r, Math.cos(a) * rad, y, Math.sin(a) * rad]; });
  const caps = (y, d) => [-1, 1].map(s => [sm, s * S * d, y, -s * S * d]);                       // across the screen
  return [[[cr, 0, H, 0], ...ring(4, cr * 0.8, H - 0.04, sm), ...caps(30 / TREE_HPX, 5 / TREE_PX)],
    [[cr * 0.9, 0, H + 0.05, 0], ...ring(3, cr * 0.65, H - 0.02, sm * 0.95, 0.3), ...caps(H + 0.2, 3 / TREE_PX), [sm * 0.8, 0, H + 0.3, 0]],
    [[cr, 0, H - 0.02, 0], ...ring(5, cr, H - 0.06, sm, 0.2), [sm, 0, H + 0.13, 0]]]
    .map(c => c.map(([r, x, y, z]) => [r * TREE_CROWN_K, x * TREE_CROWN_K, (y - H) * TREE_CROWN_K + TREE_TRUNK_H, z * TREE_CROWN_K])); })();
// one tree's body at (sx, cy) (its trunk's foot): crown shape, turn (rad), shade (0 dark … 2 light), fogged; part:
// 'trunk' or 'crown' alone (they sort apart: a unit under the canopy is over the trunk, under the crown), else both
function drawFullTreeBody(sx, cy, crown, rot, shade, darken = false, part = null){
  const cr = Math.cos(rot), sr = Math.sin(rot), scr = (x, y, z) => { const x1 = x * cr + z * sr, z1 = -x * sr + z * cr; return [sx + (x1 - z1) * HALF_TW, cy + (x1 + z1) * HALF_TH - y * TREE_HPX, x1 + z1]; };
  const puffs = TREE_CROWNS[crown].map(([r, x, y, z]) => { const [px, py, d] = scr(x, y, z); return { px, py, d, r: r * TREE_PX }; }).sort((a, b) => a.d - b.d);
  // the green (the 3D's hue, its lightness by shade), the crown lit as ONE mass: its lit rim up and left (the light's
  // side) — the crown filled lit, then filled again in the base green shifted away from the light, inside its outline
  const L = 0.41 + shade * 0.05, g3 = f => 'hsl(113,54%,' + Math.round(L * 100 * f) + '%)';
  const [base, mid] = darken ? ['#10300a', '#184010'] : [g3(0.78), g3(1.12)];
  const tw = TREE_TRUNK_R * TREE_PX, th = TREE_TRUNK_H * TREE_HPX, bark = darken ? darkenColor(TREE_BARK) : TREE_BARK;
  const trunk = () => { X.moveTo(sx - tw, cy); X.lineTo(sx - tw * 0.9, cy - th); X.lineTo(sx + tw * 0.9, cy - th); X.lineTo(sx + tw, cy); X.ellipse(sx, cy, tw, tw * 0.5, 0, 0, Math.PI); X.closePath(); };
  // one outline round the whole tree (stroked under the fills), then the trunk, then the puffs far to near
  X.lineJoin = 'round'; X.strokeStyle = '#000'; X.lineWidth = 2.6;
  X.beginPath(); if (part !== 'crown') trunk(); if (part !== 'trunk') for (const q of puffs) { X.moveTo(q.px + q.r, q.py); X.arc(q.px, q.py, q.r, 0, Math.PI * 2); } X.stroke();
  if (part !== 'crown') { X.fillStyle = bark; X.beginPath(); trunk(); X.fill(); }
  if (part !== 'trunk') litMass(puffs, mid, base, 5, 6);
}

// Tree-body art cache: a forest is hundreds of trees, redrawn again into the behind-occluder clip mask, so each body
// renders ONCE into an offscreen canvas and is blitted — its size variety a stretch of the blit, sway/fall a rotate
// about its foot. Keyed by crown × turn (4 steps) × shade × darken × ceil(ZOOM*dpr): a few dozen, no eviction.
const _treeArtCache = new Map();
// A cached art canvas cropped to its painted pixels (a trunk or a crown alone leaves most of the frame empty, and a
// blit's cost is its area): { canvas, ax, ay (the anchor in logical px), wL, hL }
function cropArt(cv, scale, ax, ay){
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, W = cv.width, H = cv.height;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return { canvas: cv, ax, ay, wL: 0, hL: 0 };
  const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(cv, -x0, -y0);
  return { canvas: out, ax: ax - x0 / scale, ay: ay - y0 / scale, wL: out.width / scale, hL: out.height / scale };
}
function _treeArt(crown, rotStep, shade, darken, scale, part = null){
  const key = (((((crown * 4 + rotStep) * 3 + shade) * 2 + (darken ? 1 : 0)) * 64 + scale) * 3) + (part === 'trunk' ? 1 : part === 'crown' ? 2 : 0);   // (a number: ~2000 lookups a frame)
  let a = _treeArtCache.get(key);
  if(a) return a;
  const halfW = 46, above = 104, below = 8; // the body's extent about its foot
  const wL = 2*halfW, hL = above + below;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(wL*scale); cv.height = Math.ceil(hL*scale);
  const cx = cv.getContext('2d');
  cx.scale(scale, scale);
  const sv = X; X = cx;
  try { drawFullTreeBody(halfW, above, crown, rotStep * Math.PI / 2, shade, darken, part); } finally { X = sv; }
  a = cropArt(cv, scale, halfW, above);
  _treeArtCache.set(key, a);
  return a;
}
// part: 'trunk' or 'crown' (render.js sorts them apart), else the whole tree
function drawTreeEntity(x,y,part=null){
  let f = fog[y] && fog[y][x];
  if (f === 0) return; // unexplored (black)

  let p=mapToScreen(x,y);
  let sx=Math.round(p.sx), sy=Math.round(p.sy);
  let cy=sy+HALF_TH;
  let t=map[y][x];
  if(!t || t.res<=0) return;

  // 1. Each tree its own (pov3d's): size, crown shape, turn, proportions, shade, a nudge off the grid
  const h = n => tileHash(x, y, n), s = 1.05 * (0.8 + ((x * 17 + y * 23) % 5) * 0.08);
  const kw = s * (0.9 + h(4) * 0.2), kh = s * (0.9 + h(5) * 0.22), crown = Math.floor(h(7) * 3), rotStep = Math.floor(h(3) * 4), shade = Math.min(2, Math.floor(h(9) * 3));
  sx += Math.round(((h(1) - h(2)) * 0.2) * HALF_TW); cy += Math.round(((h(1) + h(2) - 1) * 0.2) * HALF_TH);
  
  // 2. Dynamic Wind Sway — frozen in shroud (static snapshot when out of sight)
  let totalSway = 0;
  if (f === 2) {
    let windPhase = animTick * 0.015 + x * 0.45 + y * 0.35;
    let sway = Math.sin(windPhase) * 0.035;
    let gust = Math.max(0, Math.sin(animTick * 0.004 - (x + y) * 0.07) - 0.4) * 0.16;
    totalSway = sway + gust;
  }

  // Initialize fell tick for falling tree animation — treeFellTicks
  // (js/core.js), not a field on the tile itself; see its comment.
  let fellKey = x + ',' + y;
  if(t.res <= 60 && !treeFellTicks.has(fellKey)){
    treeFellTicks.set(fellKey, tick);
  }

  // Calculate fall progress and angle — frozen in shroud (static snapshot)
  let fallAngle = 0;
  let isFalling = false;
  let fellTick = treeFellTicks.get(fellKey);
  if(f === 2 && fellTick !== undefined && fellTick > 0){
    let dt = tick - fellTick;
    if(dt < T30(40)){
      isFalling = true;
      let progress = dt / T30(40);
      fallAngle = progress * (Math.PI / 2.15); // Fall sideways
    }
  }

  let darken = (f === 1);

  if(t.res > 60 || isFalling){
    // Stage 1: Standing or falling full tree — blit the cached body, sway/fall
    // as a rotate about (sx,cy). Cache at ceil(ZOOM*dpr) so it stays crisp.
    let art = _treeArt(crown, rotStep, shade, darken, Math.max(1, Math.ceil(ZOOM*dpr)), part); // dpr: match the main ctx scale (core.js) for crisp edges
    X.save();
    X.translate(sx, cy);
    X.rotate(totalSway + fallAngle);
    X.scale(kw, kh);
    X.drawImage(art.canvas, -art.ax, -art.ay, art.wL, art.hL);
    X.restore();
  } else if(part === 'crown'){
    return; // (a cut tree is all on the ground: its trunk part draws it)
  } else if(t.res > 20){
    // Stage 2: Standing stump AND fallen tree lying on the ground
    drawStump(sx, cy, s, darken);
    let art = _treeArt(crown, rotStep, shade, darken, Math.max(1, Math.ceil(ZOOM*dpr)));
    X.save();
    X.translate(sx, cy);
    X.rotate(Math.PI / 2.15);
    X.scale(kw * 0.85, kh * 0.85);   // (a little smaller lying, as the 3D: mostly on its own square)
    X.drawImage(art.canvas, -art.ax, -art.ay, art.wL, art.hL);
    X.restore();
  } else {
    // Stage 3: Standing stump only
    drawStump(sx, cy, s, darken);
  }
}

// ---- MODULAR ISOMETRIC RENDERING HELPERS ----

// Draws a half-length wall slab from a pillar center toward the midpoint with a neighbor.
// sx,sy: start screen pos (pillar center base)
// dx,dy: screen offset to the midpoint (half tile: ±16, ±8)
// wallH: height of the wall slab in pixels
function drawWallLink(sx, sy, dx, dy, wallH, darken=false, d1=5, d2=5, colorL=null, colorTop=null, thick=4, capNear=false, mat='wood') {

  let L = Math.sqrt(dx * dx + dy * dy);
  if (L === 0) return;
  let ux = dx / L, uy = dy / L;

  let nsx = sx + ux * d1;
  let nsy = sy + uy * d1;
  let nex = sx + dx - ux * d2;
  let ney = sy + dy - uy * d2;

  let isAlongIsoY = (dx > 0) !== (dy > 0);
  let px = isAlongIsoY ? thick : -thick;
  let py = thick / 2; // always positive (both perpendiculars have same Y component)

  X.strokeStyle = '#000'; X.lineWidth = 1.3; X.lineJoin = 'round';

  // Default palette by material: palisade wood (Dark age WALL/GATE) or the
  // stone greys (Feudal SWALL/SGATE — the original Stone Wall palette).
  // 'stonef' = FORTIFIED stone (the Fortified Wall tech tell): same
  // masonry plus crenellation merlons on the walkway below.
  let stone = mat === 'stone' || mat === 'stonef';
  let pal = stone
    ? { a: '#aca392', b: '#cfc8b6', top: '#b7ad97' }
    : { a: WOOD.R, b: WOOD.L, top: WOOD.top }; // shared timber palette (render-buildings.js)
  let fillL = colorL || (isAlongIsoY ? pal.a : pal.b);
  let fillTop = colorTop || pal.top;
  if (darken) {
    fillL = darkenColor(fillL);
    fillTop = darkenColor(fillTop);
  }

  // 1. Visible side face
  X.fillStyle = fillL;
  X.beginPath();
  X.moveTo(nsx + px, nsy + py);
  X.lineTo(nex + px, ney + py);
  X.lineTo(nex + px, ney + py - wallH);
  X.lineTo(nsx + px, nsy + py - wallH);
  X.closePath(); X.fill(); X.stroke();

  // Palisade texture: vertical stake seams across the visible side face,
  // so the wooden wall reads as driven beams rather than a flat slab
  if (mat === 'wood' && !colorL) {
    X.save();
    X.strokeStyle='rgba(0,0,0,0.28)';X.lineWidth=1;
    for (let t of [0.25, 0.5, 0.75]) {
      let vx = nsx + (nex - nsx) * t + px;
      let vy = nsy + (ney - nsy) * t + py;
      X.beginPath();X.moveTo(vx, vy);X.lineTo(vx, vy - wallH);X.stroke();
    }
    X.restore();
  }

  // Stone masonry texture: horizontal course lines with staggered vertical
  // joints (light strokes per the seam-weight convention — hard black is
  // reserved for silhouettes)
  if (stone && !colorL) {
    X.save();
    X.strokeStyle='rgba(0,0,0,0.13)';X.lineWidth=1;
    let courses = 3;
    for (let c = 1; c < courses; c++) {
      let hy = wallH * c / courses;
      X.beginPath();
      X.moveTo(nsx + px, nsy + py - hy);
      X.lineTo(nex + px, ney + py - hy);
      X.stroke();
      // staggered vertical joints on this course band
      let joints = c % 2 ? [0.2, 0.5, 0.8] : [0.35, 0.65];
      for (let t of joints) {
        let vx = nsx + (nex - nsx) * t + px;
        let vy = nsy + (ney - nsy) * t + py;
        X.beginPath();
        X.moveTo(vx, vy - hy);
        X.lineTo(vx, vy - hy + wallH / courses);
        X.stroke();
      }
    }
    // top course joints — offset from the middle course below
    for (let t of [0.2, 0.5, 0.8]) {
      let vx = nsx + (nex - nsx) * t + px;
      let vy = nsy + (ney - nsy) * t + py;
      X.beginPath();
      X.moveTo(vx, vy - wallH);
      X.lineTo(vx, vy - wallH + wallH / courses);
      X.stroke();
    }
    X.restore();
  }

  // 2. Top walkway face
  X.fillStyle = fillTop;
  X.beginPath();
  X.moveTo(nsx - px, nsy - py - wallH);
  X.lineTo(nsx + px, nsy + py - wallH);
  X.lineTo(nex + px, ney + py - wallH);
  X.lineTo(nex - px, ney - py - wallH);
  X.closePath(); X.fill(); X.stroke();

  // Fortified crenellation: two mini merlons riding the walkway, built
  // from the link's own face math (side at +px/+py, cap full thickness)
  // so they read as the wall's masonry continuing upward. Caps keep the
  // walkway's team color (ownership read).
  if (mat === 'stonef') {
    const mh = 4, w = 3.2;
    for (let t of [0.3, 0.7]) {
      let cxm = nsx + (nex - nsx) * t, cym = nsy + (ney - nsy) * t;
      let ax2 = ux * w, ay2 = uy * w;
      X.fillStyle = fillL; X.beginPath();
      X.moveTo(cxm - ax2 + px, cym - ay2 + py - wallH);
      X.lineTo(cxm + ax2 + px, cym + ay2 + py - wallH);
      X.lineTo(cxm + ax2 + px, cym + ay2 + py - wallH - mh);
      X.lineTo(cxm - ax2 + px, cym - ay2 + py - wallH - mh);
      X.closePath(); X.fill(); X.stroke();
      X.fillStyle = fillTop; X.beginPath();
      X.moveTo(cxm - ax2 - px, cym - ay2 - py - wallH - mh);
      X.lineTo(cxm - ax2 + px, cym - ay2 + py - wallH - mh);
      X.lineTo(cxm + ax2 + px, cym + ay2 + py - wallH - mh);
      X.lineTo(cxm + ax2 - px, cym + ay2 - py - wallH - mh);
      X.closePath(); X.fill(); X.stroke();
    }
  }

  // 3. End cap face — closes the cut end exposed when d1/d2 trims the
  // link back from its endpoint (e.g. the gate door not reaching its post).
  if (capNear) {
    X.fillStyle = fillL;
    X.beginPath();
    X.moveTo(nex - px, ney - py);
    X.lineTo(nex + px, ney + py);
    X.lineTo(nex + px, ney + py - wallH);
    X.lineTo(nex - px, ney - py - wallH);
    X.closePath(); X.fill(); X.stroke();
  }
}

const darkenCache = new Map();
function darkenColor(col) {
  if (!col) return col;
  let cached = darkenCache.get(col);
  if (cached) return cached;
  
  let result = col;
  if (col.startsWith('#')) {
    let hex = col.substring(1);
    let r, g, b;
    if (hex.length === 6) {
      r = parseInt(hex.substring(0, 2), 16);
      g = parseInt(hex.substring(2, 4), 16);
      b = parseInt(hex.substring(4, 6), 16);
      r = Math.floor(r * 0.45);
      g = Math.floor(g * 0.45);
      b = Math.floor(b * 0.45);
      result = `rgb(${r},${g},${b})`;
    } else if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      r = Math.floor(r * 0.45);
      g = Math.floor(g * 0.45);
      b = Math.floor(b * 0.45);
      result = `rgb(${r},${g},${b})`;
    }
  } else if (col.startsWith('rgb')) {
    let parts = col.match(/\d+/g);
    if (parts && parts.length >= 3) {
      let r = Math.floor(parseInt(parts[0]) * 0.45);
      let g = Math.floor(parseInt(parts[1]) * 0.45);
      let b = Math.floor(parseInt(parts[2]) * 0.45);
      result = `rgb(${r},${g},${b})`;
    }
  }
  darkenCache.set(col, result);
  return result;
}
