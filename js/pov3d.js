// ---- POV 3D: Eye View (corner window) and character mode (full screen) ----
// VIEWER-ONLY: reads the world and never writes sim state; steering acts only
// through submitCommand (autopilot / possess / ordinary unit commands), so it is
// lockstep-safe. Visibility follows the viewer's own fog grid, like the map.
// three.js (vendor/three.min.js, r159) loads lazily on first open. Units, trees,
// resources and buildings are camera-facing billboards drawn by the real 2D art
// (drawUnit / drawTreeEntity / drawTileResource / drawBuilding into offscreen
// canvases); walls and gates are 3D segments; farms lie flat as ground decals;
// terrain is one textured plane. World tile (x,y) maps to three.js (X=x, Z=y), Y up.
(function(){
  const RANGE = 28;                  // tiles drawn around the eye
  const PX = HALF_TW * Math.SQRT2;   // iso art px per world tile across the view (~45)
  const UNIT_BUF = 112, UNIT_ANCHOR_Y = 66; // the outline pass's unit buffer (render-outlines.js)
  const SS = 1.5;                    // billboard canvas supersample
  const MAX_UNITS = 60;
  const STATIC_MS = 500;             // terrain/trees/building-set refresh cadence
  const BLDG_TOP = 230, BLDG_BASE = 10; // px of headroom above / margin below a footprint
  const BLDG_PAINTS = 3;             // building art redraws per frame (round-robin)

  let THREE = null, loading = null;
  let renderer, scene, camera, groundTex, groundData, groundMesh, groundFor = null;
  // Terrain features as billboard layers: one instanced camera-facing quad per
  // kind, textured once from the 2D art. ay = the art's ground point (px).
  const LAYERS = [
    { t: TERRAIN.FOREST, bw: 128, bh: 176, ay: 160 },
    { t: TERRAIN.GOLD, bw: 64, bh: 56, ay: 40 },
    { t: TERRAIN.STONE, bw: 64, bh: 56, ay: 40 },
    { t: TERRAIN.BERRIES, bw: 64, bh: 56, ay: 40 },
  ];
  const bldgSprites = new Map(), unitSprites = new Map(), wallMeshes = new Map(), mats = new Map();
  let unitBox = null;
  let bldgPaintQ = [];
  let pip, titleEl, followId = null, raf = 0, lastStatic = 0, frame = 0;
  let eye = null, yaw = 0;           // smoothed unit position / heading
  let camAt = { x: 0, y: 0 };        // where the camera stands (world tiles)
  let mode = 'eye', full = false;    // 'eye' = first person, 'chase' = behind the unit
  let btnMode, btnFull, btnAuto, btnNext, btnCtl, hintEl, joyEl, actEl;

  // A classic <script>, not import(): module loads are CORS-blocked on file://.
  function loadThree(){
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/three.min.js';
        s.onload = () => { THREE = window.THREE; resolve(); };
        s.onerror = () => { s.remove(); reject(new Error('could not load vendor/three.min.js')); };
        document.head.appendChild(s);
      }).catch(err => { loading = null; throw err; });
    }
    return loading;
  }

  // Redraw with the 2D renderer into ctx c, the point (wx,wy) landing at (ax,ay).
  // Swaps the canvas globals exactly like the outline mask pass does.
  function drawInto(c, wx, wy, ax, ay, draw){
    const sv = { X, camX, camY, W, H, topH, ZOOM };
    X = c; W = 2000; H = 2000; topH = 0; ZOOM = 1;
    window._maskDraw = true; // drawUnit stays read-only: no hysteresis, HP bar, shadow, particles
    window._povDraw = true;  // ...and no HUD cues (idle "?")
    try {
      const iso = toIso(wx, wy);
      camX = iso.ix + W / 2 - ax; camY = iso.iy + H / 2 - ay;
      draw();
    } finally {
      window._maskDraw = false; window._povDraw = false;
      X = sv.X; camX = sv.camX; camY = sv.camY; W = sv.W; H = sv.H; topH = sv.topH; ZOOM = sv.ZOOM;
    }
  }

  function canvasTex(w, h){
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(w * SS); cv.height = Math.ceil(h * SS);
    const ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { cv, ctx, tex };
  }
  function clearCtx(ctx){
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(SS, 0, 0, SS, 0, 0);
  }
  function initScene(){
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1)); // full screen on phones gets heavy
    pip.insertBefore(renderer.domElement, pip.firstChild);
    scene = new THREE.Scene();
    const sky = new THREE.Color('#9fc8e6');
    scene.background = sky;
    scene.fog = new THREE.Fog(sky, RANGE * 0.45, RANGE);
    camera = new THREE.PerspectiveCamera(70, 1.6, 0.05, RANGE + 6);
    scene.add(new THREE.HemisphereLight('#ffffff', '#4a6a3a', 1.6));
    const sun = new THREE.DirectionalLight('#fff4e0', 1.4);
    sun.position.set(-1, 2, -0.3); // upper-left in the iso view, like the 2D art
    scene.add(sun);

    unitBox = new THREE.BoxGeometry(1, 1, 1);
    const cap = (2 * (RANGE + 4)) ** 2;
    for (const L of LAYERS) {
      const q = new THREE.PlaneGeometry(L.bw / PX, L.bh / PX);
      q.translate(0, (L.ay - L.bh / 2) / PX, 0); // ground point at y=0
      L.mesh = new THREE.InstancedMesh(q, new THREE.MeshBasicMaterial({ alphaTest: 0.5 }), cap);
      L.mesh.count = 0; L.mesh.frustumCulled = false;
      L.pos = []; L.scale = [];
      scene.add(L.mesh);
    }
  }

  // Layer textures at full size. Trees need a real forest tile (drawTreeEntity
  // reads the map); resources draw from a stand-in full tile.
  function paintLayers(){
    for (const L of LAYERS) {
      const t = canvasTex(L.bw, L.bh);
      clearCtx(t.ctx);
      if (L.t === TERRAIN.FOREST) {
        let at = null;
        for (let y = 0; y < MAP && !at; y++) for (let x = 0; x < MAP; x++)
          if (map[y][x].t === TERRAIN.FOREST && map[y][x].res > 0) { at = { x, y }; break; }
        if (!at) continue;
        const f = fog[at.y][at.x];
        fog[at.y][at.x] = 2; // drawTreeEntity skips unexplored tiles; restored below
        try { drawInto(t.ctx, at.x + 0.5, at.y + 0.5, L.bw / 2, L.ay, () => drawTreeEntity(at.x, at.y)); }
        finally { fog[at.y][at.x] = f; }
      } else {
        const sv = X;
        X = t.ctx;
        try { drawTileResource({ t: L.t, res: 1e9 }, 0, 0, L.bw / 2, L.ay); } finally { X = sv; }
      }
      if (L.mesh.material.map) L.mesh.material.map.dispose();
      L.mesh.material.map = t.tex; L.mesh.material.needsUpdate = true;
    }
  }

  function buildGround(){
    if (groundMesh) { scene.remove(groundMesh); groundMesh.geometry.dispose(); groundTex.dispose(); }
    groundData = new Uint8Array(MAP * MAP * 4);
    groundTex = new THREE.DataTexture(groundData, MAP, MAP);
    groundTex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(MAP, MAP);
    geo.rotateX(-Math.PI / 2);
    // No depth writes, drawn first: billboards may extend below y=0 (see makeBldgRec).
    groundMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: groundTex, depthWrite: false }));
    groundMesh.renderOrder = -1;
    groundMesh.position.set(MAP / 2, 0, MAP / 2);
    scene.add(groundMesh);
    groundFor = map;
    dropBuildings(); // a new world reuses entity ids
    paintLayers();
  }

  const rgbCache = new Map();
  function rgb(hex){
    let c = rgbCache.get(hex);
    if (!c) { const n = parseInt(hex.slice(1), 16); c = [n >> 16, (n >> 8) & 255, n & 255]; rgbCache.set(hex, c); }
    return c;
  }
  function refreshGround(){
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
      const f = (fog[y] && fog[y][x]) || 0;
      const i = ((MAP - 1 - y) * MAP + x) * 4; // texture row 0 is the plane's far (+Z) edge
      if (!f) { groundData[i] = 0x6f; groundData[i + 1] = 0x81; groundData[i + 2] = 0x94; groundData[i + 3] = 255; continue; } // unexplored reads as mist, not a black band
      const cols = TCOL[map[y][x].t] || TCOL[0];
      const c = rgb(cols[(x * 7 + y * 13) % cols.length]);
      const k = f === 2 ? 1 : 0.55;
      groundData[i] = c[0] * k; groundData[i + 1] = c[1] * k; groundData[i + 2] = c[2] * k; groundData[i + 3] = 255;
    }
    groundTex.needsUpdate = true;
  }

  function refreshFeatures(){
    const byT = new Map(LAYERS.map(L => [L.t, L]));
    for (const L of LAYERS) { L.pos.length = 0; L.scale.length = 0; }
    const r = RANGE + 4, cx = Math.floor(eye.x), cy = Math.floor(eye.y);
    for (let y = Math.max(0, cy - r); y < Math.min(MAP, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x < Math.min(MAP, cx + r); x++) {
        const tile = map[y][x], L = byT.get(tile.t);
        if (!L || !(fog[y] && fog[y][x]) || tile.res <= 0) continue;
        L.pos.push(x + 0.5, y + 0.5);
        L.scale.push(L.t === TERRAIN.FOREST ? 0.8 + ((x * 17 + y * 23) % 5) * 0.08 : 1); // the 2D art's tree size noise
      }
    }
  }

  // Billboards face the camera plane (one yaw for all) every frame; features
  // right at the camera are skipped so the chase view never sits in a canopy.
  function alignLayers(){
    const m4 = new THREE.Matrix4(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-Math.cos(yaw), -Math.sin(yaw)));
    for (const L of LAYERS) {
      let n = 0;
      for (let i = 0; i < L.scale.length; i++) {
        const x = L.pos[2 * i], y = L.pos[2 * i + 1], k = L.scale[i];
        if ((x - camAt.x) ** 2 + (y - camAt.y) ** 2 < 2) continue;
        L.mesh.setMatrixAt(n++, m4.compose(p.set(x, 0, y), q, s.set(k, k, k)));
      }
      L.mesh.count = n;
      L.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function bldgVisible(e){
    const f = buildingFogLevel(e);
    if (f === 0) return false;
    return f === 2 || sameSide(e.team, myTeam) || scoutedByMe.has(e.id);
  }
  // Billboard canvas for a building: the footprint's front corner sits
  // BLDG_BASE px above the bottom edge. The ground line is the diamond's
  // middle (its side corners, where posts and wall ends stand); the front
  // half hangs below ground, visible because the ground writes no depth.
  function makeBldgRec(e){
    const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h;
    const cw = (w + h) * HALF_TW + 64, ch = (w + h) * HALF_TH + BLDG_TOP;
    const rec = canvasTex(cw, ch);
    Object.assign(rec, { cw, ch, w, h, ay: ch - BLDG_BASE - (w + h) * HALF_TH / 2 }); // ay: footprint center
    if (e.btype === 'FARM') {
      // Flat: map the iso diamond onto the footprint. Iso is affine, so each
      // footprint corner takes its own canvas position as its UV.
      const c = centerOf(e), ci = toIso(c.x, c.y), pos = [], uv = [];
      for (const [x, y] of [[e.x, e.y], [e.x + w, e.y], [e.x + w, e.y + h], [e.x, e.y + h]]) {
        const p = toIso(x, y);
        pos.push(x, 0.02, y);
        uv.push((cw / 2 + p.ix - ci.ix) / cw, 1 - (rec.ay + p.iy - ci.iy) / ch);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex([0, 2, 1, 0, 3, 2]);
      geo.computeVertexNormals();
      rec.obj = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: rec.tex, alphaTest: 0.5 }));
    } else {
      rec.obj = new THREE.Sprite(new THREE.SpriteMaterial({ map: rec.tex, alphaTest: 0.5 }));
      rec.obj.center.set(0.5, (ch - rec.ay) / ch);
      rec.obj.scale.set(cw / PX, ch / PX, 1);
      const c = centerOf(e);
      rec.obj.position.set(c.x, 0, c.y);
    }
    scene.add(rec.obj);
    return rec;
  }
  function dropBldgRec(rec){
    scene.remove(rec.obj); rec.tex.dispose(); rec.obj.material.dispose();
    if (rec.obj.geometry && rec.obj.isMesh) rec.obj.geometry.dispose();
  }
  function dropBuildings(){
    for (const rec of bldgSprites.values()) dropBldgRec(rec);
    bldgSprites.clear(); bldgPaintQ = [];
    for (const w of wallMeshes.values()) scene.remove(w.obj);
    wallMeshes.clear();
  }

  // Walls and gates are real 3D: standing iso wall art reads as broken fence
  // pieces. A post per footprint tile plus a half-arm toward each same-team
  // wall/gate/tower neighbor (neighbors' half-arms meet; a tower billboard
  // covers the stub). Towers stay art billboards.
  const WALL_COL = { WALL: '#b07c46', GATE: '#7a5634', SWALL: '#b9b1a3', SGATE: '#8e877b' };
  function mat(color){
    let m = mats.get(color);
    if (!m) { m = new THREE.MeshLambertMaterial({ color }); mats.set(color, m); }
    return m;
  }
  const isWallLike = t => isWallBtype(t.btype) || isGateBtype(t.btype) || isTowerBtype(t.btype);
  function refreshWall(e){
    const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h;
    const stone = e.btype === 'SWALL' || e.btype === 'SGATE';
    const H = (stone ? 1.1 : 0.9) * (e.complete ? 1 : Math.max(0.15, e.buildProgress / e.buildTime));
    const arms = [];
    for (let fy = e.y; fy < e.y + h; fy++) for (let fx = e.x; fx < e.x + w; fx++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const row = map[fy + dy], cell = row && row[fx + dx], n = cell && cell.occupied != null && entitiesById.get(cell.occupied);
        if (n && (n.id === e.id || (n.team === e.team && isWallLike(n)))) arms.push(fx, fy, dx, dy);
      }
    }
    const key = H.toFixed(2) + ':' + arms.join(',');
    let rec = wallMeshes.get(e.id);
    if (rec && rec.key === key) return;
    if (rec) scene.remove(rec.obj);
    const g = new THREE.Group(), m = mat(WALL_COL[e.btype] || WALL_COL.WALL), T = 0.3;
    const box = (x, z, sx, sy, sz) => { const o = new THREE.Mesh(unitBox, m); o.position.set(x, sy / 2, z); o.scale.set(sx, sy, sz); g.add(o); };
    for (let fy = e.y; fy < e.y + h; fy++) for (let fx = e.x; fx < e.x + w; fx++) box(fx + 0.5, fy + 0.5, T + 0.08, H * 1.08, T + 0.08);
    for (let i = 0; i < arms.length; i += 4) {
      const [fx, fy, dx, dy] = arms.slice(i, i + 4);
      box(fx + 0.5 + dx * 0.25, fy + 0.5 + dy * 0.25, dx ? 0.5 : T, H, dy ? 0.5 : T);
    }
    scene.add(g);
    wallMeshes.set(e.id, { obj: g, key });
  }
  function paintBuilding(rec, e){
    clearCtx(rec.ctx);
    const c = centerOf(e);
    drawInto(rec.ctx, c.x, c.y, rec.cw / 2, rec.ay, () => drawBuilding(e));
    rec.tex.needsUpdate = true;
  }
  function refreshBuildings(){
    const seen = new Set();
    for (const e of entities) {
      if (e.type !== 'building' || e.hp <= 0) continue;
      const c = centerOf(e);
      if (Math.abs(c.x - eye.x) > RANGE + 4 || Math.abs(c.y - eye.y) > RANGE + 4 || !bldgVisible(e)) continue;
      seen.add(e.id);
      if (isWallBtype(e.btype) || isGateBtype(e.btype)) refreshWall(e);
      else if (!bldgSprites.has(e.id)) { const rec = makeBldgRec(e); bldgSprites.set(e.id, rec); paintBuilding(rec, e); }
    }
    for (const [id, rec] of bldgSprites) if (!seen.has(id)) { dropBldgRec(rec); bldgSprites.delete(id); }
    for (const [id, w] of wallMeshes) if (!seen.has(id)) { scene.remove(w.obj); wallMeshes.delete(id); }
  }
  // Keep flags, smoke and construction moving: a few redraws per frame.
  function repaintBuildings(){
    for (let n = 0; n < BLDG_PAINTS; n++) {
      if (!bldgPaintQ.length) bldgPaintQ = [...bldgSprites.keys()].sort((a, b) => a - b);
      const id = bldgPaintQ.shift(), rec = bldgSprites.get(id), e = entitiesById.get(id);
      if (rec && e) paintBuilding(rec, e);
      if (!bldgPaintQ.length) break;
    }
  }

  // Where a unit is heading in world radians: its path, then its target, else
  // the committed sprite facing. Render-side only (reads, never writes).
  function worldFacing(e){
    let tx, ty;
    if (e.path && e.path.length) { const a = e.path[Math.min(3, e.path.length - 1)]; tx = a.x; ty = a.y; }
    else if (e.target && entitiesById.get(e.target)) { const t = entitiesById.get(e.target); tx = t.x; ty = t.y; }
    if (tx !== undefined && (tx !== e.x || ty !== e.y)) return Math.atan2(ty - e.y, tx - e.x);
    return (e.dir !== undefined ? e.dir : 1) * Math.PI / 4;
  }

  function unitVisible(e){
    if (e.garrisonedIn || e.hp <= 0) return false;
    const f = (fog[Math.round(e.y)] && fog[Math.round(e.y)][Math.round(e.x)]) || 0;
    return f === 2 || (f === 1 && sameSide(e.team, myTeam));
  }

  function updateUnits(){
    const near = [];
    for (const e of entities) {
      if (e.type !== 'unit' || (e.id === followId && mode === 'eye')) continue;
      const dx = e.x + 0.5 - camAt.x, dy = e.y + 0.5 - camAt.y, d2 = dx * dx + dy * dy;
      if (d2 > RANGE * RANGE || d2 < 0.5 || !unitVisible(e)) continue; // not ones standing on the camera
      near.push({ e, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2 || a.e.id - b.e.id);
    const used = new Set();
    for (const { e } of near.slice(0, MAX_UNITS)) {
      used.add(e.id);
      let rec = unitSprites.get(e.id);
      if (!rec) {
        rec = canvasTex(UNIT_BUF, UNIT_BUF);
        rec.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: rec.tex, alphaTest: 0.5 }));
        rec.sprite.center.set(0.5, 1 - UNIT_ANCHOR_Y / UNIT_BUF);
        rec.sprite.scale.set(UNIT_BUF / PX, UNIT_BUF / PX, 1);
        scene.add(rec.sprite); unitSprites.set(e.id, rec);
        rec.fresh = true;
      }
      rec.sprite.position.set(e.x + 0.5, 0, e.y + 0.5);
      if (rec.fresh || (frame + e.id) % 2 === 0) { paintUnit(rec, e); rec.fresh = false; } // ~30fps art refresh
    }
    for (const [id, rec] of unitSprites) if (!used.has(id)) {
      scene.remove(rec.sprite); rec.tex.dispose(); rec.sprite.material.dispose(); unitSprites.delete(id);
    }
  }

  // Draw a unit with the rig direction that shows its facing as seen from the
  // camera: the iso view looks along world (-1,-1), i.e. 5π/4.
  function paintUnit(rec, e){
    const view = Math.atan2(e.y + 0.5 - camAt.y, e.x + 0.5 - camAt.x);
    const a = (worldFacing(e) - view + 5 * Math.PI / 4) / (Math.PI / 4); // in 45° sectors
    // Sticky: switch sprite direction only once clearly past a sector edge, or
    // a unit near a 45° boundary strobes as the camera turns.
    const off = rec.d === undefined ? 9 : (((a - rec.d) % 8) + 12) % 8 - 4;
    if (Math.abs(off) > 0.7) rec.d = ((Math.round(a) % 8) + 8) % 8;
    const d = rec.d;
    const keep = { dir: e.dir, facing: e.facing, facingNorth: e.facingNorth, lastX: e.lastX, lastY: e.lastY };
    clearCtx(rec.ctx);
    const { ox, oy } = getUnitGroupOffset(e.id);
    try {
      e.dir = d; setFacingFromDir(e, d);
      drawInto(rec.ctx, e.x, e.y, UNIT_BUF / 2 - ox, UNIT_ANCHOR_Y - HALF_TH - oy, () => drawUnit(e));
    } finally { Object.assign(e, keep); }
    rec.tex.needsUpdate = true;
  }

  function updateEye(e){
    const tx = e.x + 0.5, ty = e.y + 0.5;
    if (!eye) { eye = { x: tx, y: ty }; yaw = worldFacing(e); }
    eye.x += (tx - eye.x) * 0.25; eye.y += (ty - eye.y) * 0.25;
    if (!steering) { // riding along: turn with the unit; steering: the player turns
      let dy = worldFacing(e) - yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy)); // shortest turn
      yaw += dy * 0.12;
    }
    const cx = Math.cos(yaw), cy = Math.sin(yaw);
    if (mode === 'chase') {
      // Behind and above, looking just past the unit (third person).
      camAt = { x: eye.x - cx * 3.2, y: eye.y - cy * 3.2 };
      camera.position.set(camAt.x, 2.1, camAt.y);
      camera.lookAt(eye.x + cx * 2, 0.7, eye.y + cy * 2);
    } else {
      const h = isMountedUnit(e.utype) ? 1.3 : e.utype === 'ram' ? 0.8 : 0.9;
      camAt = { x: eye.x, y: eye.y };
      camera.position.set(eye.x, h, eye.y);
      camera.lookAt(eye.x + cx * 10, h - 0.9, eye.y + cy * 10);
    }
  }

  // Own units in id order (stable), for Next and for taking over on death.
  function ownUnits(){
    return entities.filter(u => u.type === 'unit' && u.team === myTeam && u.hp > 0 && !u.garrisonedIn)
      .sort((a, b) => a.id - b.id);
  }
  // In character mode a fallen character hands over to the nearest own unit,
  // preferring the same kind (the corner window just closes instead).
  function successor(){
    const own = ownUnits();
    if (!own.length || !eye) return null;
    const last = lastUtype;
    const d = u => (u.x + 0.5 - eye.x) ** 2 + (u.y + 0.5 - eye.y) ** 2;
    const pool = own.some(u => u.utype === last) ? own.filter(u => u.utype === last) : own;
    return pool.reduce((best, u) => d(u) < d(best) ? u : best);
  }
  let lastUtype = null;
  function follow(e){
    if (steering && followId !== e.id) possess(e.id, true);
    followId = e.id; lastUtype = e.utype;
    titleEl.textContent = (UNITS[e.utype] && UNITS[e.utype].name) || e.utype;
  }

  // ---- Steering (character mode): the player drives the followed unit ----
  // Tank controls: W/S or ↑/↓ walk, A/D or ←/→ turn, Space acts on what is in
  // front; a touch joystick maps x→turn, y→walk. Everything becomes ordinary
  // lockstep commands (a move, or the attack/gather/build a right-click
  // sends); 'possess' makes the AI leave the unit alone.
  const STEER_KEYS = { w: 'fwd', arrowup: 'fwd', s: 'back', arrowdown: 'back',
                       a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };
  const held = new Set(), joy = { x: 0, y: 0 };
  let steering = false, lastMove = null, lastMoveAt = 0, lastActAt = 0, lastNow = 0, lastPossessAt = 0;
  function possess(id, on){ submitCommand({ kind: 'possess', unitId: id, on }); lastPossessAt = performance.now(); }

  function setSteering(on){
    if (on === steering) return;
    steering = on;
    if (followId != null) possess(followId, on);
    held.clear(); joy.x = joy.y = 0; lastMove = null;
    refreshButtons();
  }

  function steer(e, dt){
    // Self-heal: the sim lost the flag (e.g. a host recovery reloaded a save).
    if (!e.possessed && performance.now() - lastPossessAt > 2000) possess(e.id, true);
    const fwd = (held.has('fwd') ? 1 : 0) - (held.has('back') ? 1 : 0) - joy.y;
    const turn = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0) + joy.x;
    yaw += Math.max(-1, Math.min(1, turn)) * 2.4 * dt;
    const now = performance.now(), ux = Math.round(e.x), uy = Math.round(e.y);
    if (Math.abs(fwd) > 0.25) {
      if (now - lastMoveAt < 150) return;
      const k = fwd > 0 ? 1 : -1, cx = Math.cos(yaw) * k, cy = Math.sin(yaw) * k;
      for (const r of [2.5, 1.5, 1]) { // the farthest open tile ahead
        const tx = Math.round(e.x + cx * r), ty = Math.round(e.y + cy * r);
        if ((tx === ux && ty === uy) || !walkable(tx, ty, e.id, true)) continue;
        if (!lastMove || lastMove.x !== tx || lastMove.y !== ty || now - lastMoveAt > 600) {
          submitCommand({ kind: 'command', unitIds: [e.id], tileX: tx, tileY: ty });
          lastMove = { x: tx, y: ty }; lastMoveAt = now;
        }
        return;
      }
    } else if (lastMove) { // let go: stop here
      submitCommand({ kind: 'command', unitIds: [e.id], tileX: ux, tileY: uy });
      lastMove = null;
    }
  }

  const RES_TILE = new Set([TERRAIN.FOREST, TERRAIN.GOLD, TERRAIN.STONE, TERRAIN.BERRIES]);
  // The nearest thing in front (a 108° cone): enemies and animals to attack;
  // for a villager also resources to gather and own sites to build/repair/farm.
  function act(e){
    const now = performance.now();
    if (gameOver || now - lastActAt < 300) return;
    lastActAt = now;
    const reach = e.range > 0 ? e.range + 1 : 2.5, cone = Math.cos(Math.PI * 0.3);
    const fx = Math.cos(yaw), fy = Math.sin(yaw), vil = e.utype === 'villager';
    let best = null, bestD = Infinity;
    const offer = (x, y, r, cmd) => {
      const dx = x - e.x, dy = y - e.y, d = Math.hypot(dx, dy);
      if (d > r || (d > 0.8 && (dx * fx + dy * fy) / d < cone) || d >= bestD) return;
      bestD = d; best = cmd;
    };
    for (const t of entities) {
      if (t.hp <= 0 || t.id === e.id || t.garrisonedIn) continue;
      if (t.type === 'unit') {
        const food = vil && (t.utype === 'sheep' || t.utype === 'sheep_carcass');
        if ((food || !sameSide(t.team, e.team)) && unitVisible(t))
          offer(t.x, t.y, reach + 1, { targetId: t.id, tileX: Math.round(t.x), tileY: Math.round(t.y) });
      } else if (t.type === 'building') {
        const c = centerOf(t), r = reach + Math.max(t.w, t.h) / 2, tile = { tileX: Math.floor(c.x), tileY: Math.floor(c.y) };
        if (!sameSide(t.team, e.team) && bldgVisible(t)) offer(c.x - 0.5, c.y - 0.5, r, { targetId: t.id, ...tile });
        else if (vil && t.team === e.team && (!t.complete || t.hp < t.maxHp || t.btype === 'FARM'))
          offer(c.x - 0.5, c.y - 0.5, r, { buildTargetId: t.id, ...tile });
      }
    }
    if (vil) {
      const R = Math.ceil(reach);
      for (let y = Math.round(e.y) - R; y <= Math.round(e.y) + R; y++) for (let x = Math.round(e.x) - R; x <= Math.round(e.x) + R; x++) {
        if (x < 0 || y < 0 || x >= MAP || y >= MAP || !fog[y][x]) continue;
        const tile = map[y][x];
        if (tile.res > 0 && RES_TILE.has(tile.t)) offer(x, y, reach, { tileX: x, tileY: y });
      }
    }
    if (best) submitCommand({ kind: 'command', unitIds: [e.id], ...best });
    else if (typeof showMsg === 'function') showMsg('Nothing to do here');
    lastMove = null;
  }

  function resize(){
    const w = pip.clientWidth, h = pip.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  function loop(now){
    raf = requestAnimationFrame(loop);
    let e = entitiesById.get(followId);
    if (!gameStarted) { povClose(); return; }
    if (!e || e.type !== 'unit' || e.hp <= 0 || e.garrisonedIn) {
      const next = full ? successor() : null;
      if (!next) { povClose(); return; }
      follow(next); e = next;
    }
    frame++;
    // The hidden map camera rides along: sound is heard from the character
    // (audio attenuates from camX/camY) and leaving drops you where you are.
    if (full) window.cameraFollowId = followId;
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now;
    if (steering) steer(e, dt);
    const t0 = performance.now();
    if (groundFor !== map || groundData.length !== MAP * MAP * 4) { buildGround(); lastStatic = 0; }
    updateEye(e);
    if (now - lastStatic > STATIC_MS) { refreshGround(); refreshFeatures(); refreshBuildings(); refreshButtons(); lastStatic = now; }
    alignLayers();
    repaintBuildings();
    updateUnits();
    const t1 = performance.now();
    renderer.render(scene, camera);
    // Running averages (ms/frame): our JS (art repaints, uploads, layout) vs the
    // WebGL submit — for profiling from the console.
    stats.js += ((t1 - t0) - stats.js) * 0.05;
    stats.gl += ((performance.now() - t1) - stats.gl) * 0.05;
  }
  const stats = { js: 0, gl: 0 };

  const autopilotOn = () => teamControllers[myTeam] && teamControllers[myTeam].type === 'ai';
  function refreshButtons(){
    btnMode.textContent = mode === 'eye' ? '🎥 Chase' : '👁 Eyes';
    btnFull.textContent = full ? '🗗 Window' : '⛶ Full';
    btnAuto.textContent = autopilotOn() ? '🤖 Town AI: on' : '🤖 Town AI: off';
    // Character mode only.
    btnAuto.style.display = full ? '' : 'none';
    btnNext.style.display = full ? '' : 'none';
    btnCtl.textContent = steering ? '🎮 Release' : '🎮 Take control';
    btnCtl.style.display = full ? '' : 'none';
    const touch = typeof isMobile !== 'undefined' && isMobile;
    hintEl.style.display = steering && !touch ? '' : 'none';
    joyEl.style.display = actEl.style.display = steering && touch ? '' : 'none';
  }
  function setFull(on){
    if (!on) setSteering(false); // control lives in character mode
    if (!on && full && window.cameraFollowId === followId) window.cameraFollowId = null; // map stays centered here
    if (on && !full) mode = 'chase'; // character mode opens behind the unit
    full = on;
    pip.classList.toggle('full', on);
    pip.style.top = on ? topH + 'px' : '';
    pip.style.bottom = on ? '0' : (bottomH + 10) + 'px';
    refreshButtons();
    if (renderer) resize();
  }

  function ensurePip(){
    if (pip) return;
    const st = document.createElement('style');
    st.textContent = `
#pov-pip{position:fixed;right:10px;z-index:40;width:min(46vw,420px);aspect-ratio:16/10;display:none;
  border:2px solid #d8c9a0;border-radius:6px;overflow:hidden;background:#000;box-shadow:0 4px 16px rgba(0,0,0,.5)}
#pov-pip.full{left:0;right:0;width:auto;aspect-ratio:auto;border:0;border-radius:0;z-index:50}
#pov-pip canvas{width:100%;height:100%;display:block}
#pov-pip .pov-bar{position:absolute;top:0;left:0;right:0;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;align-items:center;
  padding:4px 6px;font:12px sans-serif;color:#fff;background:linear-gradient(rgba(0,0,0,.6),transparent);pointer-events:none}
#pov-pip .pov-title{flex:1 0 auto;white-space:nowrap}
#pov-pip .pov-btn{pointer-events:auto;cursor:pointer;padding:3px 7px;border-radius:4px;background:rgba(0,0,0,.45);
  border:1px solid rgba(216,201,160,.6);white-space:nowrap;user-select:none}
#pov-pip.full .pov-bar{font-size:14px;padding:8px 10px}
#pov-pip .pov-hint{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);padding:5px 12px;border-radius:14px;
  font:13px sans-serif;color:#fff;background:rgba(0,0,0,.45);pointer-events:none;white-space:nowrap}
#pov-pip .pov-joy{position:absolute;left:24px;bottom:24px;width:120px;height:120px;border-radius:50%;
  background:rgba(0,0,0,.25);border:2px solid rgba(255,255,255,.5);touch-action:none}
#pov-pip .pov-joy i{position:absolute;left:35px;top:35px;width:50px;height:50px;border-radius:50%;background:rgba(255,255,255,.6)}
#pov-pip .pov-act{position:absolute;right:28px;bottom:36px;width:84px;height:84px;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font:bold 15px sans-serif;color:#fff;background:rgba(160,40,30,.7);
  border:2px solid rgba(255,255,255,.6);touch-action:none;user-select:none}`;
    document.head.appendChild(st);
    pip = document.createElement('div');
    pip.id = 'pov-pip';
    pip.innerHTML = '<div class="pov-bar"><span class="pov-title"></span>'
      + '<span class="pov-btn" data-a="next" title="Next character">⏭ Next</span>'
      + '<span class="pov-btn" data-a="auto" title="Let the AI run your town while you ride along"></span>'
      + '<span class="pov-btn" data-a="mode" title="First person / behind the unit"></span>'
      + '<span class="pov-btn" data-a="full" title="Character mode (full screen)"></span>'
      + '<span class="pov-btn" data-a="close" title="Close">✕</span></div>'
      + '<div class="pov-hint">W/S walk · A/D turn · Space act</div>'
      + '<div class="pov-joy"><i></i></div><div class="pov-act">ACT</div>';
    titleEl = pip.querySelector('.pov-title');
    const b = a => pip.querySelector(`[data-a="${a}"]`);
    btnNext = b('next'); btnAuto = b('auto'); btnMode = b('mode'); btnFull = b('full');
    pip.querySelector('.pov-bar').insertBefore(btnCtl = document.createElement('span'), btnNext);
    btnCtl.className = 'pov-btn'; btnCtl.title = 'Steer this character yourself';
    btnCtl.onclick = () => setSteering(!steering);
    hintEl = pip.querySelector('.pov-hint'); joyEl = pip.querySelector('.pov-joy'); actEl = pip.querySelector('.pov-act');
    const knob = joyEl.querySelector('i');
    const joyMove = ev => {
      const r = joyEl.getBoundingClientRect(), R = r.width / 2;
      let dx = (ev.clientX - r.left - R) / R, dy = (ev.clientY - r.top - R) / R;
      const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
      joy.x = dx; joy.y = dy;
      knob.style.transform = `translate(${dx * 35}px,${dy * 35}px)`;
    };
    joyEl.addEventListener('pointerdown', ev => { joyEl.setPointerCapture(ev.pointerId); joyMove(ev); });
    joyEl.addEventListener('pointermove', ev => { if (joyEl.hasPointerCapture(ev.pointerId)) joyMove(ev); });
    const joyEnd = () => { joy.x = joy.y = 0; knob.style.transform = ''; };
    joyEl.addEventListener('pointerup', joyEnd); joyEl.addEventListener('pointercancel', joyEnd);
    actEl.addEventListener('pointerdown', () => { const e = entitiesById.get(followId); if (e) act(e); });
    btnMode.onclick = () => { mode = mode === 'eye' ? 'chase' : 'eye'; refreshButtons(); };
    btnFull.onclick = () => setFull(!full);
    btnAuto.onclick = () => { if (!gameOver) submitCommand({ kind: 'autopilot', on: !autopilotOn() }); };
    btnNext.onclick = () => {
      const own = ownUnits();
      if (!own.length) return;
      const next = own.find(u => u.id > followId) || own[0];
      follow(next); eye = null;
    };
    b('close').onclick = () => povClose();
    document.body.appendChild(pip);
    window.addEventListener('resize', () => { if (renderer && followId != null) { setFull(full); } });
    // Esc leaves character mode first, and steering keys never reach the map
    // (captured before input.js's handlers).
    const typing = ev => ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName); // e.g. MP chat
    window.addEventListener('keydown', ev => {
      if (followId == null || !full || typing(ev)) return;
      const k = ev.key.toLowerCase();
      if (ev.key === 'Escape') setFull(false);
      else if (steering && STEER_KEYS[k]) held.add(STEER_KEYS[k]);
      else if (steering && ev.key === ' ') { const e = entitiesById.get(followId); if (e) act(e); }
      else return;
      ev.stopPropagation(); ev.preventDefault();
    }, true);
    window.addEventListener('keyup', ev => {
      const k = ev.key.toLowerCase();
      if (STEER_KEYS[k] && held.delete(STEER_KEYS[k])) { ev.stopPropagation(); ev.preventDefault(); }
    }, true);
    window.addEventListener('blur', () => held.clear());
  }

  function povOpen(id){
    const e = entitiesById.get(id);
    if (!e || e.type !== 'unit') return;
    ensurePip();
    follow(e); eye = null;
    pip.style.display = 'block';
    setFull(full);
    loadThree().then(() => {
      if (followId !== e.id) return; // closed or switched while loading
      if (!renderer) initScene();
      resize();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    }).catch(err => {
      console.error('POV 3D: three.js failed to load', err);
      if (typeof showMsg === 'function') showMsg('3D view unavailable');
      povClose();
    });
  }

  function povClose(){
    setSteering(false);
    cancelAnimationFrame(raf); raf = 0;
    followId = null;
    if (pip) { pip.style.display = 'none'; setFull(false); }
    for (const rec of unitSprites.values()) { scene.remove(rec.sprite); rec.tex.dispose(); rec.sprite.material.dispose(); }
    unitSprites.clear();
    if (scene) dropBuildings();
  }

  // Toggle for the selected unit: open, switch to it, or close if already on it.
  function povToggle(id){
    if (followId === id) povClose(); else povOpen(id);
  }

  window.povOpen = povOpen;
  window.povClose = povClose;
  window.povToggle = povToggle;
  window.povFollowing = () => followId;
  window.povSteering = () => steering;
  window.povStats = () => ({ frames: frame, jsMs: +stats.js.toFixed(2), glMs: +stats.gl.toFixed(2), units: unitSprites.size, buildings: bldgSprites.size, walls: wallMeshes.size });
})();
