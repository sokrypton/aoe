// ---- POV 3D: Eye View (corner window) and character mode (full screen) ----
// VIEWER-ONLY: reads the world and never writes sim state; steering acts only
// through submitCommand (autopilot / possess / ordinary unit commands), so it is
// lockstep-safe. Visibility follows the viewer's own fog grid, like the map.
// three.js (vendor/three.min.js, r159) loads lazily on first open. Units are
// camera-facing billboards drawn by the real 2D art (drawUnit into offscreen
// canvases); buildings, walls, farms and resources (instanced: trees, ore,
// berries) are simple lit 3D models after that art; terrain is one textured
// plane. World tile (x,y) maps to three.js (X=x, Z=y), Y up.
(function(){
  const RANGE = 28;                  // tiles drawn around the eye
  const PX = HALF_TW * Math.SQRT2;   // iso art px per world tile across the view (~45)
  const UNIT_BUF = 112, UNIT_ANCHOR_Y = 66; // the outline pass's unit buffer (render-outlines.js)
  const SS = 1.5, SS_NEAR = 3;       // billboard canvas supersample; units near the camera get more
  const MAX_UNITS = 60;
  const STATIC_MS = 500;             // terrain/trees/building-set refresh cadence
  const BLDG_TOP = 230, BLDG_BASE = 10; // px of headroom above / margin below a footprint

  let THREE = null, loading = null;
  let renderer, scene, camera, groundTex, groundData, groundMesh, groundFor = null;
  const unitSprites = new Map(), solids = new Map(), mats = new Map(), footRow = new Map(), animals = new Map(); // animals: id → 3D sheep/bear // footRow: utype → lowest painted canvas row
  let unitBox = null, unitRod = null;
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

  function canvasTex(w, h, ss = SS){
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(w * ss); cv.height = Math.ceil(h * ss);
    const ctx = cv.getContext('2d'); ctx._ss = ss;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { cv, ctx, tex };
  }
  function clearCtx(ctx){
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(ctx._ss, 0, 0, ctx._ss, 0, 0);
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
    // Only the 3D solids are lit (ground and billboards are unlit art colors).
    // Calibrated so a model shows the art's own colors: the left (+z) face
    // renders exactly its color, the top 5% brighter, the right (+x) face at
    // the art's right/left ratio (~0.84 sRGB = 0.69 linear). Lambert divides by
    // π: ambient 0.69π lights every face; the sun (no x, so +x stays at
    // ambient) adds 0.31 to +z and 0.36 to the top.
    scene.add(new THREE.AmbientLight('#ffffff', 0.69 * Math.PI));
    const sun = new THREE.DirectionalLight('#ffffff', Math.hypot(0.31, 0.36) * Math.PI);
    sun.position.set(0, 0.36, 0.31);
    scene.add(sun);

    initShared();
    initFeatures();
    initClouds();
  }
  // Shared shapes and outline materials every model builder uses (the lab page too).
  function initShared(){
    if (unitBox) return;
    treeHits.value = Array.from({ length: 8 }, () => new THREE.Vector4(1e6, 1e6, 9, 0));
    wheatPushers.value = Array.from({ length: 8 }, () => new THREE.Vector3(1e6, 1e6, 0));
    unitBox = new THREE.BoxGeometry(1, 1, 1);
    unitRod = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
    ink = new THREE.LineBasicMaterial({ color: 0x000000 });
    hullMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 });
    hullUnionMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, depthWrite: false });
  }
  // A sky of puffy clouds (the tree crowns' idiom: clustered puffs, flat
  // undersides) round the horizon. They ride with the camera like a distant
  // sky, drift slowly on animTick, and skip the distance haze. Fixed layout.
  let clouds = null;
  function initClouds(){
    clouds = new THREE.Group();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // Barely there: a shade lighter than the sky (#9fc8e6), shading all but
    // flattened by the emissive lift — a hint of cloud, not a feature.
    // Opaque, so overlapping puffs stay one shape (see-through showed seams).
    const m = new THREE.MeshLambertMaterial({ color: '#b3d4ec', emissive: '#86b0d2', emissiveIntensity: 0.6, fog: false });
    for (let i = 0; i < 8; i++) {
      const puffs = [], n = 3 + Math.floor(rnd() * 3), w = 2.2 + rnd() * 2.8;
      for (let k = 0; k < n; k++) {
        const r = 0.7 + rnd() * 0.8, x = (k / (n - 1) - 0.5) * w;
        puffs.push(new THREE.SphereGeometry(r, 10, 7).translate(x, (rnd() - 0.3) * 0.6, (rnd() - 0.5) * 1.2));
      }
      const cloud = new THREE.Mesh(merged(puffs), m);
      const a = i / 8 * 2 * Math.PI + rnd() * 0.6, d = 24 + rnd() * 4; // inside the far plane (RANGE + 6), low near the horizon
      cloud.position.set(Math.cos(a) * d, 3.5 + rnd() * 2.5, Math.sin(a) * d);
      cloud.rotation.y = -a + Math.PI / 2; // long side across the view
      cloud.scale.set(1, 0.55, 1);         // flattened, with a flat-ish underside
      clouds.add(cloud);
    }
    scene.add(clouds);
  }

  function buildGround(){
    if (groundMesh) { scene.remove(groundMesh); groundMesh.geometry.dispose(); groundTex.dispose(); }
    groundData = new Uint8Array(MAP * MAP * 4);
    groundTex = new THREE.DataTexture(groundData, MAP, MAP);
    groundTex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(MAP, MAP);
    geo.rotateX(-Math.PI / 2);
    // No depth writes, drawn first: sprite billboards may dip below y=0.
    groundMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: groundTex, depthWrite: false }));
    groundMesh.renderOrder = -1;
    groundMesh.position.set(MAP / 2, 0, MAP / 2);
    scene.add(groundMesh);
    groundFor = map;
    dropBuildings(); // a new world reuses entity ids
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

  function bldgVisible(e){
    const f = buildingFogLevel(e);
    if (f === 0) return false;
    return f === 2 || sameSide(e.team, myTeam) || scoutedByMe.has(e.id);
  }
  function dropBuildings(){
    for (const w of solids.values()) dropSolid(w);
    solids.clear();
  }

  // col is '#rrggbb', or '#rrggbb|detail' to add a surface texture (DETAIL).
  function mat(col, twoSided){
    const k = col + (twoSided ? '/2' : '');
    let m = mats.get(k);
    if (!m) {
      const [color, detail] = col.split('|');
      // Depth offsets order near-coincident layers: ink lines over surfaces,
      // surfaces over the outline hulls (else they fight at grazing angles).
      m = new THREE.MeshLambertMaterial({ color, side: twoSided ? THREE.DoubleSide : THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      if (detail) withDetail(m, detail);
      mats.set(k, m);
    }
    return m;
  }
  // Surface detail: a tileable grey pattern multiplying the art color, mapped
  // from world position (walls: along the face × height, so courses and boards
  // stay level; flat tops: x × z) — every model gets the same scale with no
  // UVs. Subtle on purpose: the art stays clean and flat-colored.
  const DETAIL = { // [world units per tile repeat, painter]
    planks:  [0.5, (c, r) => rows(c, r, 4, true)],
    planksR: [0.5, (c, r) => { c.translate(64, 0); c.rotate(Math.PI / 2); rows(c, r, 4, true); }], // boards running the other way
    stakes:  [0.5, (c, r) => { c.translate(64, 0); c.rotate(Math.PI / 2); rows(c, r, 4, false); }], // upright palisade logs
    stone:   [0.6, (c, r) => blocks(c, r, 4, 2)],
    slabs:   [2, (c, r) => blocks(c, r, 2, 2, 0)],
    shingles:[0.4, (c, r) => blocks(c, r, 6, 6)],
    plaster: [1, (c, r) => speckle(c, r, 240)],
    soil:    [1, (c, r) => speckle(c, r, 205)],
  };
  const tone = (c, v) => { c.fillStyle = `rgb(${v},${v},${v})`; };
  function rows(c, r, n, grain){ // long boards: a tone each, a dark seam, a little grain
    const h = 64 / n;
    for (let i = 0; i < n; i++) {
      tone(c, 232 + r() * 23 | 0); c.fillRect(0, i * h, 64, h);
      tone(c, 178); c.fillRect(0, i * h, 64, 1.2);
      if (grain) for (let k = 0; k < 2; k++) { tone(c, 222); c.fillRect(r() * 48 | 0, i * h + 3 + r() * (h - 6), 10 + r() * 14, 0.8); }
    }
  }
  function blocks(c, r, n, per, bond = 0.5){ // courses of blocks (running bond), light mortar joints
    const h = 64 / n, w = 64 / per;
    for (let i = 0; i < n; i++) for (let j = -1; j < per; j++) {
      const x = (j + (i % 2) * bond) * w;
      tone(c, 228 + r() * 27 | 0); c.fillRect(x, i * h, w, h);
      tone(c, 190); c.fillRect(x, i * h, 1.2, h); c.fillRect(x, i * h, w, 1.2);
    }
  }
  function speckle(c, r, lo){
    tone(c, 255); c.fillRect(0, 0, 64, 64);
    for (let k = 0; k < 140; k++) { tone(c, lo + r() * (255 - lo) | 0); c.fillRect(r() * 64, r() * 64, 1 + r() * 2.5, 1 + r() * 2.5); }
  }
  const detailTex = new Map();
  function withDetail(m, name){
    const [span, paint] = DETAIL[name];
    let tex = detailTex.get(name);
    if (!tex) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      let seed = name.length * 977; // a fixed pattern per texture (viewer-only, but stable)
      const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      paint(cv.getContext('2d'), r);
      tex = new THREE.CanvasTexture(cv); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 4;
      detailTex.set(name, tex);
    }
    m.onBeforeCompile = sh => {
      sh.uniforms.detailMap = { value: tex }; sh.uniforms.detailScale = { value: 1 / span };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = mat3(modelMatrix) * objectNormal;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm; uniform sampler2D detailMap; uniform float detailScale;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 an = abs(normalize(vWNrm));
          vec2 duv = an.y > 0.85 ? vWPos.xz : vec2(an.x > an.z ? vWPos.z : vWPos.x, -vWPos.y);
          diffuseColor.rgb *= texture2D(detailMap, duv * detailScale).rgb;`);
    };
    m.customProgramCacheKey = () => 'detail';
  }
  const isWallLike = t => isWallBtype(t.btype) || isGateBtype(t.btype) || isTowerBtype(t.btype);
  // Half-width of what a wall link butts against: tower shaft, gate end pillar, wall pillar.
  const pillarHalf = t => isTowerBtype(t.btype) ? 0.22 : isGateBtype(t.btype) ? 7 / 32 : (t.btype === 'SWALL' ? 9 : 7) / 64;
  // Walls and gates after the art (drawBuilding wall/gate + drawWallLink): a
  // pillar per wall tile (7px palisade / 9px stone half-width, 22px tall,
  // team-colored top) and links toward same-team wall/gate/tower neighbors
  // (14px tall, as thick as the pillar, team top), pillar face to pillar face. A gate has big end pillars
  // (28px; stone tops and merlons from Castle) and a door between them that
  // slides up with gateProgress. Links run into a tower's (narrower) shaft.
  function refreshWall(e){
    const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h, gate = isGateBtype(e.btype);
    const stone = e.btype === 'SWALL' || e.btype === 'SGATE', a = ageOf(e), tc = teamColor(e.team);
    const k = e.complete ? 1 : Math.max(0.15, e.buildProgress / e.buildTime);
    const arms = [];
    for (let fy = e.y; fy < e.y + h; fy++) for (let fx = e.x; fx < e.x + w; fx++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const row = map[fy + dy], cell = row && row[fx + dx], n = cell && cell.occupied != null && entitiesById.get(cell.occupied);
        if (!n || n.id === e.id || n.team !== e.team || !isWallLike(n)) continue;
        if (dx + dy < 0 && !isTowerBtype(n.btype)) continue; // the -x/-z neighbor draws the link we share (towers draw none)
        arms.push(fx, fy, dx, dy, pillarHalf(e), pillarHalf(n));
      }
    }
    const key = k.toFixed(2) + ':' + a + ':' + tc + ':' + arms.join(',');
    let rec = solids.get(e.id);
    if (rec && rec.key === key) return;
    if (rec) dropSolid(rec);
    const g = new THREE.Group(), body = stone ? '#cfc8b6|stone' : WOOD.L + '|stakes';
    const pw = (stone ? 9 : 7) / 32, T = pw, linkH = 14 / HPX * k; // links as thick as the pillars (drawWallLink thick = pw/2 px each side)
    // A link from this pillar's face to the neighbor's (half-widths o1, o2): a slab with a team top.
    for (let i = 0; i < arms.length; i += 6) {
      const [fx, fy, dx, dy, o1, o2] = arms.slice(i, i + 6), cx = fx + 0.5, cz = fy + 0.5;
      const a0 = o1, a1 = 1 - o2;
      const x0 = dx ? Math.min(cx + dx * a0, cx + dx * a1) : cx - T / 2, x1 = dx ? Math.max(cx + dx * a0, cx + dx * a1) : cx + T / 2;
      const z0 = dy ? Math.min(cz + dy * a0, cz + dy * a1) : cz - T / 2, z1 = dy ? Math.max(cz + dy * a0, cz + dy * a1) : cz + T / 2;
      boxAt(g, topped(body, tc), x0, z0, x1, z1, 0, linkH);
    }
    if (!gate) {
      for (let fy = e.y; fy < e.y + h; fy++) for (let fx = e.x; fx < e.x + w; fx++) {
        const pH = 22 / HPX * k, cx = fx + 0.5, cz = fy + 0.5;
        boxAt(g, topped(body, tc), cx - pw / 2, cz - pw / 2, cx + pw / 2, cz + pw / 2, 0, pH);
      }
      addHulls(g);
      scene.add(g); solids.set(e.id, { obj: g, key });
      return;
    }
    // Gate: end pillars on the first and last tile of its line, a door between.
    const alongZ = h > w, n = Math.max(w, h), P = 14 / 32, pH = 28 / HPX * k;
    const ends = [[e.x + 0.5, e.y + 0.5], alongZ ? [e.x + 0.5, e.y + n - 0.5] : [e.x + n - 0.5, e.y + 0.5]];
    for (const [cx, cz] of ends) {
      boxAt(g, topped(stone ? '#c8c0ae|stone' : WOOD.L + '|stakes', a >= 2 && stone ? '#b0b0a4' : tc), cx - P / 2, cz - P / 2, cx + P / 2, cz + P / 2, 0, pH);
      if (stone && a >= 2) for (const [mx, mz] of [[0, 0], [1, 0], [0, 1], [1, 1]])
        boxAt(g, '#e0d8c6', cx - P / 2 + mx * (P - 0.1), cz - P / 2 + mz * (P - 0.1), cx - P / 2 + mx * (P - 0.1) + 0.1, cz - P / 2 + mz * (P - 0.1) + 0.1, pH, pH + 6 / HPX);
    }
    const [a0, a1] = ends, doorH = 16 / HPX * k, dt = 2 / 32; // the door slab: drawWallLink thick 2 each side
    const door = new THREE.Group(), span0 = alongZ ? a0[1] + P / 2 : a0[0] + P / 2, span1 = alongZ ? a1[1] - P / 2 : a1[0] - P / 2;
    const dx0 = alongZ ? a0[0] - dt : span0, dx1 = alongZ ? a0[0] + dt : span1, dz0 = alongZ ? span0 : a0[1] - dt, dz1 = alongZ ? span1 : a0[1] + dt;
    boxAt(door, topped('#8b5a2b|stakes', '#a5723a'), dx0, dz0, dx1, dz1, 0, doorH);
    g.add(door);
    addHulls(g);
    scene.add(g);
    solids.set(e.id, { obj: g, key, door, doorOf: e.id });
  }
  // ---- 3D building models, detailed after the 2D art ----
  // Real, lit 3D in the art's palette (WOOD / AGE_WALLS / team colors) with
  // black ink edges like its outlines, carrying the drawing's details —
  // windows, doors, half-timber, chimneys, keep parapet and merlons,
  // fascia, fences, dummies, slits, stalls — at the art's positions (screen
  // px → world via the iso axes). HPX = the art's vertical px per world unit
  // (2:1 iso = a camera 30° up, so PX·cos30°). __povIsoCheck compares a
  // model with its drawing from the exact iso angle.
  const HPX = PX * Math.sqrt(3) / 2;
  let ink = null, hullMat = null, hullUnionMat = null, edgeCache = new Map(), pyramidGeo = null;
  // Geometry made for one model (not the shared box/rod/pyramid) is freed with it.
  const own = geo => { geo.userData.own = true; return geo; };
  function dropSolid(rec){
    scene.remove(rec.obj);
    rec.obj.traverse(o => {
      if (o.geometry && o.geometry.userData.own) {
        const eg = edgeCache.get(o.geometry);
        if (eg) { eg.dispose(); edgeCache.delete(o.geometry); }
        o.geometry.dispose();
      }
    });
  }
  // Ink the silhouette + hard edges; round shapes (thresh 30°) only get rims.
  const edgesOf = (geo, thresh = 20) => { let g = edgeCache.get(geo); if (!g) { g = new THREE.EdgesGeometry(geo, thresh); edgeCache.set(geo, g); } return g; };
  // The art's bold silhouette stroke (WebGL lines are 1px): an inverted hull —
  // the shape grown by HULL on every side, back faces only, in black. Built in
  // world units from the final scale, so any caller scale keeps the stroke even.
  const HULL = 0.02;
  function inked(geo, material, x, y, z, sx, sy, sz, thresh){
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z); m.scale.set(sx, sy, sz);
    m.add(new THREE.LineSegments(edgesOf(geo, thresh), ink));
    m.userData.hullGeo = geo;
    return m;
  }
  // Add hulls to a finished model. Each vertex moves out along its averaged
  // face normal (measured at the mesh's world scale) far enough that every
  // face ends up exactly HULL out — an even stroke on boxes, slopes, folds and
  // round shapes alike (a centre-scaled copy lies almost on a slope near its
  // eave and flickers). Flat shapes (pennants) get none. Where a part stands on
  // the ground the hull spreads along it but never below: the ground writes no
  // depth, so a sunken rim would show through as a smear at the base.
  // union: one outline round the whole model (blobby animals), not one per
  // part — the hulls draw first without writing depth, then the model's own
  // surfaces paint over every hull that falls inside it (the creases between
  // puffs), leaving only the silhouette. Still depth-tested against the world.
  // Fade a model out (the 2D corpse's last-seconds fade), in two halves: the
  // outlines fade first while the parts stay solid, then the parts fade — a
  // see-through part never shows its dark outline shell through itself. Each
  // part gets its own copy of its material once.
  function fadeTo(g, a){
    g.traverse(o => {
      if (!o.isMesh) return;
      if (!o.userData.fadeOwn) { o.userData.fadeHull = o.material === hullMat || o.material === hullUnionMat;
        o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone(); o.userData.fadeOwn = true; }
      const k = o.userData.fadeHull ? Math.max(0, 2 * a - 1) : Math.min(1, 2 * a);
      for (const m of [].concat(o.material)) { m.transparent = k < 1; m.opacity = k; }
      if (o.userData.fadeHull) o.visible = k > 0.01;
    });
    g.visible = a > 0.01;
  }
  const disposeFaded = g => g.traverse(o => { if (o.userData.fadeOwn) [].concat(o.material).forEach(m => m.dispose()); });
  function addHulls(g, union = false){
    g.updateMatrixWorld(true);
    if (union) g.traverse(o => { if (o.isMesh) o.renderOrder = 2; });
    const meshes = [];
    g.traverse(o => { if (o.isMesh && o.userData.hullGeo) meshes.push(o); });
    const s = new THREE.Vector3(), M = new THREE.Matrix3(), Mi = new THREE.Matrix3(), wp = new THREE.Vector3(), off = new THREE.Vector3();
    for (const m of meshes) {
      const src = m.userData.hullGeo;
      M.setFromMatrix4(m.matrixWorld); Mi.copy(M).invert();
      m.getWorldScale(s).set(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
      const ht = m.userData.hullTube;
      if (ht) { const th = new THREE.Mesh(own(new THREE.TubeGeometry(ht.path, 12, ht.r + (m.userData.hullW || HULL) / s.x, 8, false)), union ? hullUnionMat : hullMat); if (union) th.renderOrder = 1; m.add(th); continue; }
      const hg = hullGeometry(src, s, m.userData.hullW || HULL, (i, o) => {
        if (wp.fromBufferAttribute(src.attributes.position, i).applyMatrix4(m.matrixWorld).y >= 0.004) return;
        off.copy(o).applyMatrix3(M); // on the ground: no downward growth
        if (off.y < 0) { off.y = 0; o.copy(off.applyMatrix3(Mi)); }
      });
      if (!hg) continue;
      const h = new THREE.Mesh(own(hg), union ? hullUnionMat : hullMat);
      if (union) h.renderOrder = 1;
      m.add(h);
    }
  }
  // The hull of src seen at scale s (its own units; null if too thin to show):
  // every vertex out along its averaged face normal so each face moves HW.
  // ground(i, offset) may trim a vertex's offset in place.
  function hullGeometry(src, s, HW, ground){
    const pos = src.attributes.position, idx = src.index;
    if (!src.boundingBox) src.computeBoundingBox();
    const d = new THREE.Vector3(); src.boundingBox.getSize(d);
    if (Math.min(d.x * s.x, d.y * s.y, d.z * s.z) < 0.004) return null;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), o = new THREE.Vector3();
    const vi = k => idx ? idx.getX(k) : k, triCount = (idx ? idx.count : pos.count) / 3;
    const key = i => Math.round(pos.getX(i) * 1e4) + ',' + Math.round(pos.getY(i) * 1e4) + ',' + Math.round(pos.getZ(i) * 1e4);
    const acc = new Map(); // position key → { sum, normals[] } in world-sized space
    for (let t = 0; t < triCount; t++) {
      const i0 = vi(3 * t), i1 = vi(3 * t + 1), i2 = vi(3 * t + 2);
      a.fromBufferAttribute(pos, i0).multiply(s); b.fromBufferAttribute(pos, i1).multiply(s); c.fromBufferAttribute(pos, i2).multiply(s);
      n.subVectors(b, a).cross(c.sub(a));
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();
      for (const i of [i0, i1, i2]) {
        const k = key(i); let e = acc.get(k);
        if (!e) acc.set(k, e = { sum: new THREE.Vector3(), ns: [] });
        if (!e.ns.some(q => q.dot(n) > 0.999)) { e.sum.add(n); e.ns.push(n.clone()); }
      }
    }
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const e = acc.get(key(i));
      o.set(0, 0, 0);
      if (e && e.sum.lengthSq() > 1e-9) {
        const dir = e.sum.clone().normalize();
        const L = HW / Math.max(0.33, Math.min(...e.ns.map(q => q.dot(dir))));
        o.set(dir.x * L / s.x, dir.y * L / s.y, dir.z * L / s.z);
        if (ground) ground(i, o);
      }
      out[3 * i] = pos.getX(i) + o.x; out[3 * i + 1] = pos.getY(i) + o.y; out[3 * i + 2] = pos.getZ(i) + o.z;
    }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(out, 3));
    if (idx) hg.setIndex(idx);
    return hg;
  }

  // Axis-aligned box from footprint corners (world x/z) and heights.
  // col: one color, or six per face in BoxGeometry order [+x, -x, +y, -y, +z, -z]
  // — team trim is a face's color, never an extra plate.
  const faceMats = col => Array.isArray(col) ? col.map(c => mat(c)) : mat(col);
  const topped = (body, top) => [body, body, top, body, body, body];
  function boxAt(g, col, x0, z0, x1, z1, y0, y1, inkIt = true){
    const m = inkIt ? inked(unitBox, faceMats(col), 0, 0, 0, 1, 1, 1) : new THREE.Mesh(unitBox, faceMats(col));
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); m.scale.set(x1 - x0, y1 - y0, z1 - z0);
    g.add(m); return m;
  }
  // A thin plate on one face of the box [x0,x1]×[z0,z1]: face 'x0'|'x1'|'z0'|'z1',
  // u0..u1 along that face (0 = its low-coordinate end), y0..y1 absolute,
  // standing out by d. Windows, doors, beams.
  function onFace(g, col, face, x0, z0, x1, z1, u0, u1, y0, y1, d = 0.02, inkIt = false){
    const alongZ = face[0] === 'x', at = face === 'x0' ? x0 : face === 'x1' ? x1 : face === 'z0' ? z0 : z1;
    const sgn = face[1] === '1' ? 1 : -1, a0 = alongZ ? z0 : x0, a1 = alongZ ? z1 : x1;
    const p0 = a0 + (a1 - a0) * u0, p1 = a0 + (a1 - a0) * u1, n0 = Math.min(at, at + sgn * d), n1 = Math.max(at, at + sgn * d);
    return alongZ ? boxAt(g, col, n0, p0, n1, p1, y0, y1, inkIt) : boxAt(g, col, p0, n0, p1, n1, y0, y1, inkIt);
  }
  const FACES = ['x0', 'x1', 'z0', 'z1'];
  // One-piece solids with real openings. A solid is planar faces ({loop of
  // [x,y,z], out: rough outward dir, mat, holes}); each hole ({at: bottom-centre
  // [x,y,z], w, h}) is cut through its face and tunnels T deep (reveal in the
  // face's color) to a dark back plate — the unlit interior. One mesh, so no
  // joint lines; hull from the unpierced faces so openings stay unstroked.
  const INTERIOR = '#140e08', V3 = (a) => new THREE.Vector3(...a);
  function solidGeo(faces, T, nMats, pierce, rims = []){
    const buckets = Array.from({ length: nMats + 1 }, () => []);
    const tri = (b, p0, p1, p2, want, smooth) => { // flat-shaded unless smooth(p) gives the vertex normal
      const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0));
      if (n.dot(want) < 0) { n.negate(); [p1, p2] = [p2, p1]; }
      n.normalize();
      for (const q of [p0, p1, p2]) b.push(q, smooth ? smooth(q) : n);
    };
    for (const f of faces) {
      const pts = f.loop.map(V3), n = new THREE.Vector3();
      for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y); }
      n.normalize(); if (n.dot(V3(f.out)) < 0) n.negate();
      const up = new THREE.Vector3(0, 1, 0), v = up.clone().addScaledVector(n, -n.y);
      if (v.lengthSq() < 1e-6) v.set(1, 0, 0).addScaledVector(n, -n.x);
      v.normalize(); const u = new THREE.Vector3().crossVectors(v, n), o = pts[0];
      const to2 = p => { const d = p.clone().sub(o); return new THREE.Vector2(d.dot(u), d.dot(v)); };
      const to3 = q => o.clone().addScaledVector(u, q.x).addScaledVector(v, q.y);
      const contour = pts.map(to2), holes = [];
      for (const h of pierce ? f.holes || [] : []) {
        const c = to2(V3(h.at));
        holes.push([[c.x - h.w / 2, c.y], [c.x + h.w / 2, c.y], [c.x + h.w / 2, c.y + h.h], [c.x - h.w / 2, c.y + h.h]].map(q => new THREE.Vector2(...q)));
      }
      const all = contour.concat(...holes), b = buckets[f.mat || 0];
      for (const [i0, i1, i2] of THREE.ShapeUtils.triangulateShape(contour, holes)) tri(b, to3(all[i0]), to3(all[i1]), to3(all[i2]), n, f.smooth);
      for (const h of holes) {
        const out3 = h.map(to3), in3 = out3.map(p => p.clone().addScaledVector(n, -T)), mid = out3[0].clone().add(out3[2]).multiplyScalar(0.5);
        for (let k = 0; k < 4; k++) for (const r of [out3, in3]) rims.push(r[k], r[(k + 1) % 4]); // the opening's front and back edges
        for (let k = 0; k < 4; k++) {
          const k1 = (k + 1) % 4, want = mid.clone().sub(out3[k].clone().add(out3[k1]).multiplyScalar(0.5));
          tri(b, out3[k], out3[k1], in3[k1], want); tri(b, out3[k], in3[k1], in3[k], want);
        }
        tri(buckets[nMats], in3[0], in3[1], in3[2], n); tri(buckets[nMats], in3[0], in3[2], in3[3], n);
      }
    }
    const geo = own(new THREE.BufferGeometry()), arr = [], nrm = [];
    let start = 0;
    buckets.forEach((b, m) => {
      for (let k = 0; k < b.length; k += 2) { arr.push(b[k].x, b[k].y, b[k].z); nrm.push(b[k + 1].x, b[k + 1].y, b[k + 1].z); }
      geo.addGroup(start, b.length / 2, m); start += b.length / 2;
    });
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return geo;
  }
  // Ink comes from the unpierced solid plus each opening's rims: edges traced
  // on the cut faces would catch the triangulation's slivers between openings.
  function solid(g, cols, faces, { T = 0.06, thresh } = {}){
    cols = [].concat(cols);
    const rims = [], m = new THREE.Mesh(solidGeo(faces, T, cols.length, true, rims), cols.concat(INTERIOR).map(c => mat(c)));
    const plain = solidGeo(faces, T, cols.length, false);
    m.add(new THREE.LineSegments(own(new THREE.EdgesGeometry(plain, thresh)), ink));
    if (rims.length) m.add(new THREE.LineSegments(own(new THREE.BufferGeometry().setFromPoints(rims)), ink));
    m.userData.hullGeo = plain;
    g.add(m); return m;
  }
  // Face sets. boxFaces: named x0/x1/z0/z1/top/bottom (holes go on f.<name>.holes).
  function boxFaces(x0, z0, x1, z1, y0, y1){
    const q = (a, b, c, d, out) => ({ loop: [a, b, c, d], out, holes: [] });
    return {
      x0: q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]),
      x1: q([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0]),
      z0: q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]),
      z1: q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]),
      top: q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]),
      bottom: q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]),
    };
  }
  // Gable-walled block (ridge along x, or z): the box with its gable ends
  // (faces across the ridge) raised to a pentagon; the top becomes two slopes.
  function houseFaces(x0, z0, x1, z1, wallH, rise, alongX = true){
    const f = boxFaces(x0, z0, x1, z1, 0, wallH), R = wallH + rise, xm = (x0 + x1) / 2, zm = (z0 + z1) / 2;
    delete f.top;
    if (alongX) {
      f.x0.loop.splice(3, 0, [x0, R, zm]); f.x1.loop.splice(3, 0, [x1, R, zm]);
      f.s0 = { loop: [[x0, wallH, z0], [x1, wallH, z0], [x1, R, zm], [x0, R, zm]], out: [0, 1, -1] };
      f.s1 = { loop: [[x0, wallH, z1], [x1, wallH, z1], [x1, R, zm], [x0, R, zm]], out: [0, 1, 1] };
    } else {
      f.z0.loop.splice(3, 0, [xm, R, z0]); f.z1.loop.splice(3, 0, [xm, R, z1]);
      f.s0 = { loop: [[x0, wallH, z0], [x0, wallH, z1], [xm, R, z1], [xm, R, z0]], out: [-1, 1, 0] };
      f.s1 = { loop: [[x1, wallH, z0], [x1, wallH, z1], [xm, R, z1], [xm, R, z0]], out: [1, 1, 0] };
    }
    return f;
  }
  // Tapered n-sided tower (bottom radius r0, top r1) centred on (cx, cz), facet
  // 0 facing `ang`; sides shade smooth (round) when smooth is set.
  function frustumFaces(cx, cz, r0, r1, H, n, ang, smooth){
    const at = (k, r, y) => { const t = ang + (k - 0.5) * 2 * Math.PI / n; return [cx + Math.cos(t) * r, y, cz + Math.sin(t) * r]; };
    const tilt = (r0 - r1) / H, sm = smooth && (p => new THREE.Vector3(p.x - cx, 0, p.z - cz).normalize().setY(tilt).normalize());
    const faces = [];
    for (let k = 0; k < n; k++) {
      const t = ang + k * 2 * Math.PI / n;
      faces.push({ loop: [at(k, r0, 0), at(k + 1, r0, 0), at(k + 1, r1, H), at(k, r1, H)], out: [Math.cos(t), 0, Math.sin(t)], holes: [], smooth: sm });
    }
    const ring = (r, y) => Array.from({ length: n }, (_, k) => at(k, r, y));
    faces.push({ loop: ring(r1, H), out: [0, 1, 0] }, { loop: ring(r0, 0), out: [0, -1, 0] });
    return faces;
  }
  // A hole on a named box face at fraction u along it (0 = low-coordinate end).
  const hole = (face, [x0, z0, x1, z1], u, y0, w, h) => ({
    at: face[0] === 'x' ? [face === 'x0' ? x0 : x1, y0, z0 + (z1 - z0) * u] : [x0 + (x1 - x0) * u, y0, face === 'z0' ? z0 : z1], w, h,
  });
  const SILL = 0.012; // a door's threshold: a hole may not touch its face's edge
  // A one-piece gable roof shell of thickness t over [x0,x1]×[z0,z1] (top
  // surface from eaveTop at the edges to ridgeTop mid-span), ridge along x (or z).
  // roofOn: the shell resting on houseFaces walls — its underside IS the gable
  // slope — overhanging `side` past the eaves and [end0, end1] past the gables.
  function roofShell(g, col, x0, z0, x1, z1, eaveTop, ridgeTop, t, alongX = true){
    const d = alongX ? z1 - z0 : x1 - x0;
    const sh = new THREE.Shape([[0, eaveTop], [d / 2, ridgeTop], [d, eaveTop], [d, eaveTop - t], [d / 2, ridgeTop - t], [0, eaveTop - t]].map(p => new THREE.Vector2(...p)));
    const geo = own(new THREE.ExtrudeGeometry(sh, { depth: alongX ? x1 - x0 : z1 - z0, bevelEnabled: false }));
    if (alongX) geo.rotateY(-Math.PI / 2);
    g.add(inked(geo, mat(col), alongX ? x1 : x0, 0, z0, 1, 1, 1));
  }
  function roofOn(g, col, [x0, z0, x1, z1], wallH, rise, t, alongX, side, end0, end1){
    const half = (alongX ? z1 - z0 : x1 - x0) / 2, slope = rise / half, eaveTop = wallH + t - slope * side, ridgeTop = wallH + rise + t;
    if (alongX) roofShell(g, col, x0 - end0, z0 - side, x1 + end1, z1 + side, eaveTop, ridgeTop, t, true);
    else roofShell(g, col, x0 - side, z0 - end0, x1 + side, z1 + end1, eaveTop, ridgeTop, t, false);
  }
  // Pyramid (square base side 1 at y=0, apex y=1) scaled over a footprint.
  function pyramid(g, col, x0, z0, x1, z1, y0, rise){
    if (!pyramidGeo) pyramidGeo = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4).translate(0, 0.5, 0);
    g.add(inked(pyramidGeo, mat(col), (x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, rise, z1 - z0));
  }
  function round(g, col, cx, cz, r0, r1, y0, y1, seg, inkIt = true, topCol = col){
    const geo = own(new THREE.CylinderGeometry(r1, r0, 1, seg)), ms = [mat(col), mat(topCol), mat(col)];
    const m = inkIt ? inked(geo, ms, 0, 0, 0, 1, 1, 1, seg > 8 ? 30 : 20) : new THREE.Mesh(geo, ms);
    m.position.set(cx, (y0 + y1) / 2, cz); m.scale.set(1, y1 - y0, 1);
    g.add(m); return m;
  }
  // A log lying along x (len) or z, centred at (cx, r, cz).
  // endCol colors its end faces (pale end grain).
  const log = (g, col, cx, cz, len, r, alongX = true, y = r, endCol = col) => {
    const geo = own(new THREE.CylinderGeometry(r, r, len, 14));
    if (alongX) geo.rotateZ(Math.PI / 2); else geo.rotateX(Math.PI / 2);
    const m = inked(geo, [mat(col), mat(endCol), mat(endCol)], cx, y, cz, 1, 1, 1, 30);
    m.userData.hullW = HULL * 0.45; // light: the flat end's hard rim would balloon a full outline
    g.add(m); return m;
  };
  // A small team pennant (drawPennant: 8px pole, 7px triangle flag).
  function pennant(g, x, z, y0, col){
    pole(g, '#1c1208', [x, y0, z], [x, y0 + 8 / HPX, z], 0.012, 'line');
    const t = own(new THREE.BufferGeometry());
    t.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 7 / 32, -2 / HPX, 0, 0, -4 / HPX, 0], 3));
    t.computeVertexNormals();
    g.add(inked(t, mat(col, true), x, y0 + 8 / HPX, z, 1, 1, 1));
  }
  // A faceted boulder.
  const rock = (g, col, x, z, r) => { // lowest vertex on the ground; small stones get a thinner outline
    const m = inked(own(new THREE.DodecahedronGeometry(r, 0)), mat(col), x, r * 0.55 * 0.93, z, 1.1, 0.55, 1);
    m.userData.hullW = Math.min(HULL, r * 0.25); g.add(m);
  };
  // The market stall canopy (drawBuilding MARKET stall): FLAT at height y0 over
  // the square, split along the back→front diagonal; each half fans from its
  // side corner to the diagonal in 4 slices, 2 of them team-colored.
  function awning(g, cx, cz, R, y0, c1, c2){
    const T = [cx - R, y0, cz - R], B = [cx + R, y0, cz + R], Lc = [cx - R, y0, cz + R], Rc = [cx + R, y0, cz - R];
    const P = [], groups = [];
    for (const [corner, flip] of [[Lc, false], [Rc, true]]) for (let k = 0; k < 4; k++) {
      const D0 = T.map((v, i) => v + (B[i] - v) * k / 4), D1 = T.map((v, i) => v + (B[i] - v) * (k + 1) / 4);
      P.push(...corner, ...(flip ? D0 : D1), ...(flip ? D1 : D0));
      groups.push(k % 2 === 0 ? 1 : 0);
    }
    const geo = own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    geo.computeVertexNormals();
    groups.forEach((m, i) => geo.addGroup(i * 3, 3, m));
    const m = new THREE.Mesh(geo, [mat(c1, true), mat(c2, true)]);
    m.add(new THREE.LineSegments(edgesOf(geo, 20), ink));
    g.add(m);
    // Scalloped valance: three team teeth hanging from each eave edge.
    const tH = 5 / HPX, teeth = [];
    for (const [A, Bv] of [[Lc, B], [B, Rc], [Rc, T], [T, Lc]]) for (let k = 0; k < 3; k++) {
      const p0 = A.map((v, i) => v + (Bv[i] - v) * k / 3), p1 = A.map((v, i) => v + (Bv[i] - v) * (k + 1) / 3);
      const mid = p0.map((v, i) => (v + p1[i]) / 2); mid[1] -= tH;
      teeth.push(...p0, ...mid, ...p1);
    }
    const tg = own(new THREE.BufferGeometry());
    tg.setAttribute('position', new THREE.Float32BufferAttribute(teeth, 3));
    tg.computeVertexNormals();
    const tm = new THREE.Mesh(tg, mat(c2, true));
    tm.add(new THREE.LineSegments(edgesOf(tg, 20), ink));
    g.add(tm);
  }

  // A slab over [x0,x1]×[z0,z1] falling from h0 to h1 along x or z (lean-to
  // roofs, canopies); `thick` hangs below the surface.
  function leanTo(g, col, x0, z0, x1, z1, h0, h1, alongX, thick = 0.07, inkIt = true){
    const run = alongX ? x1 - x0 : z1 - z0, len = Math.hypot(run, h1 - h0), ang = Math.atan2(h1 - h0, run);
    const m = inkIt ? inked(unitBox, faceMats(col), 0, 0, 0, 1, 1, 1) : new THREE.Mesh(unitBox, faceMats(col));
    m.position.set((x0 + x1) / 2, (h0 + h1) / 2 - thick / 2, (z0 + z1) / 2);
    m.scale.set(alongX ? len : x1 - x0, thick, alongX ? z1 - z0 : len);
    if (alongX) m.rotation.z = ang; else m.rotation.x = -ang;
    g.add(m); return m;
  }
  // A round pole of radius r from point a to b. style 'post': ink + full hull;
  // 'rod' (default): a hull scaled to its thickness, so a thin rail keeps a
  // thin outline instead of drowning in a full one; 'line': none, like the
  // art's single stroke (flagpoles).
  function pole(g, col, a, b, r, style = 'rod'){
    const A = V3(a), d = V3(b).sub(A), L = d.length();
    const m = style === 'post' ? inked(unitRod, mat(col), 0, 0, 0, 2 * r, L, 2 * r, 31) : new THREE.Mesh(unitRod, mat(col));
    if (style === 'rod') { m.userData.hullGeo = unitRod; m.userData.hullW = Math.min(HULL, r * 0.6); }
    m.scale.set(2 * r, L, 2 * r); m.position.copy(A).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    g.add(m); return m;
  }
  // Worked ground (a camp clearing, yard or plaza): paint lying on the ground,
  // no thickness, just under ground level; optional ink edge.
  function patch(g, col, x0, z0, x1, z1, outline = true){
    const m = new THREE.Mesh(own(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2)), mat(col));
    m.position.set((x0 + x1) / 2, -HULL * 1.5, (z0 + z1) / 2); // below the outline hulls' reach, so they draw whole over it (the ground itself writes no depth)
    if (outline) m.add(new THREE.LineSegments(edgesOf(m.geometry), ink));
    g.add(m); return m;
  }
  const post = (g, x, z, h, col = WOOD.post, r = 0.05) => pole(g, col, [x, 0, z], [x, h, z], r, 'post');
  // A sphere (sy squashes it) with a hull outline — sacks, nuggets, straw.
  // dome: only the upper half, sitting on y (a haystack).
  function ball(g, col, x, y, z, r, sy = 1, dome = false){
    const geo = own(dome ? new THREE.SphereGeometry(r, 14, 6, 0, 2 * Math.PI, 0, Math.PI / 2) : new THREE.SphereGeometry(r, 14, 10));
    const m = new THREE.Mesh(geo, mat(col)); m.position.set(x, y, z); m.scale.y = sy; m.userData.hullGeo = geo;
    g.add(m); return m;
  }
  // drawWavingFlag: a 22px pole (h overrides) with a finial ball, carrying a
  // 17×8.5px team flag toward the art's left (world -x,+z) that ripples in
  // loop() as the art's travelling wave (animTick; viewer-only).
  function flag(g, x, z, y0, h, col){
    const poleH = h != null ? h : 22 / HPX;
    pole(g, '#1c1208', [x, y0, z], [x, y0 + poleH, z], 0.012, 'line'); // thin, as the art's 1.5px stroke
    g.add(inked(own(new THREE.SphereGeometry(0.03, 8, 6)), mat('#1c1208'), x, y0 + poleH + 0.02, z, 1, 1, 1, 30));
    const L = 17 / PX, Hf = 8.5 / HPX, geo = own(new THREE.PlaneGeometry(L, Hf, 8, 1).translate(L / 2, -Hf / 2, 0));
    geo.userData.rest = Float32Array.from(geo.attributes.position.array);
    const f = new THREE.Mesh(geo, mat(col, true));
    f.position.set(x, y0 + poleH - 0.01, z); f.rotation.y = -3 * Math.PI / 4;
    f.name = 'flag'; f.userData.len = L; g.add(f);
    // Its ink border shares the cloth's vertices, so it waves with it.
    const nx = 9, rim = [];
    for (let i = 0; i < nx - 1; i++) rim.push(i, i + 1, nx + i, nx + i + 1);
    rim.push(0, nx, nx - 1, 2 * nx - 1);
    const edge = own(new THREE.BufferGeometry()); edge.setAttribute('position', geo.attributes.position); edge.setIndex(rim);
    f.add(new THREE.LineSegments(edge, ink));
  }


  const ageOf = e => (teamAge && isPlayerTeam(e.team)) ? teamAge[e.team] : 0;

  const MODELS = {
    // A flat tilled field (walkable: units stand on the ground, so the bed is
    // paint, not a raised block), a low planting ridge under each crop row, and
    // the art's sheaves — three splayed golden stalks with grain heads — cut
    // to stubble as the field is worked (drawBuilding FARM layout: rows,
    // stagger, jitter, lean and height all from the same per-farm seed).
    FARM(g, e){
      const w = e.w || 2, h = e.h || 2, dead = e.exhausted, fseed = e.x * 7 + e.y * 13, px = 1 / PX;
      patch(g, dead ? '#7d6a52|soil' : '#7a5a38|soil', e.x, e.y, e.x + w, e.y + h);
      const ridges = FARM_CROP_ROWS.map(t => [e.x + w / 2, 0.004, e.y + h * t, w - 0.08, 0.008, 0.06]);
      g.add(new THREE.Mesh(boxBatch(ridges), mat(dead ? '#6f5d47' : '#6b4d2e')));
      const standing = farmStanding(e), stalks = [], heads = [], stubs = [];
      const up = new THREE.Vector3(0, 1, 0);
      FARM_CROP_ROWS.forEach((t, ri) => {
        for (let i = 0; i < FARM_CROP_COLS; i++) {
          const n = ri * FARM_CROP_COLS + i;
          const x = e.x + w * farmSheafU(ri, i) + (((n * 5 + fseed) % 5) - 2) * 0.5 * px, z = e.y + h * t + (((n * 11 + fseed) % 3) - 1) * px;
          if (!standing[n]) { stubs.push([x, 0.03, z, 0.018, 0.06, 0.018]); continue; }
          const lean = (((n * 13 + fseed) % 5) - 2) * 0.55 * px, H = (6 + (((n * 3 + fseed) % 3) - 1) * 0.7) / HPX;
          for (const k of [-1, 0, 1]) { // splayed across the screen: world (1,0,-1)/√2
            const hk = H * (k ? 0.78 : 1), s = (k * 2.5 * px + lean) * Math.SQRT1_2;
            const dir = new THREE.Vector3(s, hk, -s), L = dir.length(), q = new THREE.Quaternion().setFromUnitVectors(up, dir.normalize());
            stalks.push([x + s / 2, hk / 2, z - s / 2, 0.028, L, 0.028, q]);  // the art: 1.4px stalks
            heads.push([x + s + dir.x * 0.035, hk + dir.y * 0.035, z - s + dir.z * 0.035, 0.05, 0.09, 0.05, q]); // 2×4px heads
          }
        }
      });
      if (stalks.length) {
        g.add(new THREE.Mesh(boxBatch(stalks, 'rod'), wheatMat('#c9a227')));
        g.add(new THREE.Mesh(boxBatch(heads, 'ball'), wheatMat('#e8c84a'))); // plain grain heads: no ink
      }
      if (stubs.length) g.add(new THREE.Mesh(boxBatch(stubs, 'rod'), mat('#9a7f4a')));
    },
    // Cottage under a team gable (drawGableBlock: W 32, hh 16, wall 16, roof
    // 20). Dark: plank walls; Feudal: plaster + half-timber
    // studs and mid-rail; Castle: whitewash + darker oak. A brick
    // chimney with a stone cap from Feudal on.
    HOUSE(g, e){
      const a = ageOf(e), x0 = e.x, z0 = e.y, x1 = e.x + 1, z1 = e.y + 1, box = [x0, z0, x1, z1];
      const wallH = 16 / HPX, roofH = 20 / HPX, tc = teamColor(e.team);
      const wall = a === 0 ? WOOD.plankL : AGE_WALLS[Math.min(a, 2)].gl, beam = a >= 2 ? '#57432e' : WOOD.beam;
      const thick = 0.035, rise = roofH - thick, f = houseFaces(x0, z0, x1, z1, wallH, rise);
      f.z0.holes.push(hole('z0', box, 0.5, SILL, 0.2, wallH * 0.85)); // the door, round the back: the art shows none
      solid(g, wall + (a === 0 ? '|planks' : '|plaster'), Object.values(f));
      if (a > 0) for (const f of FACES) { // half-timber frame: two studs, a mid-rail between them
        for (const t of [0.35, 0.7]) onFace(g, beam, f, ...box, t - 0.025, t + 0.025, 0, wallH, 0.012);
        for (const [u0, u1] of [[0.03, 0.325], [0.375, 0.675], [0.725, 0.97]]) onFace(g, beam, f, ...box, u0, u1, wallH * 0.5 - 0.015, wallH * 0.5 + 0.015, 0.012);
      }
      // drawGableBlock: ridge along x through the middle, 20px up; the roof
      // rests on the gable walls, overhanging 13% past the front (+x) gable,
      // 10% past the back and 5% past the eaves — so the overhang and the back
      // slope's end edge show beyond the gable, as in the art.
      roofOn(g, tc + '|shingles', box, wallH, rise, thick, true, 0.05, 0.1, 0.13);
      if (a >= 1) { // chimney: 30% along the ridge, 30% down the +z slope, 16px proud
        const cx = x0 + 0.3, cz = z0 + 0.665, top = wallH + 0.67 * roofH + 16 / HPX;
        boxAt(g, '#9a4a34', cx - 0.08, cz - 0.08, cx + 0.08, cz + 0.08, wallH, top);
        boxAt(g, '#8d857a', cx - 0.11, cz - 0.11, cx + 0.11, cz + 0.11, top, top + 3 / HPX);
      }
    },
    // Keep in the back quadrant: plank (Dark) or stone, a
    // recessed roof behind a parapet rim, a window in each face, merlons from
    // Castle. Lean-to plank roofs (team fascia) from the keep to outer posts
    // over the side quadrants (drawBuilding TC + drawTCAnnexRoof, authored 3x3
    // and scaled to 4x4).
    TC(g, e){
      const a = ageOf(e), W = e.w || 4, k = W / 3, x = e.x, z = e.y, mid = W / 2, tc = teamColor(e.team);
      const keepH = 60 * k / HPX, hK = 28 * k / HPX, hO = 18 * k / HPX, fas = 3.5 * k / HPX, rimD = 5 * k / HPX;
      const wood = a === 0, kL = wood ? WOOD.plankL + '|planks' : '#ded5c2|stone', kT = wood ? '#c8a878' : '#ece4d2';
      const box = [x, z, x + mid, z + mid], rimW = mid * (1 - 38 / 48) / 2;
      // The keep, with a real parapet: a floor recessed rimD below the rim top
      // (the art's inset roof), walled by four low parapet walls.
      const F = keepH - rimD, [i0, j0, i1, j1] = [x + rimW, z + rimW, x + mid - rimW, z + mid - rimW];
      const outer = boxFaces(...box, 0, keepH), inner = boxFaces(i0, j0, i1, j1, F, keepH), wH = 14 * k / HPX;
      for (const f of FACES) outer[f].holes.push(hole(f, box, 0.5, keepH * 0.7 - wH / 2, 8 * k / 32, wH));
      outer.x1.holes.push(hole('x1', box, 0.5, SILL, 0.3, keepH * 0.36)); // onto the court, under the lean-to (unseen from the iso angle)
      for (const f of FACES) inner[f].out = inner[f].out.map(v => -v);     // the parapet's inner faces look into the recess
      const H0 = keepH, rim = [
        [[x, H0, z], [x + mid, H0, z], [i1, H0, j0], [i0, H0, j0]], [[x + mid, H0, z], [x + mid, H0, z + mid], [i1, H0, j1], [i1, H0, j0]],
        [[x + mid, H0, z + mid], [x, H0, z + mid], [i0, H0, j1], [i1, H0, j1]], [[x, H0, z + mid], [x, H0, z], [i0, H0, j0], [i0, H0, j1]],
      ].map(loop => ({ loop, out: [0, 1, 0] }));
      solid(g, [kL, kT], [...FACES.map(f => outer[f]), outer.bottom, ...rim, ...FACES.map(f => inner[f]), { ...inner.bottom, out: [0, 1, 0], mat: 1 }], { T: 0.08 });
      if (a >= 2) for (let mx = 0; mx < 4; mx++) for (let mz = 0; mz < 4; mz++) { // flush on the parapet, corners once
        if (mx % 3 && mz % 3) continue;
        const px = x + (mid - rimW) * mx / 3, pz = z + (mid - rimW) * mz / 3;
        boxAt(g, kL, px, pz, px + rimW, pz + rimW, keepH, keepH + 7 * k / HPX);
      }
      // Lean-tos: the keep edge (hK) falling to the outer eave (hO), as thick
      // as the fascia. The team fascia is the slab's own edge faces: the outer
      // end and the sloping front edge (+x/+z in the slab's frame) that meet
      // in a V below the keep's front corner.
      const fascia = top => [tc, top, top, top, tc, top];
      leanTo(g, fascia(WOOD.plankR + '|planks'), x + mid, z, x + W, z + mid, hK, hO, true, fas);   // boards run down each slope
      leanTo(g, fascia(WOOD.plankL + '|planksR'), x, z + mid, x + mid, z + W, hK, hO, false, fas);
      // Posts under the outer corners, up to the slab's underside (the keep carries the inner edge).
      const run = W - mid, under = d => hK + (hO - hK) * d / run - fas * Math.hypot(run, hK - hO) / run;
      for (const [px, pz] of [[x + W - 0.12, z + 0.12], [x + W - 0.12, z + mid - 0.12]]) post(g, px, pz, under(px - x - mid), WOOD.post, 0.06);
      for (const [px, pz] of [[x + 0.12, z + W - 0.12], [x + mid - 0.12, z + W - 0.12]]) post(g, px, pz, under(pz - z - mid), WOOD.post, 0.06);
      // The pole stands on the keep floor, its flag 42px up (28px above the rim at Castle) (×k).
      flag(g, x + mid / 2, z + mid / 2, F, a >= 2 ? keepH + 28 * k / HPX - F : 42 * k / HPX, tc);
    },
    // A plaster hall under a team gable along the back (door in the lit gable
    // end, four windows facing the yard), a fenced training yard with straw
    // dummies; from Feudal a spear rack, a target, hay and a horse (drawBuilding
    // BARRACKS, authored 2x2 ×1.5). Yard props are thin: hull outline, no ink.
    BARRACKS(g, e){
      const x = e.x, z = e.y, W = e.w || 3, s = W / 2, tc = teamColor(e.team), a = ageOf(e);
      // BP(a, b): the art's compound grid (b across the hall → +x, a along it → -z).
      const BP = (A, B) => ({ x: x + s + (0.406 + B / 32 - 1) * s, z: z + s + (1.031 - A / 32 - 1) * s });
      const h0 = BP(30, -13), h1 = BP(-30, 13), wallH = 24 * s / HPX, roofH = 12 * s / HPX;
      const wall = AGE_WALLS[Math.min(a, 2)].gl, hall = [h0.x, h0.z, h1.x, h1.z];
      const f = houseFaces(...hall, wallH, roofH, false);
      f.z1.holes.push(hole('z1', hall, 0.5, SILL, 0.42, wallH * 0.7));                 // door, lit gable end
      for (const u of [0.18, 0.38, 0.62, 0.82]) f.x1.holes.push(hole('x1', hall, u, wallH * 0.46, 0.2, 0.19));
      solid(g, wall + '|plaster', Object.values(f));
      roofOn(g, tc + '|shingles', hall, wallH, roofH, 0.04, false, 0.06, 0.05, 0.05);
      const y0 = BP(30, 13), y1 = BP(-30, 51);
      patch(g, '#bfa38a|soil', y0.x, y0.z, y1.x, y1.z);                                    // yard
      const fh = 9 * s / HPX, posts = [[-30, 13], [-30, 26], [-30, 38.5], [-30, 51], [-15, 51], [0, 51], [15, 51], [30, 51], [30, 13], [30, 26], [30, 38.5]];
      // The fence stops a hand's width short of the hall, so both keep their outlines.
      const gap = 0.035 + 0.05, backX = BP(0, 13).x + gap;
      for (const [A, B] of posts) { const p = BP(A, B); post(g, B === 13 ? backX : p.x, p.z, fh, WOOD.post, 0.035); }
      // Two rails along the near end (a=-30), the front (b=51) and the far end (a=+30).
      const nearZ = BP(-30, 0).z, farZ = BP(30, 0).z, frontX = BP(0, 51).x;
      for (const hy of [3.5 * s / HPX, 7 * s / HPX]) { // rails at 3.5px and 7px
        pole(g, WOOD.post, [backX, hy, nearZ], [frontX, hy, nearZ], 0.018);
        pole(g, WOOD.post, [frontX, hy, farZ], [frontX, hy, nearZ], 0.018);
        pole(g, WOOD.post, [backX, hy, farZ], [frontX, hy, farZ], 0.018);
      }
      for (const [A, B] of a === 0 ? [[-12, 32], [12, 32]] : [[0, 30]]) { // straw dummy on a post: oval body, head, arm bar through the shoulders
        const p = BP(A, B), bodyY = 0.37, bodyH = 0.126, headY = bodyY + bodyH + 0.06;
        pole(g, WOOD.beam, [p.x, 0, p.z], [p.x, headY, p.z], 0.02);
        pole(g, WOOD.beam, [p.x, bodyY + bodyH * 0.6, p.z - 0.17], [p.x, bodyY + bodyH * 0.6, p.z + 0.17], 0.02);
        ball(g, '#c8a878', p.x, bodyY, p.z, 0.09, 1.4);
        ball(g, '#e2c046', p.x, headY, p.z, 0.07);
      }
      if (a >= 1) {
        // Target: a straw butt, its rings painted on the face, leaning on a splayed A-frame.
        const tp = BP(-15, 40), ty = 0.36;
        for (const dz of [-1, 1]) pole(g, WOOD.beam, [tp.x, 0, tp.z + dz * 0.14], [tp.x, ty + 0.02, tp.z + dz * 0.01], 0.015);
        const butt = own(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 16).rotateZ(-Math.PI / 2)); // top cap faces +x
        const tm = new THREE.Mesh(butt, [mat('#e2c046'), targetMat(), mat('#e2c046')]);
        tm.position.set(tp.x + 0.03, ty + 0.1, tp.z); tm.userData.hullGeo = butt; g.add(tm);
        // Spear rack: a low bench with spears standing in it.
        const rp = BP(-15, 26), bh = 0.12;
        boxAt(g, WOOD.beam, rp.x - 0.04, rp.z - 0.15, rp.x + 0.04, rp.z + 0.15, bh - 0.03, bh);
        for (const dz of [-0.12, 0.12]) pole(g, WOOD.beam, [rp.x, 0, rp.z + dz], [rp.x, bh - 0.03, rp.z + dz], 0.02);
        for (const dz of [-0.05, 0.05]) pole(g, '#8b5a2b', [rp.x + 0.033, 0, rp.z + dz], [rp.x - 0.033, 0.55, rp.z + dz], 0.01);
        // Haystack and a grazing horse (bay at Feudal, white charger at Castle).
        const hy = BP(20, 44);
        ball(g, '#d9b44a', hy.x, 0, hy.z, 0.16, 1, true);
        horse(g, BP(14, 33), a >= 2 ? '#e9e6de' : '#8b5a2b', a >= 2 ? '#9a948a' : '#3f2810', e.id * 0.37 % 1);
      }
      const fp = BP(30, 0); // on the far gable's ridge end
      flag(g, fp.x, fp.z + 0.02, wallH + roofH, 22 * s / HPX, tc);
    },
    // Hut with a door in its right face and a team pennant; in front, a log
    // pile (three logs along SE) and a chopping stump (drawBuilding LCAMP).
    // Laid out on the tile: the art's screen offsets overlap in plan.
    LCAMP(g, e){
      const hut = campHut(g, e, '#b89868|planks', '#8a6a48|shingles');
      if (!e.complete) return;
      // Everything inside the tile, in front of the hut (z > 0.625), the pile lower than its walls.
      const rr = 0.075, lz = e.y + 0.81;
      for (const dz of [-rr, rr]) log(g, '#6e473b', e.x + 0.29, lz + dz, 0.5, rr, true, rr, '#ebd2b0');
      log(g, '#6e473b', e.x + 0.29, lz, 0.5, rr, true, rr * (1 + Math.sqrt(3)), '#ebd2b0'); // resting in the two's groove
      round(g, '#8a5a3a', e.x + 0.8, e.y + 0.82, 0.1, 0.1, 0, 9 / HPX, 12, true, '#ebd2b0'); // stump with a pale cut top
      return hut;
    },
    // Same hut in dark stone; in front, an ore cart heaped with gold nuggets
    // and a pair of boulders (drawBuilding MCAMP), laid out clear of each other.
    MCAMP(g, e){
      campHut(g, e, '#7a6a55|stone', '#55483a|shingles');
      if (!e.complete) return;
      // Inside the tile, in front of the hut (z > 0.625): a two-wheeled handcart
      // heaped with gold nuggets — the tray rides on the axle between two big
      // wheels, its shafts resting on the ground ahead so it stands level-ish.
      const L = 0.17, Wd = 0.11, wr = 0.1, c = { x: e.x + 0.3, z: e.y + 0.8 }, y0 = wr, y1 = y0 + 0.11;
      boxAt(g, '#6e5138', c.x - L, c.z - Wd, c.x + L, c.z + Wd, y0, y1);
      for (const [dx, dz] of [[-0.08, -0.05], [0, -0.05], [0.08, -0.04], [-0.04, 0.05], [0.05, 0.05]])
        ball(g, '#e8b90f', c.x + dx, y1 + 0.01, c.z + dz, 0.05);
      for (const sz of [-1, 1]) {
        log(g, '#3a2f24', c.x, c.z + sz * (Wd + 0.02), 0.035, wr, false, wr); // wheel beside the tray, on the axle
        const sz2 = c.z + sz * (Wd - 0.02); // shaft: tray front → ground
        pole(g, '#6e5138', [c.x - L, y0 + 0.02, sz2], [e.x + 0.03, 0.0125, sz2], 0.0125);
      }
      for (const [x, z, r] of [[0.8, 0.8, 0.16], [0.6, 0.96, 0.06]]) rock(g, '#8b8b8b', e.x + x, e.y + z, r);
    },
    // Tapered tower (8-sided plank in the Dark Age, round masonry after) with
    // a door, a wooden cone cap and turning canvas sails (drawBuilding MILL).
    MILL(g, e){
      const a = ageOf(e), W = e.w || 2, c = centerOf(e), bw = W * HALF_TW;
      const r0 = (a === 0 ? bw * 0.52 : bw * 0.46) / PX, r1 = (a === 0 ? bw * 0.27 : bw * 0.36) / PX, H = 48 / HPX;
      // Octagonal planks, or round masonry (12 smooth facets: the front one is
      // flat and wide enough for the 9×13px door, facing the iso front).
      const seg = a === 0 ? 8 : 12, faces = frustumFaces(c.x, c.y, r0, r1, H, seg, Math.PI / 4, a > 0);
      const d = r0 * Math.cos(Math.PI / seg) * Math.SQRT1_2;
      faces[0].holes.push({ at: [c.x + d, SILL, c.y + d], w: 9 / 32, h: 13 / HPX });
      solid(g, a === 0 ? WOOD.plankL + '|planks' : '#cfc8b6|plaster', faces, { T: 0.1, thresh: 31 });
      const cap = own(new THREE.ConeGeometry(r1 + 0.03, 22 / HPX, a === 0 ? 8 : 16).rotateY(Math.PI / 8).translate(0, 11 / HPX, 0)); // corners over the octagon's
      g.add(inked(cap, mat(WOOD.L + '|shingles'), c.x, H, c.y, 1, 1, 1, 30));
      if (!e.complete) return;
      // Sails face the iso front (+x,+z); the 'sails' group turns in loop().
      // The hub stands out on a windshaft far enough that a sail pointing
      // straight down clears the tapered wall; moving it out along the view
      // diagonal is matched by a rise (tan 30°), so it holds the art's spot.
      const ap = Math.cos(Math.PI / seg), A = r0 * ap, B = (r0 - r1) / H * ap, K = Math.tan(Math.PI / 6);
      const D0 = r1 + 0.1, y0 = H + 0.06, D = Math.max(D0, (A - B * (y0 - D0 * K - 1) + 0.05) / (1 + B * K)), hy = y0 + (D - D0) * K;
      const shaft = own(new THREE.CylinderGeometry(0.04, 0.04, D - r1 * 0.5, 8).rotateX(Math.PI / 2).rotateY(Math.PI / 4));
      g.add(inked(shaft, mat(WOOD.beam), c.x + (D + r1 * 0.5) / 2 * Math.SQRT1_2, hy, c.y + (D + r1 * 0.5) / 2 * Math.SQRT1_2, 1, 1, 1, 30));
      const hub = new THREE.Group(), spin = new THREE.Group();
      hub.position.set(c.x + D * Math.SQRT1_2, hy, c.y + D * Math.SQRT1_2);
      hub.rotation.y = Math.PI / 4;
      spin.name = 'sails';
      for (let i = 0; i < 4; i++) { // drawWindmillSails: canvas blades with team bands
        const arm = new THREE.Group(); arm.rotation.z = i * Math.PI / 2 + Math.PI / 4;
        arm.add(inked(unitBox, mat(WOOD.beam), 0, 0.5, 0, 0.04, 1.0, 0.04));
        arm.add(inked(unitBox, sailMat(teamColor(e.team)), 0.17, 0.6, 0, 0.3, 0.76, 0.015)); // beside the arm, not through it
        spin.add(arm);
      }
      const hubDisc = own(new THREE.CylinderGeometry(0.12, 0.12, 0.05, 16).rotateX(Math.PI / 2));
      spin.add(inked(hubDisc, mat('#6e5138'), 0, 0, 0.02, 1, 1, 1, 30));
      hub.add(spin); g.add(hub);
    },
    // Slim shaft (timber / pale stone) with an arrow slit in each face, a
    // narrower 4px cap slab under an 8px team pyramid (bastion merlons on a
    // Castle-age stone tower) and a flag (drawBuilding tower branch).
    TOWER(g, e){
      const a = ageOf(e), isP = e.btype === 'PTOWER', x = e.x, z = e.y;
      const col = isP ? WOOD.L + '|planks' : '#cfc8b6|stone', H = (isP ? 32 : 40) / HPX, tc = teamColor(e.team);
      const box = [x + 0.28, z + 0.28, x + 0.72, z + 0.72];
      const f = boxFaces(...box, 0, H), sY = H - (isP ? 18 : 20) / HPX, sH = (isP ? 8 : 10) / HPX;
      for (const n of FACES) f[n].holes.push(hole(n, box, 0.5, sY, 0.03, sH)); // arrow slits
      f.x0.holes.push(hole('x0', box, 0.5, SILL, 0.16, H * 0.32));            // the way in, round the back
      solid(g, col, Object.values(f));
      if (!isP && a >= 2) {
        for (const [mx, mz] of [[0, 0], [1, 0], [0, 1], [1, 1]])
          boxAt(g, '#e0d8c6', box[0] + mx * 0.32, box[1] + mz * 0.32, box[0] + mx * 0.32 + 0.12, box[1] + mz * 0.32 + 0.12, H, H + 7 / HPX);
        flag(g, x + 0.5, z + 0.5, H, null, tc);
      } else {
        const c0 = [x + 0.31, z + 0.31, x + 0.69, z + 0.69], cy = H + 4 / HPX;
        boxAt(g, col, ...c0, H, cy);
        const rise = 14 / HPX; // 'peaked': roofH 8 + bhh 6 above the cap slab
        pyramid(g, tc + '|shingles', ...c0, cy, rise);
        flag(g, x + 0.5, z + 0.5, cy + rise, null, tc);
      }
    },
    // Paved plaza; on three corner tiles a stall — four posts
    // under a flat canvas canopy striped in team color with a scalloped team
    // valance — over its goods (grain sacks, gold, stone); a crate and a log
    // on the front tile (drawBuilding MARKET, drawMarketPlaza).
    MARKET(g, e){
      const x = e.x, z = e.y, W = e.w || 3, tc = teamColor(e.team), H = 20 / HPX;
      patch(g, '#b7b2a6|slabs', x, z, x + W, z + W);
      const r = 21 / 32 / 2;
      for (const [tx, tz, good] of [[0, 0, 'sacks'], [0, W - 1, 'gold'], [W - 1, 0, 'stone']]) {
        const cx = x + tx + 0.5, cz = z + tz + 0.5;
        for (const [px, pz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) post(g, cx + px, cz + pz, H - 0.025, WOOD.post, 0.028); // under the canopy, outline included
        awning(g, cx, cz, r + 0.02, H, '#efe7d2', tc);
        // drawGood: plump grain sacks / a pyramid of gold bars / squared stone blocks
        if (good === 'sacks') for (const [dx, dz] of [[-0.14, 0.03], [0.14, -0.03]]) ball(g, '#c9a86a', cx + dx, 0.12, cz + dz, 0.13, 0.92);
        if (good === 'gold') for (const [i, layer] of [[0, 0], [1, 0], [2, 0], [0.5, 1], [1.5, 1], [1, 2]]) {
          const bx = cx - 0.2 + i * 0.14, y = layer * 0.075;
          boxAt(g, '#e8b90f', bx - 0.065, cz - 0.12, bx + 0.065, cz + 0.12, y, y + 0.075);
        }
        if (good === 'stone') for (const [dx, dz, sz, y] of [[-0.13, -0.05, 0.11, 0], [0.13, 0.05, 0.11, 0], [0, 0, 0.1, 0.2]]) // two blocks, one across them
          boxAt(g, '#9a9a9a', cx + dx - sz, cz + dz - sz, cx + dx + sz, cz + dz + sz, y, y + 0.2);
      }
      const cr = { x: x + 2.47, z: z + 2.22 }, lg = { x: x + 2.52, z: z + 2.64 }; // on the front tile, clear of each other
      boxAt(g, WOOD.plankL + '|planks', cr.x - 0.2, cr.z - 0.2, cr.x + 0.2, cr.z + 0.2, 0, 0.36);
      for (const [dz, y] of [[-0.1, 0.09], [0.1, 0.09], [0, 0.09 + Math.sqrt(0.18 * 0.18 - 0.1 * 0.1)]]) log(g, '#6e473b', lg.x, lg.z + dz, 0.55, 0.09, true, y, '#ebd2b0');
    },
  };
  MODELS.PTOWER = MODELS.TOWER;

  // A horse in side profile along local x (barracks yard; drawYardHorse): a
  // rounded barrel on four tapered legs and dark hooves, an arched neck and a
  // head that narrows to the muzzle, ears, a mane and a hanging tail. The neck
  // (with the head) and the tail are pivot groups: animateModels lowers the
  // head to graze now and then and swishes the tail. Turned side-on to the iso
  // view (x → world (+x,-z)) and scaled to the art's ~0.7-tile horse.
  function horse(g, p, coat, mane, seed){
    const hg = new THREE.Group();
    hg.position.set(p.x, 0, p.z); hg.rotation.y = Math.PI / 4; hg.scale.setScalar(1.6);
    g.add(hg);
    // A tapered rod from a (radius r0) to b (radius r1), outlined thinly.
    const limb = (parent, col, a, b, r0, r1) => {
      const A = V3(a), d = V3(b).sub(A), L = d.length();
      const geo = own(new THREE.CylinderGeometry(r1, r0, L, 10).translate(0, L / 2, 0));
      const m = new THREE.Mesh(geo, mat(col)); m.position.copy(A);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      m.userData.hullGeo = geo; m.userData.hullW = Math.min(HULL, Math.max(r0, r1) * 0.6);
      parent.add(m); return m;
    };
    const legC = coat === '#e9e6de' ? '#b3ada1' : '#6e4520';
    const body = own(new THREE.CapsuleGeometry(0.1, 0.24, 4, 12).rotateZ(Math.PI / 2));
    const barrel = new THREE.Mesh(body, mat(coat)); barrel.position.y = 0.36; barrel.userData.hullGeo = body;
    hg.add(barrel);                                                        // rounded barrel
    for (const [lx, lz] of [[-0.14, -0.05], [-0.14, 0.05], [0.13, -0.05], [0.13, 0.05]]) {
      limb(hg, legC, [lx, 0.035, lz], [lx, 0.34, lz], 0.014, 0.024);    // legs, thicker toward the body
      limb(hg, '#3f2810', [lx, 0, lz], [lx, 0.04, lz], 0.02, 0.017);     // hooves
    }
    const neck = new THREE.Group(); neck.position.set(0.14, 0.4, 0); neck.name = 'horseNeck'; hg.add(neck);
    limb(neck, coat, [0, 0, 0], [0.14, 0.26, 0], 0.05, 0.032);
    limb(neck, mane, [-0.035, 0.03, 0], [0.1, 0.27, 0], 0.018, 0.013);    // mane on the crest
    const head = new THREE.Group(); head.position.set(0.14, 0.26, 0); head.name = 'horseHead'; neck.add(head);
    limb(head, coat, [-0.01, 0, 0], [0.17, -0.06, 0], 0.034, 0.021);      // head, muzzle forward
    for (const ez of [-0.018, 0.018]) limb(head, coat, [0, 0.02, ez], [-0.012, 0.07, ez * 1.2], 0.011, 0.003); // ears
    const tail = new THREE.Group(); tail.position.set(-0.23, 0.41, 0); tail.name = 'horseTail'; hg.add(tail);
    limb(tail, mane, [0, 0, 0], [-0.05, -0.22, 0], 0.02, 0.006);
    hg.userData.horseSeed = seed;
  }

  // ---- Resources: trees, gold, stone and berry bushes, in 3D ----
  // One InstancedMesh per part (its outline hull shares the instance
  // matrices), refilled from the map every STATIC_MS. Trees sway (the art's
  // wind: a per-tree sway plus rolling gusts, bent in the vertex shader),
  // fall when cut, and gold glints twinkle — viewer-only, on animTick.
  const FEAT_CAP = (2 * (RANGE + 4)) ** 2, SCREEN_X = [Math.SQRT1_2, -Math.SQRT1_2]; // iso screen-x in world
  // The art's tree (24px trunk, 12px crown) stands only villager-high in true 3D;
  // the trunk is lengthened so the canopy clears a head, the crown grown to match.
  const ART_TREE_H = 24 / HPX, TRUNK_K = 2.1, CROWN_K = 1.5;
  const TREE_H = ART_TREE_H * TRUNK_K, CROWN_R = 12 / PX * CROWN_K, TRUNK_R = 2.2 / PX * 1.35, STUMP_H = 8 / HPX;
  const wind = { value: 0 };
  const feat = {};
  let fallers = [], glints = [];
  // Bend a material in the art's wind toward screen-x, more the higher the
  // vertex. Instances may turn about y and scale, so the world wind direction
  // is taken into each instance's own frame (local y stays height).
  // Axe hits (animateFeatures): per chopped tree [x, z, seconds since the blow,
  // strike angle]; the tree shakes along the blow and settles, the crown lagging.
  const treeHits = { value: null }; // 8 × Vector4, made in initShared (THREE loads lazily)
  function swaying(m, crown = false){
    m.onBeforeCompile = sh => {
      sh.uniforms.uWind = wind; sh.uniforms.uHits = treeHits;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWind; uniform vec4 uHits[8];')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = instanceMatrix[3].xyz;
            float sw = sin(uWind * 0.015 + ip.x * 0.45 + ip.z * 0.35) * 0.035 + max(0.0, sin(uWind * 0.004 - (ip.x + ip.z) * 0.07) - 0.4) * 0.16;
            vec3 W = vec3(0.7071, 0.0, -0.7071) * sw;
            for (int i = 0; i < 8; i++) {
              vec4 h = uHits[i];
              if (distance(ip.xz, h.xy) < 0.4 && h.z < 2.0) {
                float amp = ${crown ? '0.1 * exp(-h.z * 2.4) * sin(h.z * 18.0 - 0.8)' : '0.07 * exp(-h.z * 3.2) * sin(h.z * 26.0)'};
                W += vec3(cos(h.w), 0.0, sin(h.w)) * amp;
              }
            }
            mat3 swayM = mat3(instanceMatrix); float swayK2 = dot(swayM[0], swayM[0]); // three already declares 'im'
            transformed += transpose(swayM) * W / swayK2 * (transformed.y * length(swayM[1]));
          #endif`);
    };
    m.customProgramCacheKey = () => crown ? 'sway-crown' : 'sway';
    return m;
  }
  // A part: its mesh, and a hull (built at scale s, width w) sharing its instances.
  function part(name, geo, material, s, w, hullMaterial = hullMat){
    const mesh = new THREE.InstancedMesh(geo, material, FEAT_CAP);
    mesh.count = 0; mesh.frustumCulled = false; scene.add(mesh);
    let hull = null;
    const hg = s && hullGeometry(geo, s, w, (i, o) => { if (geo.attributes.position.getY(i) < 1e-4 && o.y < 0) o.y = 0; }); // never below its base
    if (hg) { hull = new THREE.InstancedMesh(hg, hullMaterial, FEAT_CAP); hull.instanceMatrix = mesh.instanceMatrix; hull.count = 0; hull.frustumCulled = false; scene.add(hull); }
    feat[name] = { mesh, hull, n: 0 };
  }
  // Non-indexed copies of posed geometries, merged into one.
  function merged(parts){
    const pos = [], nrm = [];
    for (const g of parts) { const n = g.toNonIndexed(); pos.push(...n.attributes.position.array); nrm.push(...n.attributes.normal.array); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return geo;
  }
  function initFeatures(){
    _m = new THREE.Matrix4(); _q = new THREE.Quaternion(); _p = new THREE.Vector3(); _s = new THREE.Vector3(); _c = new THREE.Color(); _c2 = new THREE.Color(); _e = new THREE.Euler();
    FALL_AXIS = new THREE.Vector3(Math.SQRT1_2, 0, Math.SQRT1_2);
    const one = new THREE.Vector3(1, 1, 1), sway = swaying(new THREE.MeshLambertMaterial({ color: '#ffffff' })); // colored per tree
    const leaf = swaying(new THREE.MeshLambertMaterial({ color: '#ffffff' }), true), hullSway = swaying(hullMat.clone()), hullCrown = swaying(hullMat.clone(), true);
    // drawFullTreeBody: a round trunk 24px tall into a cloud of puffs (12px
    // centre, 9px cheeks round it, two 9px caps across the screen).
    const trunk = new THREE.CylinderGeometry(TRUNK_R * 0.9, TRUNK_R, TREE_H, 10).translate(0, TREE_H / 2, 0);
    // Three crown shapes so a forest isn't stamped: the art's round cloud, a
    // taller one (caps stacked higher), a wide spreading one — authored at art
    // size about the art's trunk top, then grown onto the taller trunk.
    const puff = (r, x, y, z) => new THREE.SphereGeometry(r, 9, 6).translate(x, y, z), sm = 9 / PX;
    const ring = (n, rad, y, r, rot = Math.PI / 4) => Array.from({ length: n }, (_, i) => { const a = rot + i * 2 * Math.PI / n; return puff(r, Math.cos(a) * rad, y, Math.sin(a) * rad); });
    const caps = (y, d) => [-1, 1].map(s => puff(sm, s * SCREEN_X[0] * d, y, s * SCREEN_X[1] * d));
    const cr = 12 / PX, H = ART_TREE_H;
    const crowns = [
      merged([puff(cr, 0, H, 0), ...ring(4, cr * 0.8, H - 0.04, sm), ...caps(30 / HPX, 5 / PX)]),
      merged([puff(cr * 0.9, 0, H + 0.05, 0), ...ring(3, cr * 0.65, H - 0.02, sm * 0.95, 0.3), ...caps(H + 0.2, 3 / PX), puff(sm * 0.8, 0, H + 0.3, 0)]),
      merged([puff(cr, 0, H - 0.02, 0), ...ring(5, cr * 1.0, H - 0.06, sm, 0.2), puff(sm, 0, H + 0.13, 0)]),
    ].map(c => c.translate(0, -H, 0).scale(CROWN_K, CROWN_K, CROWN_K).translate(0, TREE_H, 0));
    const crown = crowns[0];
    part('trunk', trunk, sway, one, HULL, hullSway);
    crowns.forEach((c, i) => part('crown' + i, c, leaf, one, HULL, hullCrown));
    part('trunkF', trunk, new THREE.MeshLambertMaterial({ color: '#8B4513' }), one, HULL); // felled: no sway
    part('crownF', crown, new THREE.MeshLambertMaterial({ color: '#4db536' }), one, HULL);
    part('stump', new THREE.CylinderGeometry(TRUNK_R * 1.1, TRUNK_R * 1.5, STUMP_H, 12).translate(0, STUMP_H / 2, 0),
      [mat('#8B4513'), mat('#cd853f'), mat('#8B4513')], one, HULL); // drawStump: a pale cut top
    // Ore boulders: a low-poly spun profile, flat-shaded; colored per instance.
    const rock = new THREE.LatheGeometry([[0, 0], [0.95, 0], [1.02, 0.35], [0.82, 0.74], [0.4, 0.98], [0, 1]].map(([a, b]) => new THREE.Vector2(a, b)), 7).toNonIndexed();
    rock.computeVertexNormals();
    const rs = new THREE.Vector3(0.12, 0.25, 0.12);
    part('gold', rock, new THREE.MeshPhongMaterial({ color: '#ffffff', shininess: 70, specular: '#fff3b0', flatShading: true }), rs, HULL);
    part('stone', rock, new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true }), rs, HULL);
    // Berry bushes: leaf puffs in one green (the art's lighter greens were its
    // highlights; the light makes those here) and red berries.
    part('puff', new THREE.SphereGeometry(1, 10, 7), new THREE.MeshLambertMaterial({ color: '#337a22' }), new THREE.Vector3(0.12, 0.12, 0.12), HULL);
    part('berry', new THREE.SphereGeometry(1, 8, 6), new THREE.MeshLambertMaterial({ color: '#cc3344' }), new THREE.Vector3(0.057, 0.057, 0.057), HULL * 0.6);
    // Gold glints: the art's four-point sparkle stars, facing the camera.
    const cv = document.createElement('canvas'); cv.width = cv.height = 32;
    const c = cv.getContext('2d'), r = 15, q = r * 0.28;
    c.fillStyle = '#fff8dc'; c.strokeStyle = 'rgba(120,80,0,0.5)'; c.lineWidth = 1.5; c.beginPath();
    c.moveTo(16, 16 - r); c.lineTo(16 + q, 16 - q); c.lineTo(16 + r, 16); c.lineTo(16 + q, 16 + q);
    c.lineTo(16, 16 + r); c.lineTo(16 - q, 16 + q); c.lineTo(16 - r, 16); c.lineTo(16 - q, 16 - q); c.closePath(); c.fill(); c.stroke();
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    part('glint', new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.3, fog: false }), null);
    // Contact shadows as the 2D art draws them: a flat, crisp-edged dark oval
    // on the ground under each tree, boulder, bush (shadow) and unit (shadowU,
    // refilled every frame).
    const sc = document.createElement('canvas'); sc.width = sc.height = 64;
    const sx = sc.getContext('2d');
    sx.fillStyle = 'rgba(0,0,0,0.28)'; sx.beginPath(); sx.arc(32, 32, 30, 0, 2 * Math.PI); sx.fill();
    const stex = new THREE.CanvasTexture(sc), smat = new THREE.MeshBasicMaterial({ map: stex, transparent: true, depthWrite: false });
    const sgeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    part('shadow', sgeo, smat, null); part('shadowU', sgeo, smat, null);
    // Arrows (drawProjectiles): a pale 14px shaft behind a steel head, built
    // along +y with the tip at the origin; fletched archer arrows add two
    // crossed team-color vanes at the tail.
    const L = 14 / PX, thin = new THREE.Vector3(1, 1, 1);
    part('shaft', new THREE.CylinderGeometry(0.009, 0.009, L, 6).translate(0, -L / 2, 0), new THREE.MeshLambertMaterial({ color: '#f5f2e9' }), thin, 0.006);
    part('head', new THREE.ConeGeometry(0.022, 0.07, 6).translate(0, -0.01, 0), new THREE.MeshLambertMaterial({ color: '#dde3ea' }), thin, 0.006);
    const vane = new THREE.BufferGeometry();
    vane.setAttribute('position', new THREE.Float32BufferAttribute([0, -L + 0.11, 0, 0.04, -L + 0.02, 0, 0, -L + 0.02, 0, 0, -L + 0.11, 0, 0, -L + 0.02, 0.04, 0, -L + 0.02, 0,
      0, -L + 0.11, 0, -0.04, -L + 0.02, 0, 0, -L + 0.02, 0, 0, -L + 0.11, 0, 0, -L + 0.02, -0.04, 0, -L + 0.02, 0], 3));
    vane.computeVertexNormals();
    part('vane', vane, new THREE.MeshLambertMaterial({ color: '#ffffff', side: THREE.DoubleSide }), null);
  }
  let _m, _q, _p, _s, _c, _c2, _e, FALL_AXIS; // scratch, made once THREE has loaded (initFeatures)
  function put(name, x, y, z, sx, sy, sz, rotY = 0, color){
    const f = feat[name];
    if (f.n >= FEAT_CAP) return;
    f.mesh.setMatrixAt(f.n, _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, rotY, 0)), _s.set(sx, sy, sz)));
    if (color) f.mesh.setColorAt(f.n, _c.set(color));
    f.n++;
  }
  // Within a tile of the sight line from the camera to the character (or of
  // the camera itself): a tree there would fill the view.
  function blocksView(x, z){
    const ex = eye.x - camAt.x, ez = eye.y - camAt.y, L2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - camAt.x) * ex + (z - camAt.y) * ez) / L2));
    return (x - camAt.x - t * ex) ** 2 + (z - camAt.y - t * ez) ** 2 < 1;
  }
  // A fixed 0..1 value per tile and channel n: natural variety that never flickers.
  const tileHash = (x, y, n) => { let v = (x * 73856093) ^ (y * 19349663) ^ (n * 83492791); v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };
  // Rebuild every instance list from the map (fog: explored tiles, like the ground).
  function refreshFeatures(){
    for (const k in feat) feat[k].n = 0;
    fallers = []; glints = [];
    const R = RANGE + 4, cx = Math.floor(eye.x), cy = Math.floor(eye.y);
    for (let y = Math.max(0, cy - R); y < Math.min(MAP, cy + R); y++) for (let x = Math.max(0, cx - R); x < Math.min(MAP, cx + R); x++) {
      const t = map[y][x];
      if (!t.res || t.res <= 0 || !(fog[y] && fog[y][x])) continue;
      const wx = x + 0.5, wz = y + 0.5;
      if (t.t === TERRAIN.FOREST) {
        if (blocksView(wx, wz)) continue; // never a canopy round the camera or between it and the character
        const k = 1.05 * (0.8 + ((x * 17 + y * 23) % 5) * 0.08); // the art's per-tree size noise
        const shade = (r, x0 = wx, z0 = wz) => put('shadow', x0, 0.006, z0, 2 * r, 1, 2 * r);
        if (t.res > 60) { // each tree its own: crown shape, turn, proportions, shade, a nudge off the grid
          const h = n => tileHash(x, y, n);
          const tx = wx + (h(1) - 0.5) * 0.2, tz = wz + (h(2) - 0.5) * 0.2, rot = h(3) * 6.283, kw = k * (0.9 + h(4) * 0.2), kh = k * (0.9 + h(5) * 0.22);
          shade(0.36 * CROWN_K * kw, tx, tz);
          put('trunk', tx, 0, tz, kw, kh, kw, rot, _c2.setRGB(0.545, 0.271, 0.075, THREE.SRGBColorSpace).multiplyScalar(0.9 + h(6) * 0.2).getHex());
          put('crown' + Math.floor(h(7) * 3), tx, 0, tz, kw, kh, kw, rot, _c2.setHSL(0.31 + (h(8) - 0.5) * 0.05, 0.54, 0.46 + (h(9) - 0.5) * 0.1, THREE.SRGBColorSpace).getHex());
          continue;
        }
        // drawTreeEntity: at 60 the tree is cut (its fall clock lives in
        // treeFellTicks, a render-side map) — a stump, the tree falling or lying
        // beside it while wood remains above 20, then just the stump.
        const key = x + ',' + y;
        if (!treeFellTicks.has(key)) treeFellTicks.set(key, tick);
        put('stump', wx, 0, wz, k, k, k); shade(0.14 * k);
        const falling = tick - treeFellTicks.get(key) < T30(40);
        if (falling || t.res > 20) fallers.push({ wx, wz, k, key });
      } else if (t.t === TERRAIN.GOLD || t.t === TERRAIN.STONE) {
        // A main boulder with two smaller ones tucked in behind it (the art's
        // cluster), all worn lower together as it is mined. Per tile: the whole
        // deposit 0.85–1.1×, each boulder ±10%, and the small ones at random
        // angles round it, at a distance from the actual sizes so none touch.
        const gold = t.t === TERRAIN.GOLD, p = Math.min(1, t.res / (gold ? 800 : 350)), k = 0.25 + 0.75 * p, w = 0.8 + 0.2 * p;
        const r = n => tileHash(x, y, n), size = 0.85 + 0.25 * r(20); // a narrower range, so the bulkier boulders stay near their tile
        const cols = gold ? ['#e8b90f', '#d1a017', '#c99815'] : ['#9d9d9d', '#8c8c8c', '#95958f'];
        const B = [[0.19, 0.32, 1.08, 0.94], [0.11, 0.2, 0.94, 1.06], [0.1, 0.18, 1, 0.92]]; // [half, height, x-, z-stretch]: fat and squat
        const V = B.map((_, i) => size * (0.9 + r(4 + i * 5) * 0.2));                       // each boulder's scale
        const R = B.map(([half, , sx, sz], i) => half * Math.max(sx, sz) * w * V[i] * 1.02); // its footprint radius (lathe bulge 1.02)
        B.forEach(([half, h, sx, sz], i) => {
          const vw = V[i];
          let bx = wx, bz = wz;
          if (i) { // anywhere round the main boulder; the second at least ~70° from the first so the two never touch
            const a1 = r(31) * 2 * Math.PI, a = i === 1 ? a1 : a1 + 1.2 + r(32) * (2 * Math.PI - 2.4), d = R[0] + R[i] + 0.03 + r(33 + i) * 0.05;
            bx += d * Math.cos(a); bz += d * Math.sin(a);
          }
          const hh = h * k * size * (0.9 + r(3 + i * 5) * 0.2);
          put(gold ? 'gold' : 'stone', bx, 0, bz, half * sx * w * vw, hh, half * sz * w * vw, i * 0.7 + r(5 + i * 5) * 6.283, cols[i]);
          put('shadow', bx, 0.006, bz, 3.4 * R[i], 1, 3.4 * R[i]); // reaching out past the rock's foot
          if (gold) for (const [u, v] of i === 0 ? [[0.3, -0.2], [-0.35, 0.3]] : [[0.1, 0.1]])
            glints.push({ x: bx + u * half * vw, y: hh * 1.02, z: bz + v * half * vw, size: (i === 0 ? 0.12 : 0.08) * size, phase: (x * 13 + y * 7 + glints.length * 2.3) % 6.28 });
        });
      } else if (t.t === TERRAIN.BERRIES) {
        // A low round mound of leaf puffs, stripped in two steps; berries on
        // the leaves, picked one by one (seeded per tile, like the art).
        const p = Math.min(1, t.res / 125), seed = x * 7 + y * 13;
        put('shadow', wx, 0.006, wz, 0.62, 1, 0.62);
        let puffs = [[-7, 0, 5.5, 0], [7, 0, 5, 0], [0, 0.07, 6.5, 0], [0, -0.1, 5.5, 0], [-3.5, 0, 5, 1], [4, -0.04, 4.5, 1], [0, 0, 4.5, 2]];
        if (p <= 0.33) puffs = puffs.slice(0, 4); else if (p <= 0.66) puffs = puffs.slice(0, 6);
        const P = puffs.map(([sxPx, depth, rPx, tier]) => {
          const r = rPx / PX, px = wx + sxPx / PX * SCREEN_X[0] + depth * Math.SQRT1_2, pz = wz + sxPx / PX * SCREEN_X[1] + depth * Math.SQRT1_2, py = r * 0.8 + tier * 0.085;
          put('puff', px, py, pz, r, r, r);
          return [px, py, pz, r];
        });
        for (let i = 0, n = Math.round(12 * p); i < n; i++) {
          const [bx, by, bz, r] = P[(seed + i * 5) % P.length], a = (seed + i) * 2.39996, up = 0.15 + 0.5 * (((seed + i * 3) % 4) / 4), h = Math.sqrt(1 - up * up), br = 2.6 / PX;
          put('berry', bx + Math.cos(a) * h * r, by + up * r, bz + Math.sin(a) * h * r, br, br, br);
        }
      }
    }
    for (const k in feat) { const f = feat[k]; f.mesh.count = f.n; if (f.hull) f.hull.count = f.n; f.mesh.instanceMatrix.needsUpdate = true; if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true; }
  }
  // Villagers chopping near the camera drive the trees they hit: the blow lands
  // when their 2D work swing does (render-units: phRaw = animTick·0.055 + id·0.37,
  // the strike ending as it wraps), so the shake and chips match the axe.
  const lastPh = new Map(), chips = [];
  function updateTreeHits(){
    const H = treeHits.value; let n = 0;
    for (const e of entities) {
      if (n >= 8 || e.type !== 'unit' || e.utype !== 'villager' || e.task !== 'chop' || e.path.length || !(e.gatherX >= 0)) continue;
      if ((e.x - camAt.x) ** 2 + (e.y - camAt.y) ** 2 > 400 || !atGatherTile(e, e.gatherX, e.gatherY)) continue;
      const raw = animTick * 0.055 + e.id * 0.37, ph = ((raw % 1) + 1) % 1, tx = e.gatherX + 0.5, tz = e.gatherY + 0.5;
      const ang = Math.atan2(tz - (e.y + 0.5), tx - (e.x + 0.5));
      H[n++].set(tx, tz, ph / 0.055 / 30, ang);                                        // seconds since the blow
      if (lastPh.has(e.id) && ph < lastPh.get(e.id)) chipBurst(tx - Math.cos(ang) * 0.12, 0.3, tz - Math.sin(ang) * 0.12, ang);
      lastPh.set(e.id, ph);
    }
    for (; n < 8; n++) H[n].set(1e6, 1e6, 9, 0);
  }
  function chipBurst(x, y, z, ang){ // a few wood chips thrown back off the bark, falling and fading
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(unitBox, mat(i % 2 ? '#d8b98a' : '#b88a52')); m.scale.set(0.02, 0.014, 0.026); m.position.set(x, y, z); scene.add(m);
      const sp = 0.5 + Math.random() * 0.4, a2 = ang + Math.PI + (Math.random() - 0.5) * 1.6;
      chips.push({ m, v: new THREE.Vector3(Math.cos(a2) * sp, 0.6 + Math.random() * 0.5, Math.sin(a2) * sp), age: 0 });
    }
  }
  function updateChips(dt){
    for (let i = chips.length - 1; i >= 0; i--) {
      const c = chips[i]; c.age += dt; c.v.y -= 3.4 * dt; c.m.position.addScaledVector(c.v, dt); c.m.rotation.x += dt * 12; c.m.rotation.z += dt * 9;
      if (c.m.position.y < 0.007) { c.m.position.y = 0.007; c.v.set(0, 0, 0); }
      if (c.age > 1.5) { scene.remove(c.m); chips.splice(i, 1); }
    }
  }
  // Per frame: the wind clock, falling / fallen trees, twinkling glints.
  function animateFeatures(dt = 0){
    wind.value = animTick;
    updateTreeHits(); updateChips(dt);
    // A cut tree pivots on its stump's top toward screen-right, coming to rest
    // where its crown meets the ground (~84°, the art's π/2.15).
    const T = feat.trunkF, C = feat.crownF;
    T.n = C.n = 0;
    for (const f of fallers) {
      const rest = Math.acos(Math.min(1, Math.max(0, (CROWN_R - STUMP_H) / TREE_H)));
      const u = Math.min(1, (tick - treeFellTicks.get(f.key)) / T30(40));
      _m.compose(_p.set(f.wx, STUMP_H * f.k, f.wz), _q.setFromAxisAngle(FALL_AXIS, -rest * u * u), _s.set(f.k, f.k, f.k)); // accelerating, like a real fall
      T.mesh.setMatrixAt(T.n++, _m); C.mesh.setMatrixAt(C.n++, _m);
    }
    for (const f of [T, C]) { f.mesh.count = f.n; f.hull.count = f.n; f.mesh.instanceMatrix.needsUpdate = true; }
    // Glints face the camera and twinkle: each swells and fades on its own phase.
    const G = feat.glint, face = _q.setFromAxisAngle(_p.set(0, 1, 0), Math.atan2(-Math.cos(yaw), -Math.sin(yaw)));
    G.n = 0;
    for (const g of glints) {
      const tw = Math.max(0, Math.sin(animTick * 0.05 + g.phase)) ** 3;
      if (tw < 0.05) continue;
      G.mesh.setMatrixAt(G.n++, _m.compose(_p.set(g.x, g.y, g.z), face, _s.set(g.size * tw, g.size * tw, 1)));
    }
    G.mesh.count = G.n; G.mesh.instanceMatrix.needsUpdate = true;
  }

  // Arrows in flight, as drawProjectiles flies them: launch height (chest /
  // battlements) blending to impact height, plus the distance-scaled arc,
  // each pointed along its true 3D flight line. The sim steps them 20 times
  // a second; between steps each is carried on along its path (never past
  // its aim point) so a fast arrow glides instead of hopping.
  let arrowTick = -1, arrowT0 = 0, _d;
  function updateArrows(now){
    if (tick !== arrowTick) { arrowTick = tick; arrowT0 = now; }
    const ahead = Math.min(1, (now - arrowT0) / (1000 / TPS)) * PROJECTILE_TILES_PER_TICK;
    const S = feat.shaft, Hd = feat.head, V = feat.vane, dir = _d = _d || new THREE.Vector3();
    S.n = Hd.n = V.n = 0;
    for (const p of projectiles) {
      const gx = Math.round(p.x), gy = Math.round(p.y);
      if (!Number.isFinite(gx) || !Number.isFinite(gy) || !fog[gy] || fog[gy][gx] !== 2 || S.n >= FEAT_CAP) continue;
      const rx = p.tx - p.x, ry = p.ty - p.y, left = Math.hypot(rx, ry), step = Math.min(ahead, left);
      const x = p.x + (left > 1e-6 ? rx / left * step : 0), y = p.y + (left > 1e-6 ? ry / left * step : 0);
      const D = p.totalDist, prog = D > 0.1 ? Math.max(0, Math.min(1, 1 - Math.hypot(x - p.tx, y - p.ty) / D)) : 1;
      const sH = p.startH || 12, eH = 8, A = 35 * (D / 5);
      const h = (sH + (eH - sH) * prog + Math.sin(prog * Math.PI) * A) / HPX;
      // Flight tangent: ground run over the whole flight, and d(height)/d(progress).
      const gdx = p.tx - p.startX, gdy = p.ty - p.startY;
      dir.set(gdx, ((eH - sH) + Math.cos(prog * Math.PI) * Math.PI * A) / HPX, gdy).normalize();
      _m.compose(_p.set(x + 0.5, h, y + 0.5), _q.setFromUnitVectors(_s.set(0, 1, 0), dir), _s.set(1, 1, 1));
      S.mesh.setMatrixAt(S.n++, _m); Hd.mesh.setMatrixAt(Hd.n++, _m);
      const a = p.attackerSnap; // bare shafts until the archer's team has Fletching (tower/TC bolts fly bare)
      if (a && a.utype === 'archer' && hasUpgrade(a.team, 'fletching')) { V.mesh.setMatrixAt(V.n, _m); V.mesh.setColorAt(V.n++, _c.set(teamColorLight(a.team))); }
    }
    for (const f of [S, Hd, V]) {
      f.mesh.count = f.n; if (f.hull) f.hull.count = f.n;
      f.mesh.instanceMatrix.needsUpdate = true; if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
    }
  }

  // ---- Animals in 3D: sheep and bears (other units stay art billboards) ----
  // Built from drawSheepBody / drawBearBody: art px (x forward, y down from
  // the anchor, feet at y = 5) × UNIT_SCALE (× the bear's own 1.4) → local
  // x forward, y up, z across. Named pivots are posed by animateAnimal.
  const ax = (x, k = 1) => x * UNIT_SCALE * k / PX, ah = (y, k = 1) => (5 - y) * UNIT_SCALE * k / HPX, ar = (r, k = 1) => r * UNIT_SCALE * k / PX;
  function blob(parent, col, x, y, z, rx, ry = rx, rz = rx){ // an outlined ellipsoid
    const geo = own(new THREE.SphereGeometry(1, 12, 9)), m = new THREE.Mesh(geo, mat(col));
    m.position.set(x, y, z); m.scale.set(rx, ry, rz); m.userData.hullGeo = geo; parent.add(m); return m;
  }
  // Cartoon eyes set ON a head ellipsoid's surface along (fx, fy, fz), a
  // pair mirrored across z. pale: a white eye with a dark pupil (for a dark
  // face); else a dark eye. No outline on either.
  function eyes(parent, cx, cy, cz, rx, ry, rz, fx, fy, fz, size, pale){
    const n0 = parent.children.length;
    for (const s of [-1, 1]) {
      const d = new THREE.Vector3(fx / rx, fy / ry, s * fz / rz), t = 1 / d.length(); // ray from the centre to the surface
      const p = new THREE.Vector3(cx + fx * t, cy + fy * t, cz + s * fz * t), n = new THREE.Vector3(fx / rx / rx, fy / ry / ry, s * fz / rz / rz).normalize();
      blob(parent, pale ? '#f4efe2' : '#141414', p.x, p.y, p.z, size);
      if (pale) blob(parent, '#141414', p.x + n.x * size * 0.55, p.y + n.y * size * 0.55, p.z + n.z * size * 0.55, size * 0.6);
    }
    for (const o of parent.children.slice(n0)) delete o.userData.hullGeo; // eyes carry no outline
  }
  function pivot(parent, x, y, z, name){ const p = new THREE.Group(); p.position.set(x, y, z); p.name = name; parent.add(p); return p; }
  // The funny 2D sheep, in the round: a fleece of mixed puffs on a round
  // body, slim dark legs on hooves (under the body, so they move with it), a
  // big dark face with shiny eyes, floppy ears out to the sides, a wool
  // fringe, and a team bandana tied round the neck.
  function sheepModel(tc){
    const g = new THREE.Group(), body = pivot(g, 0, 0, 0, 'body'), wool = '#f2eddd', cy = 0.27;
    blob(body, wool, 0, cy, 0, 0.24, 0.17, 0.2).name = 'core'; // a fat round fleece
    for (let i = 0; i < 8; i++) { // a few fat puffs over the upper body (golden-angle spiral)
      const v = 1 - (i + 0.5) / 8 * 1.45, r = Math.sqrt(Math.max(0, 1 - v * v)), a = i * 2.39996;
      blob(body, wool, Math.cos(a) * r * 0.21, cy + v * 0.13, Math.sin(a) * r * 0.16, 0.1 + (i % 3) * 0.012).name = 'puff';
    }
    [[-0.11, -0.075], [-0.11, 0.075], [0.1, -0.07], [0.1, 0.07]].forEach(([x, z], i) => {
      const leg = pivot(body, x, 0.16, z, 'leg' + i);
      pole(leg, '#3d3a35', [0, 0, 0], [0, -0.13, 0], 0.02);
      blob(leg, '#1e1b16', 0, -0.14, 0, 0.026, 0.02, 0.024);
    });
    const tail = pivot(body, -0.25, cy + 0.03, 0, 'tail');
    blob(tail, wool, -0.03, 0, 0, 0.045);
    const neck = pivot(body, 0.2, cy + 0.03, 0, 'neck'), hx = 0.12, hy = 0.035; // a big cartoon head
    blob(neck, '#3f3b34', hx, hy, 0, 0.1, 0.115, 0.09);
    eyes(neck, hx, hy, 0, 0.1, 0.115, 0.09, 0.55, 0.35, 0.55, 0.027, true);
    for (const z of [-1, 1]) { const ear = blob(neck, '#4d4940', hx - 0.025, hy + 0.04, z * 0.105, 0.033, 0.015, 0.06); ear.rotation.x = z * -0.35; }
    blob(neck, wool, hx - 0.01, hy + 0.105, 0, 0.05); // fringe
    const band = new THREE.Mesh(own(new THREE.TorusGeometry(0.055, 0.017, 8, 16)), mat(tc)); band.name = 'band'; // bandana round the neck
    band.position.set(0.035, -0.035, 0); band.rotation.y = Math.PI / 2; band.rotation.x = 0.3; band.userData.hullGeo = band.geometry; neck.add(band);
    return g;
  }
  // The 2D bear's cartoon mass in the round: a boulder body with a shoulder
  // hump and a lighter belly, chunky stub legs on dark paws (under the body,
  // so they rear and lunge with it), a big round head with a tan muzzle, a
  // big black nose, shiny eyes and round ears; the lower jaw hinges to maul.
  function bearModel(){
    const g = new THREE.Group(), body = pivot(g, 0, 0, 0, 'body'), fur = '#6b4a2c';
    blob(body, fur, -0.01, 0.42, 0, 0.37, 0.32, 0.27);
    blob(body, fur, -0.1, 0.6, 0, 0.21, 0.19, 0.19);            // shoulder hump
    blob(body, '#86623e', 0.02, 0.27, 0, 0.29, 0.19, 0.21);      // lighter belly
    blob(body, fur, -0.37, 0.44, 0, 0.06);                       // stub tail
    [[-0.22, -0.14], [-0.22, 0.14], [0.2, -0.14], [0.2, 0.14]].forEach(([x, z], i) => {
      const leg = pivot(body, x, 0.3, z, 'leg' + i);
      pole(leg, '#4e3520', [0, 0, 0], [0, -0.28, 0], 0.07);
      blob(leg, '#241a10', 0.015, -0.29, 0, 0.085, 0.03, 0.075);
    });
    const neck = pivot(body, 0.28, 0.5, 0, 'neck'), hx = 0.12, hy = 0.02, R = 0.17;
    blob(neck, fur, hx, hy, 0, R);
    blob(neck, '#c9a578', hx + 0.14, hy - 0.04, 0, 0.09, 0.07, 0.085);    // muzzle
    blob(neck, '#141414', hx + 0.225, hy - 0.015, 0, 0.035, 0.028, 0.04);  // big black nose
    eyes(neck, hx, hy, 0, R, R, R, 0.75, 0.45, 0.48, 0.022);
    for (const z of [-1, 1]) {
      blob(neck, fur, hx - 0.03, hy + 0.14, z * 0.1, 0.055, 0.055, 0.03);   // round ears
      blob(neck, '#4a3018', hx - 0.01, hy + 0.14, z * 0.1, 0.03, 0.035, 0.012);
    }
    const jaw = pivot(neck, hx + 0.07, hy - 0.08, 0, 'jaw');
    blob(jaw, '#a03030', 0.08, 0.02, 0, 0.07, 0.02, 0.055);   // mouth, seen when it gapes
    blob(jaw, fur, 0.08, -0.01, 0, 0.08, 0.025, 0.06);
    return g;
  }
  // Pose an animal from its state (viewer-only). A four-beat walk — hind,
  // fore, other hind, other fore — with each leg lifting on its forward
  // swing and a bob at every footfall; the phase advances by the distance
  // actually covered (a.moved) over the stride 2·L·sin A, so planted feet
  // never slide. a.gait eases in/out, so legs settle when it stops.
  const GAIT = { sheep: { A: 0.55, L: 0.14, lift: 0.03, bob: 0.01 }, bear: { A: 0.45, L: 0.28, lift: 0.05, bob: 0.02 } };
  const LEG_PHASE = [0, 0.5, 0.25, 0.75].map(f => f * 2 * Math.PI); // legs 0/1 hind, 2/3 fore
  function animateAnimal(model, e, a, dt){
    const G = GAIT[e.utype], b = model.getObjectByName('body'), neck = model.getObjectByName('neck'), idp = e.id || 0;
    const legs = [0, 1, 2, 3].map(i => model.getObjectByName('leg' + i));
    a.gait += ((a.moved > 1e-4 ? 1 : 0) - a.gait) * Math.min(1, dt * 8);
    a.phase += a.moved / (2 * G.L * Math.sin(G.A)) * 2 * Math.PI;
    const look = 0.35 * Math.sin(animTick * 0.013 + idp) ** 3 * (1 - a.gait); // now and then a slow look round
    const bob = G.bob * Math.abs(Math.sin(2 * a.phase)) * a.gait;
    let reach = 0; // bear pounce: fore legs reach, hind brace
    if (e.utype === 'sheep') {
      a.graze += ((e.eatingGrass ? 1 : 0) - a.graze) * Math.min(1, dt * 4);
      b.position.y = bob;
      b.scale.y = 1 + Math.sin(animTick * 0.06 + idp) * 0.015 * (1 - a.gait); // breathing
      neck.rotation.z = -0.95 * a.graze + Math.sin(animTick * 0.6) * 0.05 * a.graze; // head down, chewing
      neck.rotation.y = look * (1 - a.graze);
      model.getObjectByName('tail').rotation.y = Math.sin(animTick * (e.eatingGrass ? 0.35 : a.gait > 0.5 ? 0.25 : 0.08) + idp) * 0.4;
    } else {
      // The maul rides the real bite clock (atkCooldown, drawBearBody): crouch
      // back, rear up on the planted hind paws, pounce landing as the damage
      // fires, jaws snapping shut, then a worrying head-shake that decays.
      const rof = (UNITS.bear && UNITS.bear.rof) || T30(60), cd = e.atkCooldown || 0, att = inActionRange(e) && !isUnitMoving(e);
      const bp = att ? 1 - cd / rof : 0, justBit = att && cd > rof * 0.85, snap = att ? Math.max(0, (cd - rof * 0.85) / (rof * 0.15)) : 0;
      let lunge = 0, rear = 0, jaw = 0;
      if (justBit) { lunge = 4.5; jaw = Math.max(0, snap * 2 - 1); rear = -0.2; }
      else if (att && bp > 0.85) { const t = (bp - 0.85) / 0.15; lunge = -1.2 + 5.7 * t * t; rear = 0.8 * (1 - t) - 0.2; jaw = t; }
      else if (att && bp > 0.55) { const t = (bp - 0.55) / 0.3; lunge = -1.2 * t; rear = 0.8 * t; }
      const hind = -0.22, ang = rear * 0.62, c = Math.cos(ang), sn = Math.sin(ang); // rotate about the hind paws (hind, 0): up to ~30°
      b.rotation.z = ang; b.position.set(hind - hind * c + ax(lunge, 1.4), -hind * sn + bob, 0);
      b.rotation.x = Math.sin(a.phase) * 0.04 * a.gait; // a bear's rolling walk
      b.scale.y = 1 + Math.sin(animTick * 0.05 + idp) * 0.012 * (1 - a.gait) * (att ? 0 : 1);
      neck.rotation.x = Math.sin(animTick * 1.4) * 0.12 * snap; // worrying the prey
      neck.rotation.y = att ? 0 : look;
      model.getObjectByName('jaw').rotation.z = -0.7 * jaw;
      reach = Math.max(0, Math.min(1, jaw));
    }
    legs.forEach((l, i) => {
      if (l.userData.y0 === undefined) l.userData.y0 = l.position.y;
      const ph = a.phase + LEG_PHASE[i];
      l.rotation.z = G.A * Math.sin(ph) * a.gait + (i < 2 ? -0.35 : 0.45) * reach;
      l.position.y = l.userData.y0 + G.lift * Math.max(0, Math.cos(ph)) * a.gait; // off the ground on the forward swing
    });
  }
  // ---- Characters in 3D (design stage: __povCharMock) ----
  // One kit for every unit, from the 2D rig's numbers (drawBodyLayer /
  // drawUpperBody, unitEquipment): art px, x forward, y down from the ground
  // point, z lateral — the same ax/ah/ar mapping as the animals.
  // Characters are drawn upright in the art (billboard-true), so heights use PX, not the iso HPX.
  const chh = (y, k = 1) => (5 - y) * UNIT_SCALE * k / PX;
  const SKIN = '#edc9a0', HAIR = '#b58e3d', LEG = '#5b3a1e', BOOT = '#3a2412', STEEL = '#a7abb0', GOLD = '#daa520';
  const at = (x, y, z = 0) => [ax(x), chh(y), ar(z)];
  // A cartoon limb: one bendy tube along a quadratic curve a → (bent through c) → b,
  // capped round at both ends; t0..t1 draws just a stretch of it (a sleeve).
  function tube(g, col, a, c, b, r, t0 = 0, t1 = 1, c2){ // c2: a cubic a → c, c2 → b
    const curve = c2 ? new THREE.CubicBezierCurve3(V3(a), V3(c), V3(c2), V3(b)) : new THREE.QuadraticBezierCurve3(V3(a), V3(c), V3(b)), pts = [];
    for (let i = 0; i <= 8; i++) pts.push(curve.getPoint(t0 + (t1 - t0) * i / 8));
    const path = new THREE.CatmullRomCurve3(pts), geo = own(new THREE.TubeGeometry(path, 12, r, 8, false)), m = new THREE.Mesh(geo, mat(col));
    // Its outline is a fatter tube on the same curve: an even stroke however tight
    // the bend (pushing vertices out spikes where a sharp bend crowds the rings).
    m.userData.hullGeo = geo; m.userData.hullTube = { path, r }; g.add(m);
    for (const p of [pts[0], pts[8]]) blob(g, col, p.x, p.y, p.z, r);   // round ends
    return m;
  }
  // The female villager's tunic dress [radius, y] from the hem up (art px): the
  // men's round build with a short flared skirt, rising into the head so it
  // never floats; the legs show below.
  const DRESS_SHAPES = {
    tunic: [[0, -0.4], [4.2, -0.45], [4.95, -0.65], [5.3, -1.1], [5.1, -2.8], [4.8, -6], [4, -9.2], [2.3, -11.1], [1.4, -12], [0, -12.2]],  // the hem rolls under softly: an even outline, no thick band
  };
  let armProbe = null;
  const ARM_U = 5.2, ARM_F = 5.2; // art px: upper arm, forearm — every pose keeps the hand's reach within their sum
  function human(g, tc, o = {}){
    const Y = o.y || 0; // lift (a rider sits on the horse)
    const P = (x, y, z = 0) => [ax(x), chh(y) + Y, ar(z)];
    // Legs: a tube from inside the hip down to the boot (astride: bowed out over the barrel).
    if (o.riding) for (const s of [-1, 1]) { // thigh curving out round the barrel, shin down the flank to the stirrup (rider() seats this on the horse)
      tube(g, LEG, P(0, -3, s * 2), P(3.6, 0.5, s * 9.2), P(2, 5.6, s * 7.6), ar(1.15)); // short cartoon legs, as standing
      blob(g, BOOT, ...P(2.8, 6, s * 7.6), ar(1.8), ar(1), ar(1.3));
    }
    // o.feet: [[x, lift], [x, lift]] per side (art px forward / up off the ground) — the
    // knee bends forward toward the foot (a tube, so it stays one piece).
    // The hip drops with the torso's dip and each leg bends at a knee that
    // points forward (two-bone, lengths from the standing leg): crouches bend the knees.
    if (!o.noLegs && !o.riding) for (const s of [-1, 1]) {
      const [fx, lift] = (o.feet && o.feet[s > 0 ? 1 : 0]) || [0, 0], z = s * (o.dress ? 1.9 : 2.2), hipY = (o.dress ? -2 : -3) + ((o.torso && o.torso.dip) || 0);
      const foot = [fx, 3.4 - lift, z], hip = [0, hipY, z], seg = (3.4 - (o.dress ? -2 : -3)) / 2 * 1.02;
      const dx = foot[0] - hip[0], dy = foot[1] - hip[1], d = Math.hypot(dx, dy), h = Math.sqrt(Math.max(0, seg * seg - d * d / 4));
      const kn = [(hip[0] + foot[0]) / 2 + dy / d * h, (hip[1] + foot[1]) / 2 - dx / d * h, z];   // forward of the hip→foot line
      const knee = [2 * kn[0] - (hip[0] + foot[0]) / 2, 2 * kn[1] - (hip[1] + foot[1]) / 2, z];  // the hose passes through the knee
      tube(g, LEG, P(...hip), P(...knee), P(...foot), ar(o.dress ? 0.85 : 0.95));
      blob(g, BOOT, ...P(fx + 0.6, 3.9 - lift, z), ar(o.dress ? 1.3 : 1.5), ar(0.9), ar(o.dress ? 1 : 1.2));
    }
    // Upper body and head can move on their own (animation): o.torso {yaw, lean,
    // dip} turns the torso at the hips over planted legs; o.headYaw turns the
    // head at the neck. Parts keep ground-based art coords inside an offset
    // group; o.hands stay in the character's own frame (mapped into the torso's).
    const pivotAt = (parent, pt, rot) => {
      const q = new THREE.Group(), inner = new THREE.Group(); q.position.set(...P(...pt)); q.rotation.set(0, rot[0] || 0, rot[1] || 0, 'YXZ'); // yaw about the vertical, then tip about z (−: forward)
      if (rot[2]) q.position.y -= rot[2] * UNIT_SCALE / PX;
      inner.position.set(...P(...pt).map(v => -v)); q.add(inner); parent.add(q); return inner;
    };
    const tor = o.torso || {}, U = o.torso ? pivotAt(g, [0, -3], [tor.yaw || 0, -(tor.lean || 0), tor.dip || 0]) : g; // lean + = forward
    const H = o.headYaw ? pivotAt(U, [0, -10], [o.headYaw, 0]) : U;
    g.updateMatrixWorld(true);
    const toU = new THREE.Matrix4().copy(U.matrixWorld).invert().multiply(g.matrixWorld), UK = UNIT_SCALE / PX;
    const local = pt => { if (U === g) return pt; const v = V3(P(...pt)).applyMatrix4(toU); return [v.x / UK, 5 - (v.y - Y) / UK, v.z / UK]; };
    if (o.dress) { // one smooth dress from the hem up, rising into the head (DRESS_SHAPES)
      const prof = DRESS_SHAPES.tunic; // hem → skirt → waist → bust → shoulder → neck up into the head
      const hem = prof[0][1], geo = own(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(ar(r), chh(y) - chh(hem))), 20));
      const m = new THREE.Mesh(geo, mat(tc)); m.position.set(0, chh(hem) + Y, 0); m.userData.hullGeo = geo; U.add(m);
    } else blob(U, tc, ...P(0, -6), ar(4.6), ar(5), ar(4.2));                     // torso
    blob(H, SKIN, ...P(0, -14), ar(4));                                           // head
    if (o.hat !== 'great') eyes(H, ...P(0, -14), ar(4), ar(4), ar(4), 1, 0.12, 0.35, ar(0.5));
    for (const s of [-1, 1]) { // arms: an upper arm and a forearm of fixed length (ARM_U, ARM_F), one bendy tube
      const shA = [0, -8, s * (o.dress ? 3.4 : 3.9)], hand = local((o.hands && o.hands[s > 0 ? 1 : 0]) || [1, -2.4, s * 5.6]);
      if (o.dress && hand[0] < 3.5 && hand[1] > -9 && s * hand[2] > 0) hand[2] = s * Math.max(s * hand[2], 6.7); // hands at her sides hang clear of the skirt
      // The elbow (two-bone IK): where the two lengths meet, bent toward the pole —
      // back and out, a little down; a hand reaching across the body blends it
      // forward, so the arm wraps round the chest (continuous: no flicker). o.elbows overrides.
      let E = o.elbows && local(o.elbows[s > 0 ? 1 : 0]);
      if (E && o.dress) E[2] += s * 1.2;
      const D = hand.map((v, i) => v - shA[i]), d = Math.hypot(...D), n = D.map(v => v / d);
      if (!E) {
        const cross = Math.max(0, Math.min(1, (1.5 - s * hand[2]) / 5)), pole = [-0.55 + 1.75 * cross, 0.25, s * (1 - 0.6 * cross)], pd = pole[0] * n[0] + pole[1] * n[1] + pole[2] * n[2];
        const q = pole.map((v, i) => v - pd * n[i]), qL = Math.hypot(...q) || 1;
        // a near hand shortens the arm a little (cartoon give) so it keeps a soft bend, never a folded one
        const Lu = Math.min(ARM_U, Math.max(3.2, d * 0.56)), a = Math.min(d, d / 2), h = Math.sqrt(Math.max(0, Lu * Lu - a * a));
        E = shA.map((v, i) => v + n[i] * a + q[i] / qL * h);
      }
      const bend = E.map((v, i) => 2 * v - (shA[i] + hand[i]) / 2);    // the hose passes through the elbow
      if (armProbe) armProbe.push({ s, ctl: [shA, bend, hand], d, dress: !!o.dress });   // dev: __povArmCheck
      tube(U, SKIN, P(...shA), P(...bend), P(...hand), ar(1.05));
      tube(U, tc, P(...shA), P(...bend), P(...hand), ar(1.45), 0, 0.22);    // the puffy sleeve: the tube's first stretch
      blob(U, SKIN, ...P(...hand), ar(1.3));                                   // the hand
    }
    const hat = o.hat;
    if (hat === 'hair') blob(H, HAIR, ...P(-0.6, -15.6), ar(3.9), ar(3.2), ar(4.1));
    if (hat === 'long') { // straight long hair: a smooth cap over the crown to the brow, and one curtain
      // falling from the brow to the shoulders all round, open at the front for the face.
      const hm = new THREE.MeshLambertMaterial({ color: HAIR, side: THREE.DoubleSide }), R = ar(4.35);
      const cap = new THREE.Mesh(own(new THREE.SphereGeometry(R, 20, 10, 0, 2 * Math.PI, 0, 1.2)), hm);
      cap.position.set(...P(-0.2, -14)); cap.userData.hullGeo = cap.geometry; H.add(cap);
      const top = chh(-14) + Y + R * Math.cos(1.2), bot = chh(-9.4) + Y, gap = 0.95;              // to the shoulders, not past them
      const cur = new THREE.Mesh(own(new THREE.CylinderGeometry(R * Math.sin(1.2), ar(4.4), top - bot, 20, 1, true, Math.PI / 2 + gap, 2 * Math.PI - 2 * gap)), hm);
      cur.position.set(ax(-0.2), (top + bot) / 2, 0); cur.userData.hullGeo = cur.geometry; H.add(cur);
    }
    if (hat === 'hood') blob(H, tc, ...P(-0.8, -16), ar(4.4), ar(3), ar(4.4)); // a cap over the crown and back, the face left clear
    if (hat === 'kettle') { blob(H, '#8f8a7d', ...P(0, -16), ar(3.9), ar(2.8), ar(3.9)); blob(H, '#8f8a7d', ...P(0, -15.2), ar(5.6), ar(0.7), ar(5.6)); }
    if (hat === 'norman') { blob(H, '#a8adb3', ...P(-0.3, -15.6), ar(4.5), ar(3.8), ar(4.5)); blob(H, GOLD, ...P(-0.3, -15.2), ar(4.6), ar(0.9), ar(4.6)); pole(H, '#a8adb3', P(4.2, -16), P(4.3, -12.5), ar(0.7)); }
    if (hat === 'great') { // the medieval bucket helm: a flat-topped steel pail with a T of cuts to see and breathe
      const hg = own(new THREE.CylinderGeometry(ar(4.3), ar(4.5), chh(-19) - chh(-10.2), 16)), helm = new THREE.Mesh(hg, mat('#c6cdd8'));
      helm.position.set(0, (chh(-19) + chh(-10.2)) / 2 + Y, 0); helm.userData.hullGeo = hg; H.add(helm);
      const fx = ar(4.35);
      boxAt(H, '#1c1c1c', fx - ar(0.3), -ar(3.2), fx + ar(0.3), ar(3.2), chh(-14.6) + Y, chh(-16) + Y, false);   // eye slit
      for (const z of [-1.5, 1.5]) delete blob(H, '#ffffff', fx + ar(0.2), chh(-15.3) + Y, ar(z), ar(0.5), ar(0.45), ar(0.6)).userData.hullGeo; // eyes peering out, no outline
      boxAt(H, '#1c1c1c', fx - ar(0.3), -ar(0.55), fx + ar(0.3), ar(0.55), chh(-11.5) + Y, chh(-15) + Y, false); // breathing slit
      blob(H, tc, ...P(0, -20.5), ar(1.8), ar(2.6), ar(1.2));                                                    // team plume
    }
    if (o.plume) blob(H, teamColorLight ? teamColorLight(myTeam) : tc, ...P(-1.5, -20), ar(1.2), ar(4.5), ar(1));
  }
  // drawBigSword in the round: a flat blade (parallel edges tapering to a
  // point), a flat gold crossguard in the blade's own plane, a leather grip,
  // no pommel. Built with the grip's middle at the origin — that's where the
  // fist closes — then stood along `dir`. tier (attack techs): brighter
  // steel and a longer blade, as the 2D art.
  function sword(g, hand, tier = 0, dir = [0.75, 0.66, 0]){ // held out in front, tipped forward — clear of the face
    const sw = new THREE.Group(), ext = tier >= 2 ? 3 : tier >= 1 ? 1.5 : 0, k = UNIT_SCALE / PX;
    const outline = [[-2.2, 4.5], [2.2, 4.5], [1.9, 19.5 + ext], [0, 24.5 + ext], [-1.9, 19.5 + ext]];
    const blade = own(new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x * k, y * k))), { depth: 0.7 * k, bevelEnabled: false }).translate(0, 0, -0.35 * k));
    const bm = new THREE.Mesh(blade, mat(['#a7abb0', '#dde3ea', '#f2f6fb'][tier])); bm.userData.hullGeo = blade; sw.add(bm);
    boxAt(sw, GOLD, -3.8 * k, -0.9 * k, 3.8 * k, 0.9 * k, 2.7 * k, 4.5 * k);                  // crossguard
    pole(sw, '#5c3d24', [0, -2.7 * k, 0], [0, 2.7 * k, 0], 0.8 * k);                        // grip
    sw.position.copy(V3(hand)); sw.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), V3(dir).normalize());
    g.add(sw); return sw;
  }
  const spear = (g, hand) => { const h = V3(hand), d = new THREE.Vector3(0.62, 0.78, 0).normalize(); // tilted well forward, clear of the face
    pole(g, '#8B4513', h.clone().addScaledVector(d, -ar(9)).toArray(), h.clone().addScaledVector(d, ar(16)).toArray(), ar(0.8));
    const tip = new THREE.Mesh(own(new THREE.ConeGeometry(ar(1.5), ar(5), 4)), mat(STEEL)); tip.position.copy(h).addScaledVector(d, ar(18.5)); tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d); tip.userData.hullGeo = tip.geometry; g.add(tip); };
  const bow = (g, hand) => { // a shallow recurve: limb tips 10.6px above and below the riser, bowed 4px forward
    const h = V3(hand), R = ar(13.5), A = 1.4, arc = new THREE.Mesh(own(new THREE.TorusGeometry(R, ar(0.8), 6, 16, A).rotateZ(-A / 2)), mat('#b3874a'));
    arc.position.copy(h).add(new THREE.Vector3(ar(1) - R, 0, 0)); arc.userData.hullGeo = arc.geometry; g.add(arc);
    const tipX = h.x + ar(1) - R + R * Math.cos(A / 2), tipY = R * Math.sin(A / 2);
    pole(g, '#e8e8e8', [tipX, h.y + tipY, h.z], [tipX, h.y - tipY, h.z], ar(0.25), 'line'); };
  const roundShield = (g, at3, tc) => { const d = own(new THREE.CylinderGeometry(ar(4.8), ar(4.8), ar(1.2), 16).rotateZ(Math.PI / 2)); const m = new THREE.Mesh(d, mat('#a5723a')); m.position.set(...at3); m.userData.hullGeo = d; g.add(m); blob(g, '#f5f5f0', at3[0] + ar(0.7), at3[1], at3[2], ar(1.6)); };
  function kiteShield(g, at3, tc){ // white kite with a team cross, face out to the side
    const sh = new THREE.Shape([[-4.2, 5.5], [-5.6, 0], [0, -8.5], [5.6, 0], [4.2, 5.5]].map(([a, b]) => new THREE.Vector2(ar(a), ar(b)))); // flat top, point down
    const geo = own(new THREE.ExtrudeGeometry(sh, { depth: ar(1), bevelEnabled: false }));
    const m = new THREE.Mesh(geo, [mat('#f5f5f0'), mat('#7a5230')]); m.position.set(...at3); m.userData.hullGeo = geo; g.add(m);
    boxAt(m, tc, -ar(0.85), ar(1), ar(0.85), ar(1.25), -ar(6.5), ar(5), false); boxAt(m, tc, -ar(4.4), ar(1), ar(4.4), ar(1.25), ar(1), ar(2.7), false); // the cross, on the face
    return m;
  }
  // The horse (drawMountLayer ×1.35), as one flowing cartoon: a long barrel,
  // tube legs from inside the body (knees forward, hocks back) on dark hooves,
  // a thick tube neck arching up to a long head with a lighter muzzle, leaf
  // ears, the mane along the crest, a hanging tail, a small team saddle cloth.
  function horseKit(g, coat, mane, legC, tc, muzzle = legC){
    const k = 1.35, H = (x, y, z = 0) => [ax(x, k), chh(y, k), ar(z, k)], r = v => ar(v, k);
    blob(g, coat, ...H(-0.4, -6.2), r(8.2), r(4.4), r(4.7));                        // barrel
    // Saddle cloth: a shell draped over the back and down both flanks (a
    // cylinder arc along the body, hugging the barrel's cross-section).
    const cloth = own(new THREE.CylinderGeometry(1, 1, r(7), 20, 1, true, Math.PI / 2 - 1.15, 2.3).rotateZ(Math.PI / 2));
    const cm = new THREE.Mesh(cloth, new THREE.MeshLambertMaterial({ color: tc, side: THREE.DoubleSide }));
    cm.position.set(...H(-0.6, -6.2)); cm.scale.set(1, r(4.45), r(4.8)); cm.userData.hullGeo = cloth; g.add(cm);
    for (const [x, z, bend] of [[-5.4, -2.7, -1.2], [-4.6, 2.7, -1.2], [4.6, -2.7, 1], [5.4, 2.7, 1]]) { // hind (hocks back), fore (knees forward)
      tube(g, legC, H(x, -5, z), H(x + bend, 0, z), H(x, 3.9, z), r(0.95));
      blob(g, '#241408', ...H(x + 0.3, 4.3, z), r(1.3), r(0.75), r(1.1));
    }
    tube(g, coat, H(4.5, -7.5), H(8.5, -10.5), H(9.6, -14.2), r(2.3));              // neck, arched
    const head = new THREE.Group(); head.position.set(...H(10, -14)); head.rotation.z = -0.55; g.add(head); // the long head, nose down
    blob(head, coat, r(2.8), 0, 0, r(4), r(2.3), r(2.2));                           // a big cartoon head
    blob(head, muzzle, r(5.9), -r(0.2), 0, r(1.8), r(1.9), r(1.9));                // lighter muzzle
    eyes(head, r(1.9), r(0.7), 0, r(1.6), r(1.6), r(2.2), 0.2, 0.4, 0.9, r(0.5));
    for (const s of [-1, 1]) { const e = blob(head, coat, -r(0.4), r(2.1), s * r(0.9), r(0.55), r(1.4), r(0.4)); e.rotation.z = -0.3; } // leaf ears
    tube(g, mane, H(3.6, -9.5), H(7.6, -13.6), H(9.4, -15.8), r(0.95));               // mane along the crest
    tube(g, mane, H(-8.2, -7.6), H(-10.4, -4.5), H(-9.6, -0.8), r(1.05));            // tail, hanging
  }

  // A rider (legs astride — the 2D sprite had none) seated 2px back, on the horse's back (drawMountLayer: origin y −11).
  // A rider on horseKit's horse (art px): barrel centre 15.1 up, top 21.1,
  // half-width 6.35; neck and head within ±3.1 of the centre line. The torso
  // (bottom 6px above the rider's origin) sinks 1px into the saddle cloth.
  // The sword works on one side OUTSIDE the neck line (hand 6px out, the
  // blade kept ≥5px out even in a strike); the shield (if any) hangs on the
  // other arm 9px out, clear of the rider's leg and the horse's neck.
  // pose 'strike': the sword swung forward-down past the horse's head.
  function rider(tc, hat, shield, pose){
    const r = new THREE.Group(), side = shield ? -1 : 1, strike = pose === 'strike';
    const hand = strike ? [9, -9, side * 6.5] : [6.5, -7, side * 6];
    const off = shield ? [1.5, -6.5, 7.8] : [4.5, -6, -2.5];                     // shield grip, or the reins
    human(r, tc, { hat, riding: true, hands: side > 0 ? [off, hand] : [hand, off] });
    sword(r, at(...hand), 0, strike ? [0.93, -0.3, side * 0.2] : [0.5, 0.84, side * 0.2]);
    if (shield) kiteShield(r, at(1, -6.5, 9), tc).rotation.y = 0.35;           // face mostly outward, a little forward
    r.position.set(ax(-0.8), (20 - 6) * UNIT_SCALE / PX, 0);
    return r;
  }
  const wheel = (g, x, y, z, r, w, col, hub) => { // an upright wheel, axle along z
    const geo = own(new THREE.CylinderGeometry(r, r, w, 16).rotateX(Math.PI / 2)), m = new THREE.Mesh(geo, [mat(col), mat(hub), mat(hub)]);
    m.position.set(x, y, z); m.userData.hullGeo = geo; g.add(m); return m;
  };
  // drawRamBody (RAM_DIM ×1.45): a plank shed on three axles of solid wheels,
  // team fascia along the eaves, the log nosing out of a dark opening.
  function ramModel(tc){
    const g = new THREE.Group(), k = 1.45, X = x => ax(x, k), Yh = y => chh(-y + 5, k) - chh(5, k), R = r => ar(r, k); // Yh: px above ground
    // The shed: plank walls rising to closed gable ends (the building solids),
    // the log's opening cut through the front gable, the roof resting on top.
    const shed = new THREE.Group(); shed.position.y = Yh(3); g.add(shed);
    const box = [X(-12), R(-6), X(12), R(6)], wallH = Yh(9) - Yh(3), rise = Yh(17) - Yh(9), f = houseFaces(...box, wallH, rise);
    f.x1.holes.push({ at: [X(12), Yh(4) - Yh(3), 0], w: R(6.4), h: Yh(12) - Yh(4) });
    solid(shed, '#987848|planks', Object.values(f));
    roofOn(shed, '#b89868|planks', box, wallH, rise, R(1.2), true, R(1), R(1.2), R(1.2));
    for (const s of [-1, 1]) boxAt(shed, tc, X(-13.2), s * R(7.2) - R(0.6), X(13.2), s * R(7.2) + R(0.6), wallH - R(1.4), wallH - R(0.2)); // team fascia at the eaves
    log(g, '#6e473b', X(12), 0, X(12), R(2.6), true, Yh(9), '#8a6a4a');                               // the ram log, half out of the shed
    for (const x of [-8, 0, 8]) for (const s of [-1, 1]) wheel(g, X(x), Yh(3), s * R(6.7), R(3), R(1.4), '#33261a', '#5a4630');
    return g;
  }
  // drawTradeCartBody (CART_DIM ×1.32): an open team-walled bed on two spoked
  // wheels, one big grain sack, and an ox yoked ahead on shafts.
  function cartModel(tc){
    const g = new THREE.Group(), k = 1.32, X = x => ax(x, k), Yh = y => chh(-y + 5, k) - chh(5, k), R = r => ar(r, k);
    const y0 = Yh(4.2), y1 = Yh(4.2 + 7.6), w = 5, L = 9, t = 0.5; // a tall roomy bed, as the art's
    boxAt(g, '#3a2c1c', X(-L), R(-w), X(L), R(w), y0 - R(0.6), y0);                                     // floor
    for (const [a0, b0, a1, b1] of [[-L, -w, L, -w + t], [-L, w - t, L, w], [-L, -w, -L + t, w], [L - t, -w, L, w]])
      boxAt(g, topped(tc, '#b48c58'), X(a0), R(b0), X(a1), R(b1), y0, y1);                            // team walls, pale rims
    blob(g, '#cdb98c', X(0), y1 - R(0.5), 0, R(5.5), R(3.8), R(3.8));                                 // the grain sack, heaped over the rim
    for (const s of [-1, 1]) {
      // An open spoked wheel: rim, hub, six spokes.
      const cz = s * R(w + 1), cy = R(5.4), rim = new THREE.Mesh(own(new THREE.TorusGeometry(R(4.9), R(0.55), 6, 20)), mat('#5a4630'));
      rim.position.set(0, cy, cz); rim.userData.hullGeo = rim.geometry; g.add(rim);
      wheel(g, 0, cy, cz, R(1.1), R(1.2), '#5a4630', '#74593a');
      for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3, dx = Math.cos(a) * R(4.6), dy = Math.sin(a) * R(4.6); pole(g, '#74593a', [-dx, cy - dy, cz], [dx, cy + dy, cz], R(0.35)); }
      pole(g, '#6e5138', [X(L), y0 + R(2.5), s * R(5)], [X(L + 18.5), y0 + R(2.5), s * R(5)], R(0.6)); // shafts, level along the ox's sides to the yoke
    }
    // The ox (OX_PROFILE): a heavy barrel with a shoulder hump, stocky tube
    // legs, the head carried low on a thick neck with a broad muzzle and big
    // horns sweeping out and up, droopy ears, a yoke across the neck.
    const ox = new THREE.Group(); ox.position.set(X(L + 13), 0, 0); g.add(ox);
    const K = 1.2, O = (x, y, z = 0) => [ax(x, K), chh(y, K), ar(z, K)], q = v => ar(v, K), coat = '#8d6b47';
    blob(ox, coat, ...O(0, -6.5), q(8), q(5.4), q(5));                                  // heavy barrel
    blob(ox, coat, ...O(3.5, -9.8), q(3.8), q(2.6), q(3.6));                            // shoulder hump
    for (const [x, z] of [[-5, -2.6], [-4.4, 2.6], [4.4, -2.6], [5, 2.6]]) {
      tube(ox, '#705232', O(x, -5, z), O(x + 0.3, -0.5, z), O(x, 3.6, z), q(1.25));
      blob(ox, '#241408', ...O(x + 0.3, 4, z), q(1.5), q(0.8), q(1.3));
    }
    tube(ox, coat, O(6, -8), O(9, -8.8), O(10.5, -6.5), q(2.6));                       // thick neck sloping down
    blob(ox, coat, ...O(12, -5.8), q(3.4), q(3), q(3));                                 // head, low
    blob(ox, '#5a3f28', ...O(14.6, -4.3), q(1.9), q(1.7), q(2.2));                      // broad muzzle
    eyes(ox, ...O(12, -5.8), q(3.4), q(3), q(3), 0.55, 0.45, 0.75, q(0.5));
    for (const s of [-1, 1]) {
      tube(ox, '#ece4cf', O(11.2, -8.4, s * 1.8), O(11, -9.6, s * 5.8), O(10.6, -12.8, s * 6.6), q(0.75)); // horns: out, then up
      const e = blob(ox, coat, ...O(10.2, -7.2, s * 3.6), q(1.6), q(0.6), q(1)); e.rotation.x = s * 0.4; // droopy ears
    }
    tube(ox, '#5a3f28', O(-7.6, -8), O(-9.2, -4), O(-8.6, -1), q(0.8));                 // tail
    boxAt(ox, WOOD.beam, ax(5.6, K), -q(5.6), ax(7.2, K), q(5.6), chh(-11.6, K), chh(-10.2, K)); // the yoke across the neck
    for (const s of [-1, 1]) pole(ox, WOOD.beam, [ax(6.4, K), chh(-10.2, K), s * q(5)], [ax(6.4, K), chh(-6.2, K), s * q(5)], q(0.5)); // its bows down to the shafts
    return g;
  }
  // ---- Villager tools and loads (the 2D work tools: axe, pick, mallet, scythe) ----
  // A tool is built along its handle (+y), grip centre at the origin, then
  // stood along `dir` at the hands' midpoint — so both fists close on the handle.
  const HANDLE = '#8B4513', TOOL_STEEL = '#b8bfc6';
  // Upgrades: double (Double-Bit Axe: a second blade mirrored on the back),
  // bright (Gold Mining pick / Horse Collar scythe: polished steel).
  function tool(g, kind, grip, dir, up = {}, edge){ // edge: which way the head faces (the blade leads the swing)
    const t = new THREE.Group(), k = UNIT_SCALE / PX, K = v => v * k;
    const len = kind === 'scythe' ? 17 : 13;
    pole(t, HANDLE, [0, K(-len * 0.45), 0], [0, K(len * 0.55), 0], K(0.8));
    const top = K(len * 0.55);
    if (kind === 'axe') { // a flat wedge blade off one side of the handle top
      const sh = new THREE.Shape([[0.3, 1.8], [4.6, 3.2], [5, 0], [4.6, -3.2], [0.3, -1.4]].map(([x, y]) => new THREE.Vector2(K(x), K(y))));
      const geo = own(new THREE.ExtrudeGeometry(sh, { depth: K(0.7), bevelEnabled: false }).translate(0, 0, -K(0.35)));
      const m = new THREE.Mesh(geo, mat(TOOL_STEEL)); m.position.set(0, top - K(1.5), 0); m.userData.hullGeo = geo; m.userData.hullW = HULL * 0.3; t.add(m); // a thin blade keeps a thin outline (edge-on, a full one flashes as a dark sliver)
      if (up.double) { const m2 = new THREE.Mesh(geo, m.material); m2.position.copy(m.position); m2.rotation.y = Math.PI; m2.userData.hullGeo = geo; m2.userData.hullW = HULL * 0.3; t.add(m2); } // the second bit, mirrored
    }
    const steel = up.bright ? '#f2f6fb' : TOOL_STEEL;
    if (kind === 'pick') tube(t, steel, [K(-4.2), top - K(1.4), 0], [0, top + K(1.2), 0], [K(4.6), top - K(1.4), 0], K(0.7)); // a curved double point across the top
    if (kind === 'mallet') { const b = new THREE.Mesh(own(new THREE.CylinderGeometry(K(2.2), K(2.2), K(7.5), 14).rotateZ(Math.PI / 2)), mat('#b08850')); b.position.set(0, top, 0); b.userData.hullGeo = b.geometry; b.userData.hullW = HULL * 0.45; t.add(b); } // a fat wooden barrel head, lightly outlined (its hard end edges would thicken a full one)
    // a long curved blade off the top of the snath; mowing (up.mow, the snath
    // pointing down), it lies nearly flat so the tip doesn't curl up off the ground
    if (kind === 'scythe') tube(t, steel, [0, top, 0], [K(5), top + K(up.mow ? 1.2 : 1.5), 0], [K(10), top + K(up.mow ? 0.8 : -3.5), 0], K(0.6));
    const Y = V3(dir).normalize();
    t.position.copy(V3(grip)).addScaledVector(Y, K(up.out || 0)); // up.out: hands toward the handle's end — the head swings wider
    if (edge) { // local +y along the handle, local +x (the blade side) toward edge
      const Xv = V3(edge).addScaledVector(Y, -V3(edge).dot(Y)).normalize(), Z = new THREE.Vector3().crossVectors(Xv, Y);
      t.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xv, Y, Z));
    } else t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), Y);
    g.add(t); return t;
  }
  // Loads carried overhead in both hands (the 2D CARRY_UP ~20px): logs, stone,
  // gold, and the three foods — a wheat sheaf, a wool bundle, a heap of berries.
  function load(g, kind, at3, sc = 1.5){
    const L = new THREE.Group(), K = v => ar(v * sc); L.position.set(...at3); g.add(L); // loads exaggerated, cartoon-big
    if (kind === 'wood') for (const z of [-1.7, 1.7]) log(L, '#6e473b', 0, K(z), K(13), K(1.9), true, 0, '#ebd2b0');
    if (kind === 'stone') for (const [x, y, z] of [[-2, 0, 0], [2, 0.2, 0.6], [0, 3, 0.2]]) boxAt(L, '#9d9d9d', K(x - 2.1), K(z - 2.1), K(x + 2.1), K(z + 2.1), K(y - 1.6), K(y + 1.6));
    if (kind === 'gold') for (const [x, y, z] of [[-2, 0, 0], [2, 0, 0.6], [0, 0, -2], [0, 2.1, 0.2], [1.1, 1.6, 1.8]]) blob(L, '#e8b90f', K(x), K(y), K(z), K(1.9));
    if (kind === 'food') { // a wheat sheaf: nine stalks pinched at the tie, fanning to grain heads at one end and stubble at the other
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const pin = [0, K(a * 0.35), K(b * 0.35)], head = [K(5.2), K(a * 1.9), K(b * 1.9)];
        pole(L, '#d4ab2c', [K(-4), K(a * 0.9), K(b * 0.9)], pin, K(0.5));               // stubble end
        pole(L, '#d4ab2c', pin, head, K(0.5));                                          // up to the head
        const h = blob(L, '#e8c84a', head[0] + K(1.2), head[1] * 1.12, head[2] * 1.12, K(1.7), K(0.85), K(0.85));
        h.rotation.z = a * 0.3; h.rotation.y = -b * 0.3;
      }
      const tie = new THREE.Mesh(own(new THREE.TorusGeometry(K(0.9), K(0.4), 6, 14).rotateY(Math.PI / 2)), mat('#8b5a2b'));
      tie.userData.hullGeo = tie.geometry; L.add(tie);                                  // the cord round the middle
    }
    if (kind === 'wool') // a fluffy bundle of fleece, like the sheep's
      for (const [x, y, z, r] of [[0, 0, 0, 2.6], [-2.2, -0.3, 0.8, 2], [2.2, -0.2, -0.6, 2.1], [0.4, 1.8, 0.2, 1.9], [-0.8, 0.2, -1.8, 1.8], [1, 0.3, 1.9, 1.8]]) blob(L, '#f2eddd', K(x), K(y), K(z), K(r));
    if (kind === 'berries') // a heap of red berries
      for (let n = 0; n < 11; n++) {
        const a = n * 2.39996, rr = n < 7 ? 1.9 : 0.9;
        blob(L, '#cc3344', K(Math.cos(a) * rr), K(n < 7 ? 0 : 1.3) + K((n % 2) * 0.3), K(Math.sin(a) * rr), K(1.05));
      }
    return L;
  }
  // The Wheelbarrow / Heavy Plow rig (BARROW_DIM, drawBarrow): handles from the
  // villager's hands (9.2px up, ±3.1) forward to a wheel 22px ahead. The barrow
  // carries a wooden tray and the load in it; the plow swaps the tray for a
  // steel share cutting the soil. World px along +x, heights up from the ground.
  function barrowRig(g, kind, what){
    const b = new THREE.Group(), K = v => v * UNIT_SCALE / PX, wood = WOOD.plankL + '|planks'; g.add(b);
    b.scale.setScalar(1.25); b.position.x = K(1.8) * (1 - 1.25); // cartoon-big, scaled about the ground under the grips (the grips rise to 11.5)
    for (const z of [-1, 1]) pole(b, WOOD.beam, [K(1.8), K(9.2), z * K(3.1)], [K(22), K(3.6), z * K(1.6)], K(0.6)); // handles running to the axle ends, either side of the wheel
    wheel(b, K(22), K(3.6), 0, K(3.6), K(1.5), '#5a4630', '#74593a').userData.hullW = HULL * 0.45;         // a light outline on the wheel
    for (const z of [-1, 1]) delete wheel(b, K(22), K(3.6), z * K(0.9), K(1.1), K(0.4), '#3a2c1c', '#3a2c1c').userData.hullGeo; // hub caps
    pole(b, WOOD.beam, [K(22), K(3.6), -K(1.9)], [K(22), K(3.6), K(1.9)], K(0.5));                              // axle through the wheel, into both handles
    if (kind === 'barrow') {
      // An open tray, flared: a narrow base, a wide rim, the front raked forward over the wheel.
      const B = [[K(9), K(2.7), -K(2.4)], [K(16), K(2.7), -K(2.4)], [K(16), K(2.7), K(2.4)], [K(9), K(2.7), K(2.4)]];
      const T = [[K(7.5), K(7.2), -K(4)], [K(20), K(7.8), -K(4)], [K(20), K(7.8), K(4)], [K(7.5), K(7.2), K(4)]];
      const quad = (a, b2, c, d, out) => ({ loop: [a, b2, c, d], out });
      solid(b, wood, [
        quad(B[0], B[1], B[2], B[3], [0, -1, 0]),
        quad(B[0], B[1], T[1], T[0], [0, 0, -1]), quad(B[3], B[2], T[2], T[3], [0, 0, 1]),
        quad(B[1], B[2], T[2], T[1], [1, 0.5, 0]), quad(B[0], B[3], T[3], T[0], [-1, 0, 0]),
      ], { T: 0.02 });
      for (let i = 0; i < 4; i++) tube(b, WOOD.beam, T[i], [(T[i][0] + T[(i + 1) % 4][0]) / 2, (T[i][1] + T[(i + 1) % 4][1]) / 2, (T[i][2] + T[(i + 1) % 4][2]) / 2], T[(i + 1) % 4], K(0.55)); // a rounded rim
      for (const z of [-1, 1]) pole(b, WOOD.beam, [K(9.5), K(2.7), z * K(2.4)], [K(9.5), 0, z * K(2.4)], K(0.5)); // two legs to rest on
      // Each load sized to sit inside the tray walls and heap over the rim.
      // [height, scale, x, tilt]: long loads (logs, the sheaf) go big and lean front-up against the raked front wall.
      const FIT = { wood: [7.6, 0.88, 14, 0.32], stone: [7.2, 0.95], gold: [7.4, 0.95], food: [7.8, 0.9, 12.8, 0.36], wool: [7.4, 0.95], berries: [7.8, 1.35] };
      if (what) { const [y, sc, x = 13.5, tilt = 0] = FIT[what] || [7, 1.15]; load(b, what, [K(x), K(y), 0], sc).rotation.z = tilt; }
    } else {
      // A crossbar between the two handles (where they pass x 12.5), the share's standard hung from its middle.
      const u = (12.5 - 1.8) / (22 - 1.8), cy = 9.2 - 5.6 * u, cz = 3.1 - 1.5 * u;
      pole(b, WOOD.beam, [K(12.5), K(cy), -K(cz)], [K(12.5), K(cy), K(cz)], K(0.6));
      // The share: one curved steel blade sweeping down from the post and forward to
      // a point in the soil, centred under the beam.
      const blade = new THREE.Group(); blade.position.set(K(12.5), K(3), 0); b.add(blade);
      tube(blade, '#b8bfc6', [0, 0, 0], [K(1.5), -K(3), 0], [K(5.5), -K(2.8), 0], K(1.1));
      blob(blade, '#b8bfc6', K(5.9), -K(2.8), 0, K(1.4), K(0.7), K(1.1));                   // its point
      pole(b, WOOD.beam, [K(12.5), K(cy), 0], [K(12.5), K(3), 0], K(0.6));                                      // the standard down to it
    }
    return b;
  }
  const pusher = (tc, kind, what) => { // hands on the grips, pushing
    const g = new THREE.Group();
    human(g, tc, { hat: 'hair', hands: [[6.5, -6.5, -3.9], [6.5, -6.5, 3.9]] });
    barrowRig(g, kind, what).position.x = ax(4.7); return g;
  };
  // The Bow Saw (replaces the axe for chopping): a bowed wooden frame arching
  // over a straight bright toothed blade, comically oversized as in 2D, held
  // level at waist height by one hand on the frame's near end.
  function bowSaw(g){
    const s = new THREE.Group(); s.position.z = ar(4.2); g.add(s);               // out on the working side, clear of the face
    tube(s, HANDLE, at(4, -4.5), at(4.6, -11), at(11.5, -11), ar(0.8));        // the bowed frame, near half
    tube(s, HANDLE, at(11.5, -11), at(18.4, -11), at(19, -4.5), ar(0.8));      // far half
    const pts = [[3.4, 0]]; // the blade: a flat bright strip with a toothed lower edge
    for (let x = 3.4; x < 19.6; x += 1.35) pts.push([x + 0.45, -1.1], [x + 1.35, -0.55]);
    pts.push([19.6, -0.55], [19.6, 0.9], [3.4, 0.9]);
    const geo = own(new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(ar(x), ar(y)))), { depth: ar(0.35), bevelEnabled: false }).translate(0, 0, -ar(0.17)));
    const m = new THREE.Mesh(geo, mat('#f2f6fb')); m.position.set(0, chh(-4.5), 0); m.userData.hullGeo = geo; m.userData.hullW = HULL * 0.5; s.add(m);
    return s;
  }
  const sawyer = tc => { // one hand on the saw frame's near end, the other at rest
    const g = new THREE.Group();
    human(g, tc, { hat: 'hair', hands: [[0.9, -3.2, -5.2], [4.4, -6.2, 4.2]] });
    bowSaw(g); return g;
  };
  const worker = (tc, female, tl, up) => { // both hands on the handle, the tool held up and forward, head high
    const g = new THREE.Group(), a = [5, -5.5, 1.5], b = [7.2, -8, 1.5];                 // along the handle's line, leaning forward
    human(g, tc, female ? { hat: 'long', dress: 'tunic', hands: [a, b] } : { hat: 'hair', hands: [a, b] });
    tool(g, tl, at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 1.5), [0.66, 0.75, 0], up); return g;
  };
  // Each load's half-height (art px, at the carried 1.5× size): it sits on the head's top (−18) or the ground by this.
  const LOAD_SIT = { wood: 2.85, stone: 2.4, gold: 2.85, food: 2.85, wool: 3.4, berries: 1.8 };
  const CARRY_HANDS = [[0.4, -17.1, -5.6], [0.4, -17.1, 5.6]]; // under the load's edges, either side of the head
  const carrier = (tc, what) => { // the load resting on the head, hands up steadying it at the sides
    const g = new THREE.Group(), hs = CARRY_HANDS;
    human(g, tc, { hat: 'hair', hands: hs });
    load(g, what, at(0.3, -21.2)); return g;
  };
  // ---- Animation mock-up: poses from a phase t in [0,1) ----
  // walk: each foot planted and sliding back under the moving body through
  // its stance half, then lifting and swinging forward; the arms swing
  // opposite the legs; the body bobs twice a stride. chop: the hands travel
  // an arc out in front of the chest on the tool side — a slow wind-up, a
  // fast strike — the axe along the arc's radius (the arms' extension).
  const STRIDE = 2.6;
  function walkPose(t){
    const leg = ph => { const u = ((ph % 1) + 1) % 1;
      return u < 0.5 ? [STRIDE * (1 - 4 * u), 0] : [STRIDE * (-1 + 4 * (u - 0.5)), 1.6 * Math.sin((u - 0.5) * 2 * Math.PI)]; };
    const L = leg(t), R = leg(t + 0.5), bob = 0.55 * Math.abs(Math.cos(2 * Math.PI * t));
    const arm = (fx, s) => [1 - fx * 0.9, -2.6 + Math.abs(fx) * 0.25, s * 5.6];
    return { feet: [L, R], hands: [arm(L[0], -1), arm(R[0], 1)], bob };
  }
  // chop: a horizontal sweep (how a real axe fells a trunk) — wound back and a
  // little up behind the tool-side shoulder, then whipped round through the
  // front to strike at waist height, slightly downhill; the torso twists with
  // it. yaw φ: 0 = straight ahead, + = round to the tool side (+z), behind at ~115°.
  const CHOP_R = 8.6;
  // The lower fist sits ON the handle, a fist's width below the upper one toward
  // the butt (dir: world-style, y up; art y runs down).
  const onHandle = (grip, dir, d = 2.2) => { const L = Math.hypot(...dir); return [grip[0] - dir[0] / L * d, grip[1] + dir[1] / L * d, grip[2] - dir[2] / L * d]; };
  function chopYaw(t){ // 70% slow wind-up to 140°, 30% fast strike round to −20°
    return t < 0.7 ? -20 + 160 * (1 - Math.cos(Math.PI * t / 0.7)) / 2 : 140 - 160 * Math.pow((t - 0.7) / 0.3, 1.6);
  }
  // The whole body chops: feet planted apart, lead foot forward; the torso
  // winds back toward the tool side (weight on the back foot, leaning back),
  // then unwinds hard through the front (weight onto the lead foot, leaning
  // into the cut, a small dip at impact); the head counter-turns to keep the
  // eyes on the trunk.
  function chopPose(t){
    const f = chopYaw(t) * Math.PI / 180, c = Math.cos(f), s = Math.sin(f);
    const wind = Math.max(0, s), strike = t >= 0.7 ? (t - 0.7) / 0.3 : 0;
    const y = -8 - 2.2 * wind;                                                              // raised a little in the wind-up
    const grip = [CHOP_R * c, y, CHOP_R * s], dir = [c, -0.18 + 0.7 * wind, s], low = onHandle(grip, dir);
    const yaw = -0.85 * Math.max(-0.35, Math.min(2.45, f));                                // a big twist with the swing (+z side = back)
    const lean = -0.16 * wind + 0.26 * Math.sin(Math.PI * Math.min(1, strike * 1.2));
    const dip = 1.1 * Math.max(0, Math.sin(Math.PI * (strike - 0.55) / 0.45));
    return { hands: [low, grip], dir, edge: [s, 0, -c], grip,
      torso: { yaw, lean, dip }, headYaw: -yaw * 0.85, feet: [[1.6 + 0.4 * strike, 0], [-1.4, 0.25 * wind]] };
  }
  // Overhead strike (mine / build): the hands ride an arc in a plane out on the
  // tool side (clear of the head) — raised back over the shoulder with the body
  // arching back, then driven down to the ground ahead, bending over into it
  // with a knee dip. θ: degrees above horizontal.
  // Overhead power swing, straight down the middle (mine, build): both fists on
  // the handle on the body's centre line (so neither arm crosses the body), the
  // hands riding an arc in front of the face from overhead — the tool cocked
  // back over the head — down to the blow ahead; the body arches back as it's
  // raised and bends into the blow with a knee dip. θ: the hands' arc angle,
  // φ: the handle's (it leads the arc by `cock` at the top, `lead` at the blow).
  function overheadPose(t, { top, low, R, cock, lead, split = 0.6 }){
    const raise = t < split ? easeC(t / split) : 1 - Math.pow((t - split) / (1 - split), 1.7), strike = t >= split ? (t - split) / (1 - split) : 0;
    const th = (low + (top - low) * raise) * Math.PI / 180, ph = th + (lead + (cock - lead) * raise) * Math.PI / 180;
    const d = [Math.cos(ph), Math.sin(ph), 0], grip = [1.5 + R * Math.cos(th), -9.5 - R * Math.sin(th), 0];
    const butt = [grip[0] - d[0] * 2.2, grip[1] + d[1] * 2.2, 0];
    const lean = -0.18 * raise + 0.4 * Math.sin(Math.PI * Math.min(1, strike * 1.15) / 2) * (1 - Math.max(0, strike - 0.85) * 3);
    return { hands: [butt, grip], grip, dir: d, edge: [Math.sin(ph), -Math.cos(ph), 0],
      torso: { yaw: 0, lean, dip: 1.4 * Math.max(0, Math.sin(Math.PI * (strike - 0.5) / 0.5)) }, headYaw: 0, feet: [[1.8, 0], [-1.4, 0]] };
  }
  const minePose = t => overheadPose(t, { top: 74, low: -26, R: 10, cock: 40, lead: -12 });   // the point driven down into the rock
  const buildPose = t => overheadPose(t, { top: 62, low: -8, R: 7.4, cock: 34, lead: 8, split: 0.55 }); // the handle level at the blow: the face lands flat on the post
  function strikePose(t, top, low, split = 0.65, pvY = -9){
    const th = (t < split ? low + (top - low) * (1 - Math.cos(Math.PI * t / split)) / 2 : top - (top - low) * Math.pow((t - split) / (1 - split), 1.5)) * Math.PI / 180;
    const c = Math.cos(th), sn = Math.sin(th), PV = [2, pvY, 2.6 + 2.9 * Math.max(0, sn)], R = 6.6; // out beside the head when raised, toward the middle at the strike
    const grip = [PV[0] + R * c, PV[1] - R * sn, PV[2]], lowH = onHandle(grip, [c, sn, 0]);
    const raise = Math.max(0, sn), strike = t >= split ? (t - split) / (1 - split) : 0;
    const lean = -0.14 * raise + 0.36 * Math.sin(Math.PI * Math.min(1, strike * 1.15) / 2) * (1 - Math.max(0, strike - 0.8) * 2);
    const dip = 1.2 * Math.max(0, Math.sin(Math.PI * (strike - 0.5) / 0.5));
    return { hands: [grip, lowH], dir: [c, sn, 0], edge: [0, -1, 0], grip, torso: { yaw: -0.5 - 0.2 * raise, lean, dip }, headYaw: 0.1, feet: [[1.4, 0], [-1.2, 0]] }; // the far (left) fist up the handle: its arm crosses well ahead of the stomach
  }
  // Scythe: the blade always points the same way — toward the cutting side,
  // square to the snath (it never flips). It mows on one stroke only, swept
  // from the tool side across the front with the blade skimming the ground
  // (45% of the cycle), then carried back empty and a little lifted.
  function mowPose(t){
    const cut = t < 0.45, u = cut ? t / 0.45 : (t - 0.45) / 0.55, ease = (1 - Math.cos(Math.PI * u)) / 2;
    const f = (cut ? 62 - 124 * ease : -62 + 124 * ease) * Math.PI / 180, c = Math.cos(f), sn = Math.sin(f);
    const lift = cut ? 0 : 1.6 * Math.sin(Math.PI * u);
    const grip = [7.6 * c, -5.2 - lift, 7.6 * sn], dir = [c, -0.9 + lift * 0.12, sn], low = onHandle(grip, dir);
    return { hands: [low, grip], dir, edge: [sn, 0, -c], grip, torso: { yaw: -0.85 * f, lean: 0.12, dip: cut ? 0.4 : 0.2 }, headYaw: 0.6 * f, feet: [[1, 0], [-1, 0]] };
  }
  // Bow saw, felling: laid on its side against the trunk — the blade level at
  // the waist SAW_X ahead, teeth into the bark, the frame tipped back toward
  // the villager (SAW_TIP from flat, so the arch clears his body) — stroked side
  // to side along the blade, both hands on the middle of the bow.
  const SAW_X = 14.5, SAW_Z = 12.2, SAW_Y = -6, SAW_TIP = 1.35; // the saw's near end at z = SAW_Z − 4 (art px)
  function sawPose(t){ const off = 3 * Math.sin(2 * Math.PI * t);
    // both fists round the frame's top bar (bowSaw: 6.5px above the blade), either side of its middle
    const bow = 6.4, bx = SAW_X - Math.sin(SAW_TIP) * bow, by = SAW_Y - Math.cos(SAW_TIP) * bow;
    return { off, hands: [[bx, by, SAW_Z - 12.7 - off], [bx, by, SAW_Z - 10.3 - off]], torso: { yaw: 0.1 * off - 0.15, lean: 0.2, dip: 0.5 }, feet: [[1.6, 0], [-1.2, 0]] }; }
  const easeC = u => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, u)))) / 2;
  const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
  // forage: one hand at a time reaches into the bush, plucks (a small tug) and
  // drops the berry into the other, cupped at the belly; the hands trade each pick.
  const FORAGE_REACH = [[9.4, -4.6, -2.4], [9.8, -6.8, 2.6]];
  function foragePose(t){
    const s = t < 0.5 ? 1 : -1, u = (t % 0.5) / 0.5, i = s > 0 ? 1 : 0;
    const e = u < 0.45 ? easeC(u / 0.45) : u < 0.6 ? 1 - 0.1 * (u - 0.45) / 0.15 : 0.9 * (1 - easeC((u - 0.6) / 0.4));
    const hands = [];
    hands[i] = mix([6.3, -7.6, s * 1.2], FORAGE_REACH[i], e);
    hands[1 - i] = [6.6, -6.2, -s * 1];                                                       // cupped, catching
    return { hands, berry: u > 0.5 && u < 0.95 ? hands[i] : null, torso: { yaw: -0.14 * s * e, lean: 0.16 + 0.14 * e, dip: 0.3 }, headYaw: 0.1 * s * e, feet: [[1, 0], [-0.6, 0]] };
  }
  // butcher: bent right over the carcass, one hand pinning it, the knife
  // hand stabbing down in quick jabs and drawing back slowly (the 2D jab clock).
  function butcherPose(t){
    const jb = t < 0.25 ? easeC(t / 0.25) : 1 - easeC((t - 0.25) / 0.75);
    const kh = mix([7, -9, 2.4], [9.4, -5.6, 1.4], jb);
    return { hands: [[10, -4.6, -2.8], kh], knife: kh, kdir: [0.45 - 0.1 * jb, -1, -0.1], jab: jb,
      torso: { yaw: -0.1, lean: 0.5 + 0.08 * jb, dip: 1.6 + 0.4 * jb }, headYaw: 0, feet: [[2.4, 0], [-1.8, 0]] };
  }
  // repair: hammering a wall, the mallet choked up in one fist: the arm lifts
  // it up and back over the shoulder (out on the tool side, clear of the head),
  // then brings it down and forward so the face meets the planks square at
  // shoulder height (handle near upright); the free hand braces on the wall.
  const WALL_X = 10.5, REP_HIT = [5.6, -4.5, 6.2], REP_UP = [1.6, -14, 9.5];
  function repairPose(t){
    const w = t < 0.6 ? easeC(t / 0.6) : 1 - Math.pow((t - 0.6) / 0.4, 1.6);        // 1 = wound up over the shoulder
    const phi = (10 - 65 * w) * Math.PI / 180, grip = mix(REP_HIT, REP_UP, w);
    return { hands: [[WALL_X - 0.6, -9.5, -3], grip], grip, dir: [Math.sin(phi), Math.cos(phi), 0], edge: [Math.cos(phi), -Math.sin(phi), 0],
      torso: { yaw: 0.12 * w - 0.08, lean: 0.14 - 0.12 * w, dip: 0.2 }, headYaw: 0.1, feet: [[1.4, 0], [-1, 0]] };
  }
  // drop-off: a throw — a dip at the knees, then both arms drive the load up and
  // forward off the head; it flies on in an arc (tumbling) onto
  // the pile while the arms follow through and come back down. It flies lengthwise,
  // as carried (end-on to the body, never across it).
  const DROP_X = 20, REL = 0.34, LAND = 0.66;
  function dropPose(t, k = 'wood'){
    const dip = t < 0.2 ? easeC(t / 0.2) : 1 - easeC((t - 0.2) / 0.14), push = easeC((t - 0.2) / (REL - 0.2));
    const follow = easeC((t - REL) / 0.12), back = easeC((t - 0.5) / 0.35);
    // H1: the release, arms driven up and forward past straight (a little stretch sells
    // the snap); H2: the follow-through, straight arms carried on out forward.
    const H0 = s => [0.4, -17.1 + 1.2 * dip, s * 5.6], H1 = s => [6.8, -18.2, s * 4.4], H2 = s => [8.4, -14.6, s * 4.4], R = s => [1, -2.4, s * 5.6];
    const hand = s => t < REL ? mix(H0(s), H1(s), push) : t < 0.5 ? mix(H1(s), H2(s), follow) : mix(H2(s), R(s), back);
    let ld;
    if (t < REL) { const m = hand(1); ld = { x: m[0] - 0.1, y: m[1] - 1.1 - LOAD_SIT[k], pitch: 0 }; } // on the head, the hands under its edges
    else { const u = Math.min(1, (t - REL) / (LAND - REL)), x0 = 6.7, y0 = -19.3 - LOAD_SIT[k], y1 = 5 - LOAD_SIT[k]; // lands on the ground, at the end of the row
      ld = { x: x0 + (DROP_X - x0) * (1 - (1 - u) ** 2), y: y0 + (y1 - y0) * u - 28 * u * (1 - u), pitch: 0.3 * Math.sin(Math.PI * u) * (1 - u) }; }  // an arc: up, over, down, the front end dipping
    const drive = t < REL ? push : t < 0.5 ? 1 : 1 - back;                                     // leaning into the throw, up onto the lead foot
    return { hands: [hand(-1), hand(1)], load: ld, landed: t >= LAND, torso: { yaw: 0, lean: 0.3 * drive - 0.08 * dip, dip: 1.4 * dip },
      feet: [[1.4 * drive + 0.2, 0], [-0.8, 0.9 * drive]] };
  }
  // fight: a lunging knife jab from a guard, the shoulder turning into it.
  const FIGHT_X = 18.5;
  function fightPose(t){
    const jb = t < 0.25 ? easeC(t / 0.25) : 1 - easeC((t - 0.25) / 0.75);
    const kh = [6.2 + 4.6 * jb, -8.4 - 0.4 * jb, 2.6 - 1.4 * jb];
    return { hands: [[4.2, -11.5, -3.2], kh], knife: kh, kdir: [1, 0.12, -0.08], jab: jb,
      torso: { yaw: -0.25 + 0.5 * jb, lean: 0.08 + 0.22 * jb, dip: 0.4 + 0.4 * jb }, headYaw: 0.2 - 0.3 * jb, feet: [[1.8 + 1.4 * jb, 0], [-1.6, 0]] };
  }
  // idle: breathing, the weight shifting, a slow look round.
  function idlePose(t){
    const b = Math.sin(2 * Math.PI * t), br = 0.5 + 0.5 * Math.sin(8 * Math.PI * t);
    return { hands: [[1 + 0.3 * b, -2.4 - 0.2 * br, -5.6], [1 - 0.3 * b, -2.4 - 0.2 * br, 5.6]], torso: { yaw: 0.06 * b, lean: 0.02, dip: 0.25 * br }, headYaw: 0.5 * Math.sin(2 * Math.PI * t + 0.6), feet: [[0.4, 0], [-0.3, 0]] };
  }
  // flee: a run — long strides with high knees, leaning into it; the elbows stay
  // bent and each fist pumps opposite its leg: up and in to the chest in front,
  // down past the hip behind.
  function runPose(t){
    const S = 3.8, leg = ph => { const u = ((ph % 1) + 1) % 1;
      return u < 0.5 ? [S * (1 - 4 * u), 0] : [S * (-1 + 4 * (u - 0.5)), 3.4 * Math.sin((u - 0.5) * 2 * Math.PI)]; };
    const L = leg(t), R = leg(t + 0.5), bob = 1.1 * Math.abs(Math.cos(2 * Math.PI * t));
    // Each upper arm swings from the shoulder (a: + forward), the elbow held at ~90°.
    const arm = s => { const sw = s * Math.cos(2 * Math.PI * t), a = sw > 0 ? 0.85 * sw : 0.95 * sw;
      const el = [4.5 * Math.sin(a), -8 + 4.5 * Math.cos(a), s * 5.3];
      return { el, hand: [el[0] + 4.2 * Math.cos(a), el[1] - 4.2 * Math.sin(a), s * (4.6 - 0.8 * Math.max(0, sw))] }; };
    const A = [arm(-1), arm(1)];
    return { feet: [L, R], hands: A.map(x => x.hand), elbows: A.map(x => x.el), bob, torso: { yaw: 0.05 * Math.sin(2 * Math.PI * t), lean: 0.26, dip: 0 }, headYaw: 0 };
  }
  // death (drawCorpse's staged sequence, in the round), by age in ms: struck —
  // the head and shoulders snap back, arms flung out; the knees buckle and the
  // hips drop; he goes over backward off the heels, accelerating, the legs
  // straightening as he lays out; a small bounce on impact, the arms flopping
  // out to the sides and the head rolling over. Blood seeps out from under
  // him and dries brown; at `skel` the body gives way to cartoon bones (the
  // bear's), which shrink away by `life`.
  const DIE = { hit: 260, buckle: 700, land: 1200 };
  function villagerDeathPose(age){
    const cl = v => Math.max(0, Math.min(1, v));
    const hit = easeC(age / DIE.hit), buck = easeC((age - 150) / (DIE.buckle - 150)), u = cl((age - 480) / (DIE.land - 480)), flop = easeC((age - DIE.land + 60) / 380);
    let fall = (Math.PI / 2) * u * u;                                                           // accelerating, as a body falls
    if (age > DIE.land && age < DIE.land + 280) fall *= 1 - 0.06 * Math.sin((age - DIE.land) / 280 * Math.PI); // the bounce
    const rest = s => [1, -2.4, s * 5.6], fling = s => [-1.5, -15.5, s * 8.6], limp = s => [2.2, -5, s * 6.4], trail = s => [-1.2, -17.5, s * 7.5], splay = s => [-1, -11.5, s * 10.5];
    const hand = s => mix(mix(mix(mix(rest(s), fling(s), hit), limp(s), buck), trail(s), u), splay(s), flop);
    return { fall, hands: [hand(-1), hand(1)], headYaw: 0.7 * flop,
      torso: { yaw: 0.12 * hit * (1 - u), lean: -0.35 * hit * (1 - buck) + 0.3 * buck * (1 - u), dip: 3 * buck * (1 - u * u) + 0.3 * u },
      feet: [[1.4 * buck * (1 - u) + 0.3, 0], [-0.6, 0.8 * hit * (1 - buck)]] };
  }
  // The villager's bones, lying on his back where the body fell (along −x from
  // the heels): a big skull with big sockets, a spine, two fat ribs, a pelvis,
  // arms flung out, legs — the fewest bones that read (the bear's idiom).
  function humanSkeleton(){
    const g = new THREE.Group(), bone = '#e8e0cc', y = ar(0.9), P = (x, z) => [ax(x), y, ar(z)];
    pole(g, bone, P(-19, 0), P(-9.5, 0), ar(0.9));                                              // spine
    for (const x of [-15.5, -12.6]) { // two fat ribs arching over it
      const rib = new THREE.Mesh(own(new THREE.TorusGeometry(ar(3.2), ar(0.8), 8, 14, Math.PI).rotateY(Math.PI / 2)), mat(bone));
      rib.position.set(ax(x), y, 0); rib.userData.hullGeo = rib.geometry; g.add(rib);
    }
    blob(g, bone, ax(-9.5), y, 0, ar(2), ar(1.1), ar(3));                                       // pelvis
    blob(g, bone, ax(-22), ar(3), ar(-0.6), ar(3.6), ar(3.2), ar(3.4));                         // big skull, rolled a little to one side
    for (const z of [-1, 1]) blob(g, '#2a241c', ax(-22.4), ar(5.4), ar(z * 1.4 - 0.6), ar(1.05)); // big eye sockets, looking up
    for (const s of [-1, 1]) {
      cartoonBone(g, P(-17.5, s * 3.6), P(-19.5, s * 10.5), ar(0.7));                           // arms, flung out
      cartoonBone(g, P(-9.5, s * 2), P(-1.5, s * 2.6), ar(0.8));                                // legs
    }
    return g; // outlined by the caller, once (a second union pass would re-order the first's outlines over the bones)
  }
  const DIE_LAB = { skel: 4800, life: 8000 };  // the lab's compressed timeline (the game: CORPSE_SKEL / CORPSE_LIFE)
  function knife(g, hand, dir){ // a short butcher's knife: a wooden grip in the fist, the blade out along dir
    const t = new THREE.Group(), K = v => v * UNIT_SCALE / PX;
    pole(t, HANDLE, [0, K(-1.6), 0], [0, K(1.4), 0], K(0.75));
    const sh = new THREE.Shape([[-0.9, 1.4], [0.8, 1.4], [0.6, 5.2], [-0.1, 6.8], [-0.9, 5]].map(([x, y]) => new THREE.Vector2(K(x), K(y))));
    const geo = own(new THREE.ExtrudeGeometry(sh, { depth: K(0.4), bevelEnabled: false }).translate(0, 0, -K(0.2)));
    const m = new THREE.Mesh(geo, mat('#dde3ea')); m.userData.hullGeo = geo; m.userData.hullW = HULL * 0.3; t.add(m);
    t.position.copy(V3(hand)); t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), V3(dir).normalize());
    g.add(t); return t;
  }
  // Swings hold near the handle's end (the lower hand at the butt): the head
  // rides a wider, faster arc, as a real power swing.
  const GRIP_OUT = 3.6, HEAD_REACH = 10 + GRIP_OUT;
  // Clash check: the gap (art px) from a point of radius r to the torso and head spheres; < 0 = overlap.
  function bodyGap(pt, r){
    const d = (c, cr) => Math.hypot(pt[0] - c[0], pt[1] - c[1], pt[2] - c[2]) - cr - r;
    return Math.min(d([0, -6, 0], 4.6), d([0, -14, 0], 4));
  }
  window.__povAnimCheck = () => {
    const out = [];
    for (const [k, fn] of Object.entries({ chop: chopPose, mine: minePose, build: buildPose, mow: mowPose })) {
      let worst = Infinity, at_ = 0;
      for (let i = 0; i < 40; i++) {
        const p = fn(i / 40), L = Math.hypot(...p.dir), head = [p.grip[0] + p.dir[0] / L * HEAD_REACH, p.grip[1] - p.dir[1] / L * HEAD_REACH, p.grip[2] + p.dir[2] / L * HEAD_REACH];
        const g = Math.min(bodyGap(p.hands[0], 1.3), bodyGap(p.hands[1], 1.3), bodyGap(head, 2.5));
        if (g < worst) { worst = g; at_ = i / 40; }
      }
      out.push(k + ' min gap ' + worst.toFixed(2) + ' at t=' + at_.toFixed(2));
    }
    { let worst = Infinity, at_ = 0; // repair: one fist, choked up (the head 7.15px up the handle, the barrel ±3.75 along the face)
      for (let i = 0; i < 40; i++) { const p = repairPose(i / 40), L = Math.hypot(...p.dir), hd = [p.grip[0] + p.dir[0] / L * 7.15, p.grip[1] - p.dir[1] / L * 7.15, p.grip[2]];
        const g = Math.min(bodyGap(p.hands[1], 1.3), ...[-3.75, 0, 3.75].map(e => bodyGap([hd[0] + p.edge[0] * e, hd[1] - p.edge[1] * e, hd[2]], 2.2)));
        if (g < worst) { worst = g; at_ = i / 40; } }
      out.push('repair min gap ' + worst.toFixed(2) + ' at t=' + at_.toFixed(2)); }
    return out.join('\n');
  };
  // Dev check: how deep each arm sinks into the torso over every lab action.
  // The arm is the rig's own curve (shoulder → bend → hand, in the torso's
  // frame), skipping its root inside the shoulder; the torso the body ellipsoid
  // (the dress's rough hull for her). Gap in art px, < 0 = through the body.
  window.__povArmCheck = (kinds, female) => {
    const out = [];
    for (const k of kinds) {
      let worst = Infinity, at_ = 0, side = 0, info = '', dmin = Infinity, dmax = 0;
      for (let i = 0; i < 40; i++) {
        armProbe = []; animFrame(k, i / 40, female); const arms = armProbe; armProbe = null;
        for (const a of arms) {
          dmin = Math.min(dmin, a.d); dmax = Math.max(dmax, a.d);
          const [c, r] = a.dress ? [[0, -5, 0], [5.1, 6.5, 5.1]] : [[0, -6, 0], [4.6, 5, 4.2]];
          for (let u = 0.3; u <= 1.001; u += 0.05) {
            const [A0, A1, A2] = a.ctl, q = [0, 1, 2].map(j => (1 - u) ** 2 * A0[j] + 2 * u * (1 - u) * A1[j] + u * u * A2[j]);
            const d = Math.hypot((q[0] - c[0]) / r[0], (q[1] - c[1]) / r[1], (q[2] - c[2]) / r[2]);
            const gap = (d - 1) * Math.min(...r) - (u < 0.22 ? 1.45 : 1.05);
            if (gap < worst) { worst = gap; at_ = i / 40; side = a.s; info = ' u=' + u.toFixed(2) + ' hand=' + a.ctl[2].map(v => v.toFixed(1)) + ' pt=' + q.map(v => v.toFixed(1)); }
          }
        }
      }
      out.push(k.padEnd(8) + ' reach ' + dmin.toFixed(1) + '–' + dmax.toFixed(1) + ' gap ' + worst.toFixed(2) + (worst < 0 ? '  ← ' + (side < 0 ? 'left' : 'right') + ' arm at t=' + at_.toFixed(2) + info : ''));
    }
    return out.join('\n');
  };
  function animFrame(kind, t, female, opt = {}){
    const LD = opt.load || 'wood', HELD = opt.tool;   // lab options: the load carried, the tool in hand
    const g = new THREE.Group(), body = new THREE.Group(), tc = '#2d6bd1', who = female ? { hat: 'long', dress: 'tunic' } : { hat: 'hair' }; g.add(body);
    const person = p => human(body, tc, { ...who, hands: p.hands, elbows: p.elbows, torso: p.torso, headYaw: p.headYaw, feet: p.feet });
    if (kind === 'walk' || kind === 'barrow' || kind === 'plow') { const p = walkPose(kind === 'plow' ? t : t); body.position.y = p.bob * UNIT_SCALE / PX;
      const push = kind !== 'walk', grips = [[6.5, -6.5, -3.9], [6.5, -6.5, 3.9]];
      // Walking with a tool: it rests on the right shoulder, held near the butt, the head behind; the other arm swings.
      const shoulder = kind === 'walk' && HELD, sh = [2.4, -9.2, 5.3];
      human(body, tc, { ...who, feet: p.feet, hands: push ? grips : shoulder ? [p.hands[0], sh] : p.hands, torso: kind === 'plow' ? { lean: 0.14 } : undefined });
      if (shoulder) tool(body, HELD, at(...sh), [-0.62, 0.76, 0.14], { out: 4.4 }, [0, 0.3, 1]);
      if (push) { const r = barrowRig(g, kind, kind === 'barrow' ? LD : null); r.position.set(ax(4.7), body.position.y * 0.5, 0); } } // its grips out in front of the belly
    if (kind === 'chop') { const p = chopPose(t); person(p); tool(body, 'axe', at(...p.grip), p.dir, { out: GRIP_OUT }, p.edge); }
    const work = { mine: ['pick', minePose], build: ['mallet', buildPose], farm: ['scythe', mowPose] }[kind];
    if (work) { const p = work[1](t); person(p); tool(body, work[0], at(...p.grip), p.dir, { out: GRIP_OUT, mow: kind === 'farm' }, p.edge); }
    if (kind === 'saw') { const p = sawPose(t); person(p);
      // turned across the front (local +x, the blade → world −z), then rolled about
      // the blade line so the frame tips back toward the villager and the teeth face the trunk
      const w = new THREE.Group(), roll = new THREE.Group(); body.add(w); w.add(roll);
      const sg = bowSaw(roll); sg.position.set(0, -chh(SAW_Y), 0);
      roll.position.y = chh(SAW_Y); roll.rotation.x = -SAW_TIP;
      w.rotation.y = Math.PI / 2; w.position.set(ax(SAW_X), 0, ar(SAW_Z - p.off)); }
    if (kind === 'carry') { const p = walkPose(t), lift = p.bob * UNIT_SCALE / PX; body.position.y = lift;
      human(body, tc, { ...who, feet: p.feet, hands: CARRY_HANDS });
      load(body, LD, at(0.3, -18.1 - LOAD_SIT[LD])).rotation.x = 0.08 * Math.sin(4 * Math.PI * t); }
    if (kind === 'forage') { const p = foragePose(t); person(p); if (p.berry) blob(body, '#cc3344', ...at(p.berry[0] + 0.8, p.berry[1] - 0.6, p.berry[2]), ar(1.1)); }
    if (kind === 'butcher' || kind === 'fight') { const p = (kind === 'fight' ? fightPose : butcherPose)(t); person(p); knife(body, at(...p.knife), p.kdir); }
    if (kind === 'repair') { const p = repairPose(t); person(p); tool(body, 'mallet', at(...p.grip), p.dir, {}, p.edge); }
    if (kind === 'drop') { const p = dropPose(t, LD); person(p); const L = load(p.landed ? g : body, LD, at(p.load.x, p.load.y));
      L.rotation.z = -p.load.pitch; }
    if (kind === 'idle') person(idlePose(t));
    if (kind === 'flee') { const p = runPose(t); body.position.y = p.bob * UNIT_SCALE / PX; person(p); }
    if (kind === 'die') { const age = t * DIE_LAB.life, { skel, life } = DIE_LAB;
      const pool = Math.max(0, Math.min(1, (age - DIE.land * 0.8) / 2000)), dry = Math.min(1, age / skel);
      if (pool > 0) { // the blood pool under the torso: spreading (ease-out), drying brown
        const r = ar(8.5) * (1 - (1 - pool) ** 2), m = new THREE.Mesh(own(new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ color: new THREE.Color('#6b0f0f').lerp(new THREE.Color('#4a2a1a'), dry) }));
        m.scale.set(r * 1.3, 1, r); m.position.set(ax(-12), 0.002, 0); g.add(m);
        const fade = Math.max(0, Math.min(1, (life - age) / 1500)); if (fade < 1) { m.material.transparent = true; m.material.opacity = fade; } }
      if (HELD) { // the tool leaves the hand at the blow: falls, tumbling over to lie flat beside him, a small clatter
        const u = Math.max(0, Math.min(1, (age - 150) / 560)), th = (Math.PI / 2) * u ** 1.5 * (age > 710 && age < 950 ? 1 - 0.06 * Math.sin((age - 710) / 240 * Math.PI) : 1);
        const flat = [0.45, 0, -0.89], dir = [flat[0] * Math.sin(th), Math.cos(th), flat[2] * Math.sin(th)];
        const tg = new THREE.Group(); tg.userData.fade = age < skel ? 1 : Math.max(0, Math.min(1, (life - age) / 1500)); g.add(tg);
        tool(tg, HELD, at(3 + 3.5 * u, -6.5 + (6.5 + 5 - 0.8) * u * u, 5.8 + 3 * u), dir, {}, [0, Math.sin(th), Math.cos(th)]); }
      if (age < skel) { const p = villagerDeathPose(age);
        const pv = new THREE.Group(); pv.position.set(ax(-2.4), 0, 0); g.add(pv); pv.add(body); body.position.x = -ax(-2.4);
        pv.rotation.z = p.fall; person(p); }
      else { const sk = humanSkeleton(); sk.userData.fade = Math.max(0, Math.min(1, (life - age) / 1500)); g.add(sk); } // faded once outlined (below)
    }
    addHulls(g, true);
    g.traverse(o => { if (o.userData.fade != null) fadeTo(o, o.userData.fade); });
    return g;
  }
  // The 3D animation lab (lab3d.html): the same builders, posed at any phase.
  window.__pov3dLab = {
    load: () => loadThree().then(() => { initShared(); return THREE; }),
    kinds: ['idle', 'walk', 'flee', 'carry', 'barrow', 'chop', 'saw', 'mine', 'farm', 'plow', 'forage', 'butcher', 'build', 'repair', 'drop', 'fight', 'die'],
    frame: animFrame,
    check: () => window.__povAnimCheck(),
    dispose: g => { disposeFaded(g); g.traverse(o => { if (o.geometry && o.geometry.userData.own) o.geometry.dispose(); }); },
    // A tree for the chop: the trunk pivots at its base so it can shake, the
    // crown sways on top of it (the game tree's design: a round trunk, puffs).
    tree(){
      const k = 1.05, root = new THREE.Group(), sway = new THREE.Group(); root.add(sway);
      pole(sway, '#8B4513', [0, 0, 0], [0, TREE_H * k, 0], TRUNK_R * k, 'post');
      const crown = new THREE.Group(); crown.position.y = TREE_H * k; sway.add(crown);
      ball(crown, '#4db536', 0, 0, 0, CROWN_R * k);
      for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + i * Math.PI / 2; ball(crown, '#4db536', Math.cos(a) * CROWN_R * 0.8 * k, -0.04 * CROWN_K, Math.sin(a) * CROWN_R * 0.8 * k, 9 / PX * CROWN_K * k); }
      addHulls(root, true);
      return { root, sway, crown, trunkR: TRUNK_R * k };
    },
    // Points along a tool's working head at phase t (world, relative to the
    // character): where the axe edge, pick tip, mallet face or scythe blade is.
    toolHead(kind, t){
      const P = { chop: chopPose, mine: minePose, build: buildPose, farm: mowPose }[kind](t);
      const U = UNIT_SCALE / PX, d = V3(P.dir).normalize(), e = V3(P.edge).addScaledVector(d, -V3(P.edge).dot(d)).normalize();
      const base = V3(at(...P.grip)).addScaledVector(d, GRIP_OUT * U), top = (kind === 'farm' ? 17 : 13) * 0.55, pt = (lx, ly) => base.clone().addScaledVector(d, (top + ly) * U).addScaledVector(e, lx * U);
      if (kind === 'chop') return [pt(5, -1.5), pt(2.5, -1.5)];
      if (kind === 'mine') return [pt(4.6, -1.4)];
      if (kind === 'build') return [pt(3.75, 0)];
      const out = []; for (let i = 0; i <= 6; i++) { const u = i / 6; out.push(pt(10 * u, 1.2 * 2 * u * (1 - u) + 0.8 * u * u)); } return out; // the scythe's curved blade (17px snath: top 9.35)
    },
    // Targets for the other actions (the game's designs): a gold rock, a stake, wheat, a log.
    rock(stone){ // gold (shiny) or stone (matte grey), as the game's deposits
      const g = new THREE.Group(), cols = stone ? ['#9d9d9d', '#8c8c8c', '#95958f'] : ['#e8b90f', '#d1a017', '#c99815'];
      for (const [x, z, r, h, i] of [[0, 0, 0.13, 0.26, 0], [-0.12, 0.13, 0.08, 0.16, 1], [0.13, 0.12, 0.07, 0.14, 2]]) {
        const m = inked(own(new THREE.LatheGeometry([[0, 0], [0.95, 0], [1.02, 0.35], [0.82, 0.74], [0.4, 0.98], [0, 1]].map(([a, b]) => new THREE.Vector2(a, b)), 7).toNonIndexed()),
          stone ? new THREE.MeshLambertMaterial({ color: cols[i], flatShading: true }) : new THREE.MeshPhongMaterial({ color: cols[i], shininess: 70, specular: '#fff3b0', flatShading: true }), x, 0, z, r, h, r, 89);
        m.geometry.computeVertexNormals(); g.add(m);
      }
      addHulls(g, true); return g;
    },
    stake(){ // a round post (its foot runs on below the ground, so it can be driven), a small mound of dirt round it
      const g = new THREE.Group(), post = new THREE.Group(); g.add(post);
      tube(post, WOOD.post, [0, -0.3, 0], [0, 0, 0], [0, 0.3, 0], ar(1.6)); ball(g, '#7a5a3a', 0, 0, 0, ar(4.2), 0.3, true);
      addHulls(g, true); return { g, post };
    },
    wheat(){
      const g = new THREE.Group(), stalks = [];
      for (let i = 0; i < 26; i++) {
        const a = -1.2 + 2.4 * (i / 25), r = 0.4 + 0.1 * ((i * 7) % 3) / 2, s2 = new THREE.Group(); s2.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); g.add(s2);
        pole(s2, '#c9a227', [0, 0, 0], [0, 0.17, 0], 0.006, 'line'); const h = ball(s2, '#e8c84a', 0, 0.19, 0, 0.018, 1.8); delete h.userData.hullGeo;
        stalks.push(s2);
      }
      return { g, stalks };
    },
    // The post being sawn stands in the middle of the blade's free span —
    // between the frame's ends at both ends of the stroke, clear of the hand.
    log(){ const g = new THREE.Group(); pole(g, '#8B4513', [0, 0, 0], [0, 0.4, 0], 2.2 * UNIT_SCALE / PX, 'post'); addHulls(g, true); return g; },
    sawBlade: t => new THREE.Vector3(ax(SAW_X + 0.6), chh(SAW_Y), ar(SAW_Z - 11.5)), // where the teeth bite the bark (the middle of the stroke)
    // Targets for the new actions, placed where the poses meet them (world, relative to the character).
    bush(){ // the game's berry bush (full): a mound of leaf puffs with berries, its front where the hands reach
      const g = new THREE.Group(), puffs = [];
      for (const [x, z, r, y] of [[0, -0.12, 5.5, 0], [0, 0.12, 5, 0], [0.05, 0, 6.5, 0], [-0.08, 0, 5.5, 0], [0, -0.06, 5, 1], [0, 0.07, 4.5, 1], [0.02, 0, 4.5, 2]]) {
        const R = r / PX; puffs.push(ball(g, '#337a22', x, R * 0.8 + y * 0.085, z, R)); }
      for (let i = 0; i < 12; i++) { const p = puffs[(i * 5) % puffs.length], a = i * 2.39996, up = 0.15 + 0.5 * ((i * 3) % 4) / 4, h = Math.sqrt(1 - up * up), r = p.geometry.parameters.radius;
        ball(g, '#cc3344', p.position.x + Math.cos(a) * h * r, p.position.y + up * r, p.position.z + Math.sin(a) * h * r, 2.6 / PX); }
      addHulls(g, true); g.position.set(ax(FORAGE_REACH[1][0]) + 0.12, 0, 0); return g;
    },
    carcass(){ // a slaughtered sheep lying across the front, pinned by the free hand
      const g = sheepModel('#2d6bd1'); deathPose(g, 'sheep', 2000); const bones = sheepBones(g); addHulls(g, true);
      const root = new THREE.Group(); root.add(g); g.rotation.y = Math.PI / 2; root.position.set(ax(10) + 0.44, 0, 0); // lying on its side the body sits a hip-height off its origin: its back toward the villager, under the hands
      return { g: root, body: g, set: left => harvestPose(g, bones, left) };
    },
    wall(){ const g = new THREE.Group(); boxAt(g, WOOD.plankL + '|planks', ax(WALL_X), -ar(11), ax(WALL_X + 1.4), ar(11), 0, chh(-24)); return g; },
    wallHit: () => { const p = repairPose(0.9999), U = UNIT_SCALE / PX, d = V3(p.dir).normalize(), e = V3(p.edge).normalize();
      return V3(at(...p.grip)).addScaledVector(d, 13 * 0.55 * U).addScaledVector(e, 3.75 * U); },
    pile(k = 'wood'){ const g = new THREE.Group(); for (const z of [-1, 1]) load(g, k, [ax(DROP_X), ar(LOAD_SIT[k]), z * ar(11)]); addHulls(g, true); return g; }, // a row on the ground; the thrown one lands in the gap
    dropAt: () => new THREE.Vector3(ax(DROP_X), 0.01, 0),
    dummy(){ // a straw training dummy: a post, a sack body and head, a crossbar for arms (rounded tubes: an even, thin outline)
      const root = new THREE.Group(), g = new THREE.Group(); root.add(g); root.position.set(ax(FIGHT_X), 0, 0);
      tube(g, WOOD.post, [0, 0, 0], [0, chh(-4), 0], [0, chh(-12), 0], ar(1));
      tube(g, WOOD.post, [0, chh(-9.5), -ar(6.5)], [0, chh(-9.5), 0], [0, chh(-9.5), ar(6.5)], ar(0.8));
      ball(g, '#cdb98c', 0, chh(-8), 0, ar(4.2), 1.25); ball(g, '#cdb98c', 0, chh(-15.5), 0, ar(3.2));
      addHulls(root, true); return { root, g };
    },
    die: { land: DIE.land / DIE_LAB.life, skel: DIE_LAB.skel / DIE_LAB.life, at: () => new THREE.Vector3(ax(-11), 0.01, 0) }, // the death's phases in the lab cycle, where the body lands
    knifeTip: kind => { const p = (kind === 'fight' ? fightPose : butcherPose)(0.25), d = V3(p.kdir).normalize(); return V3(at(...p.knife)).addScaledVector(d, 6.2 * UNIT_SCALE / PX); },
    plowShare: () => new THREE.Vector3(ax(4.7) + ax(1.8) + (ax(18.4) - ax(1.8)) * 1.25, 0.01, 0),
    // Where the axe's cutting edge is at the moment of impact (world, relative to the character).
    chopContact(){
      const p = chopPose(0.9999), U = UNIT_SCALE / PX, d = V3(p.dir).normalize(), e = V3(p.edge).normalize();
      const out = GRIP_OUT + 13 * 0.55 - 1.5 + 2.5;                         // handle to the blade's middle
      return V3(at(...p.grip)).addScaledVector(d, out * U).addScaledVector(e, 5 * U);
    },
  };
  window.__povAnimShots = (kind, n = 8) => {
    const shots = [];
    for (let i = 0; i < n; i++) {
      const g = animFrame(kind, i / n);
      shots.push([0, Math.PI / 4].map(yaw => {
        const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
        r.setSize(220, 220); r.setPixelRatio(1.5);
        const sc = new THREE.Scene(); for (const l of scene.children) if (l.isLight) sc.add(l.clone()); sc.add(g);
        const cam = new THREE.PerspectiveCamera(34, 1, 0.05, 50); cam.position.set(Math.sin(yaw) * 1.9, 0.9, Math.cos(yaw) * 1.9); cam.lookAt(0.05, 0.3, 0);
        r.render(sc, cam); const u = r.domElement.toDataURL(); r.dispose(); return u;
      }));
    }
    return shots;
  };
  const CHARACTERS = {
    ...Object.fromEntries(['axe', 'pick', 'mallet', 'scythe'].map(t => ['tool_' + t, tc => worker(tc, false, t)])),
    ...Object.fromEntries(['wood', 'stone', 'gold', 'food', 'wool', 'berries'].map(w => ['carry_' + w, tc => carrier(tc, w)])),
    barrow_empty: tc => pusher(tc, 'barrow'), plow: tc => pusher(tc, 'plow'), tool_saw: sawyer,
    tool_axe2: tc => worker(tc, false, 'axe', { double: true }), tool_pickGold: tc => worker(tc, false, 'pick', { bright: true }), tool_scytheCollar: tc => worker(tc, false, 'scythe', { bright: true }),
    ...Object.fromEntries(['wood', 'stone', 'gold', 'food', 'wool', 'berries'].map(w => ['barrow_' + w, tc => pusher(tc, 'barrow', w)])),
    villager: tc => { const g = new THREE.Group(); human(g, tc, { hat: 'hair' }); return g; },
    villagerF: tc => { const g = new THREE.Group(); human(g, tc, { hat: 'long', dress: 'tunic' }); return g; },
    militia: tc => { const g = new THREE.Group(); const hand = [8.2, -6, 0]; human(g, tc, { hat: 'hood', hands: [[6.8, -4.8, 0], hand] }); sword(g, at(...hand)); return g; }, // Dark Age: two-handed (both hands on the grip), no shield
    spearman: tc => { const g = new THREE.Group(); const hand = [5, -6.5, 3.6]; human(g, tc, { hat: 'kettle', hands: [[7.3, -9.4, 3.6], hand] }); spear(g, at(...hand)); return g; }, // both hands on the shaft, which runs outside the leg
    archer: tc => { const g = new THREE.Group(); const hand = [7.5, -8.5, -5]; human(g, tc, { hat: 'hood', hands: [hand, [5.3, -8.5, -5]] }); bow(g, at(...hand)); return g; }, // bow hand on the grip at arm's length, the other on the string
    scout: tc => { const g = new THREE.Group(); horseKit(g, '#8b5a2b', '#3f2810', '#6e4520', tc); g.add(rider(tc, 'hood', false)); return g; },
    knight: tc => { const g = new THREE.Group(); horseKit(g, '#e9e6de', '#9a948a', '#b3ada1', tc, '#b8b2a6'); g.add(rider(tc, 'great', true)); return g; },
    knightStrike: tc => { const g = new THREE.Group(); horseKit(g, '#e9e6de', '#9a948a', '#b3ada1', tc, '#b8b2a6'); g.add(rider(tc, 'great', true, 'strike')); return g; },
    scoutStrike: tc => { const g = new THREE.Group(); horseKit(g, '#8b5a2b', '#3f2810', '#6e4520', tc); g.add(rider(tc, 'hood', false, 'strike')); return g; },
    ram: ramModel, tradecart: cartModel,
  };
  window.__povCharMock = () => {
    const cases = [['villager', 0], ['villager', 1], ['militia', 0], ['spearman', 0], ['archer', 0], ['scout', 0], ['knight', 0], ['ram', 0], ['tradecart', 0]], out = [];
    for (const [ut, fem] of cases) {
      const e = createUnit(ut, 20, 20, myTeam); e.female = !!fem; e.facing = 1; e.path = [];
      const paint = dir => { e.dir = dir; const a = canvasTex(112, 112); clearCtx(a.ctx); drawInto(a.ctx, e.x, e.y, 56, 70 - HALF_TH, () => drawUnit(e)); return a; };
      const art = paint(0), artF = paint(1);
      entities.splice(entities.indexOf(e), 1); entitiesById.delete(e.id);
      const g = CHARACTERS[fem ? 'villagerF' : ut](teamColor(myTeam)); addHulls(g, true);
      const shots = [[0, 0.35, 1.5], [Math.PI / 2, 0.35, 1.5], [Math.PI / 5, 0.55, 1.5]].map(([yaw, y, d]) => {
        const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
        r.setSize(224, 224); r.setPixelRatio(1.5);
        const sc = new THREE.Scene(); for (const l of scene.children) if (l.isLight) sc.add(l.clone()); sc.add(g);
        const big = ut === 'ram' || ut === 'tradecart' ? 2.3 : ut === 'scout' || ut === 'knight' ? 1.6 : 1, cam = new THREE.PerspectiveCamera(35, 1, 0.05, 50);
        const cx = ut === 'tradecart' ? 0.45 : 0; // the cart's ox stands well ahead
        cam.position.set(cx + Math.sin(yaw) * d * big, y * big, Math.cos(yaw) * d * big); cam.lookAt(cx, ut === 'ram' || ut === 'tradecart' ? 0.35 : big > 1 ? 0.62 : 0.3, 0);
        r.render(sc, cam); const u = r.domElement.toDataURL(); r.dispose(); return u;
      });
      out.push({ ut: fem ? 'villager F' : ut, art: art.cv.toDataURL(), artF: artF.cv.toDataURL(), side: shots[0], front: shots[1], q: shots[2] }); art.tex.dispose(); artF.tex.dispose();
    }
    return out;
  };
  // Dev check: a character model alone from four sides (horse: the bare mount).
  window.__povModelTurn = (kind, W = 300) => {
    const g = kind === 'horse' ? (() => { const h = new THREE.Group(); horseKit(h, '#8b5a2b', '#3f2810', '#6e4520', '#2d6bd1'); return h; })() : CHARACTERS[kind]('#2d6bd1');
    const small = !/scout|knight|horse|ram|cart|barrow|plow/.test(kind), tall = /carry_/.test(kind); // people on foot: frame closer
    addHulls(g, true);
    return [0, Math.PI / 2, Math.PI / 4, Math.PI].map(yaw => {
      const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      r.setSize(W, W); r.setPixelRatio(1.5);
      const sc = new THREE.Scene(); for (const l of scene.children) if (l.isLight) sc.add(l.clone()); sc.add(g);
      const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 50); const D = tall ? 2 : small ? 1.45 : 2.6, cx = /barrow|plow/.test(kind) ? 0.3 : /saw/.test(kind) ? 0.18 : 0; cam.position.set(cx + Math.sin(yaw) * D, small ? 0.45 : 0.7, Math.cos(yaw) * D); cam.lookAt(cx, tall ? 0.5 : small ? 0.33 : 0.42, 0);
      r.render(sc, cam); const u = r.domElement.toDataURL(); r.dispose(); return u;
    });
  };
  const ANIMAL_MODELS = { sheep: sheepModel, sheep_carcass: sheepModel, bear: () => bearModel() };
  // Death, as drawCorpse stages it: topple over the feet accelerating (600ms)
  // with a small impact recoil — here a roll onto the side about the body's
  // own axis, coming to rest lying on the ground, legs stiff and splayed,
  // head limp. half: how far the flank sits from the ground once down.
  const DEAD_HALF = { sheep: 0.19, bear: 0.27 };
  function deathPose(model, kind, age){
    const TOPPLE = 600, p = Math.min(1, age / TOPPLE);
    let rot = (Math.PI / 2.1) * p * p;
    if (age > TOPPLE && age < TOPPLE + 300) rot *= 1 + 0.07 * Math.sin((age - TOPPLE) / 300 * Math.PI); // impact recoil
    model.rotation.order = 'YXZ'; model.rotation.x = -rot; // roll about its own long axis
    model.position.y += DEAD_HALF[kind] * Math.sin(Math.min(rot, Math.PI / 2));
    [0, 1, 2, 3].forEach(i => { const l = model.getObjectByName('leg' + i); l.rotation.z = (i < 2 ? -0.45 : 0.45) * p; l.position.y = l.userData.y0 ?? l.position.y; });
    const neck = model.getObjectByName('neck'); neck.rotation.set(0.25 * p, 0, -0.35 * p);
    const jaw = model.getObjectByName('jaw'); if (jaw) jaw.rotation.z = -0.25 * p;
  }
  // A carcass being harvested (its hp is the food left, 100 → 0): the legs go
  // first, then the wool is pulled off bit by bit — the side facing up first — until only the simple
  // skeleton remains. The bones are built inside the body on the first dead
  // frame, so they roll with the fallen sheep.
  function sheepBones(model){
    const body = model.getObjectByName('body'), neck = model.getObjectByName('neck'), bone = '#e8e0cc', sy = 0.3;
    const sk = new THREE.Group(), skull = new THREE.Group();
    // Cartoon bones, the fewest that read: a spine, two fat ribs, a big skull.
    pole(sk, bone, [-0.16, sy, 0], [0.15, sy + 0.01, 0], 0.026, 'post');                 // spine
    for (const x of [-0.07, 0.06]) { // two ribs, arching over the spine once the sheep lies on its side (body +z is up then)
      const geo = own(new THREE.TorusGeometry(0.1, 0.026, 8, 12, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2));
      const rib = new THREE.Mesh(geo, mat(bone)); rib.position.set(x, sy, 0); rib.userData.hullGeo = geo; sk.add(rib);
    }
    blob(skull, bone, 0.12, 0.04, 0, 0.095, 0.1, 0.08);                                  // big skull, where the face was
    blob(skull, bone, 0.21, 0.01, 0, 0.05, 0.045, 0.045);
    for (const z of [-1, 1]) blob(skull, '#2a241c', 0.17, 0.07, z * 0.045, 0.03);       // big eye sockets
    addHulls(sk, true); addHulls(skull, true);
    body.add(sk); neck.add(skull);
    const face = neck.children.filter(o => o !== skull), legs = [0, 1, 2, 3].map(i => model.getObjectByName('leg' + i));
    const puffs = []; model.traverse(o => { if (o.name === 'puff') puffs.push(o); });
    puffs.sort((a, b) => b.position.z - a.position.z || b.position.y - a.position.y); // up-facing (once lying) first
    return { face, legs, puffs, sk, band: model.getObjectByName('band'), tail: model.getObjectByName('tail'), core: model.getObjectByName('core'), skull };
  }
  function harvestPose(model, bones, left){
    const wool = Math.max(0, Math.min(1, (left - 0.12) / 0.88)), bare = left < 0.12;
    bones.puffs.forEach((p, i) => { p.visible = i >= Math.round(bones.puffs.length * (1 - wool)); });
    bones.legs.forEach(o => { o.visible = left > 0.9; }); // the legs go first
    for (const o of [bones.core, bones.tail, ...bones.face]) o.visible = !bare;
    bones.band.visible = wool > 0.5;
    bones.sk.visible = bare; bones.skull.visible = bare;
  }


  // A cartoon bone lying flat: a shaft with a pair of round knobs at each end.
  function cartoonBone(g, a, b, r, col = '#e8e0cc'){
    pole(g, col, a, b, r);
    const d = V3(b).sub(V3(a)), n = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(r * 1.05);
    for (const e of [a, b]) for (const k of [-1, 1]) blob(g, col, e[0] + n.x * k, e[1], e[2] + n.z * k, r * 1.55);
  }
  // A bear's bones, lying on the ground (drawCorpse's skeleton stage): skull,
  // spine, a row of rib arches over it, and the leg bones splayed flat.
  function bearSkeleton(){
    // Cartoon bones: few and fat — three chunky ribs, a big skull with big sockets.
    const g = new THREE.Group(), bone = '#e8e0cc', y = 0.05;
    pole(g, bone, [-0.34, y, 0], [0.24, y + 0.02, 0], 0.035, 'post');                   // spine
    for (let i = 0; i < 3; i++) {                                                      // ribs
      const rib = new THREE.Mesh(own(new THREE.TorusGeometry(i === 1 ? 0.17 : 0.14, 0.032, 8, 14, Math.PI)), mat(bone));
      rib.position.set(-0.1 + i * 0.12, y, 0); rib.rotation.y = Math.PI / 2; rib.userData.hullGeo = rib.geometry; g.add(rib);
    }
    blob(g, bone, 0.38, 0.1, 0, 0.15, 0.11, 0.12);                                     // big skull
    blob(g, bone, 0.52, 0.06, 0, 0.08, 0.055, 0.065);                                  // snout
    for (const z of [-1, 1]) blob(g, '#2a241c', 0.44, 0.15, z * 0.065, 0.04);          // big eye sockets
    for (const [x, z, dx] of [[-0.28, -1, -0.12], [-0.28, 1, -0.1], [0.14, -1, 0.1], [0.14, 1, 0.12]])
      cartoonBone(g, [x, 0.03, z * 0.1], [x + dx, 0.03, z * 0.3], 0.022);             // legs, splayed flat
    return g;
  }
  // Bear corpses (the sim's cosmetic corpse list): the toppled model, a blood
  // pool spreading from under it and drying brown, then — past CORPSE_SKEL —
  // sagging flat and shrinking away by CORPSE_LIFE (sinking would show: the
  // ground hides nothing).
  const corpseModels = new Map();
  const dropCorpse = r => { scene.remove(r.blood); r.blood.geometry.dispose(); r.blood.material.dispose(); dropSolid(r); if (r.skel) { disposeFaded(r.skel); dropSolid({ obj: r.skel }); } };
  function updateCorpses(used){
    const now = performance.now();
    for (const c of corpses) {
      if (c.utype !== 'bear') continue;
      const gx = Math.round(c.x), gy = Math.round(c.y);
      if (!fog[gy] || fog[gy][gx] !== 2 || (c.x - camAt.x) ** 2 + (c.y - camAt.y) ** 2 > RANGE * RANGE) continue;
      const age = now - c.deathTime;
      if (age >= CORPSE_LIFE) continue;
      used.add('c' + c.id);
      let r = corpseModels.get(c.id);
      if (!r) {
        const g = bearModel(); addHulls(g, true); scene.add(g);
        // The pool lies on the ground on its own (the body lifts as it rolls).
        const blood = new THREE.Mesh(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#6b0f0f' }));
        scene.add(blood);
        const v = RIG_DIRV[c.dir] || [1, 0];
        corpseModels.set(c.id, r = { obj: g, blood, yaw: -Math.atan2(v[1], v[0]) });
      }
      r.obj.position.set(c.x + 0.5, 0, c.y + 0.5); r.obj.rotation.y = r.yaw;
      deathPose(r.obj, 'bear', age);
      const spread = Math.min(1, Math.max(0, age - 400) / 2000), dry = Math.min(1, age / CORPSE_SKEL); // dried brown by the bone stage
      r.blood.position.set(c.x + 0.5, -HULL * 1.5, c.y + 0.5); r.blood.scale.setScalar(0.05 + 0.4 * spread);
      r.blood.material.color.set('#6b0f0f').lerp(_c.set('#4a2a1a'), dry);
      // Skeleton stage: the body gives way to its bones, which fade over the last 3s, as the 2D art does.
      const bones = age >= CORPSE_SKEL;
      r.obj.visible = !bones;
      if (bones && !r.skel) { r.skel = bearSkeleton(); addHulls(r.skel); scene.add(r.skel); }
      if (r.skel) {
        const fade = Math.max(0, Math.min(1, (CORPSE_LIFE - age) / 3000));
        r.skel.position.set(c.x + 0.5, 0, c.y + 0.5); r.skel.rotation.y = r.yaw; fadeTo(r.skel, fade);
      }
    }
    for (const [id, r] of corpseModels) if (!used.has('c' + id)) { dropCorpse(r); corpseModels.delete(id); }
  }
  // Dev check: an animal posed (idle | walk | graze | rear | bite, walk at stride
  // phase ph), rendered front three-quarter and side-on.
  window.__povAnimalShot = (kind, pose, ph = 0) => {
    if (pose === 'carcass' || pose === 'bones') { // ph: the food left (sheep); bones: the bear skeleton
      const g = pose === 'bones' ? bearSkeleton() : ANIMAL_MODELS.sheep('#2d6bd1');
      if (pose === 'carcass') { deathPose(g, 'sheep', 2000); harvestPose(g, sheepBones(g), ph); }
      addHulls(g, true);
      return shoot(g, kind);
    }
    const g = ANIMAL_MODELS[kind]('#2d6bd1'), walk = pose === 'walk';
    const e = { id: 1, utype: kind, path: [], eatingGrass: pose === 'graze', __animAttack: pose === 'rear' || pose === 'bite',
      atkCooldown: pose === 'rear' ? T30(60) * 0.3 : pose === 'bite' ? T30(60) * 0.97 : 0 };
    animateAnimal(g, e, { phase: ph, gait: walk ? 1 : 0, graze: e.eatingGrass ? 1 : 0, moved: walk ? 1e-3 : 0 }, 0);
    addHulls(g, true);
    return shoot(g, kind);
  };
  const shoot = (g, kind) => {
    return [[1.3, 0.55, 1.1], [0.05, 0.4, 1.6]].map(([x, y, z]) => {
      const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
      r.setSize(360, 300); r.setPixelRatio(1.5);
      const sc = new THREE.Scene(); for (const l of scene.children) if (l.isLight) sc.add(l.clone());
      sc.add(g); const cam = new THREE.PerspectiveCamera(40, 360 / 300, 0.05, 50);
      const k = kind === 'bear' ? 1.3 : 0.75; cam.position.set(x * k, y * k, z * k); cam.lookAt(0.05, kind === 'bear' ? 0.4 : 0.22, 0);
      r.render(sc, cam); const url = r.domElement.toDataURL(); r.dispose(); return url;
    });
  };

  // Marks painted onto a face (a small canvas texture), cached by key.
  const painted = new Map();
  function paintedMat(key, w, h, draw){
    let m = painted.get(key);
    if (!m) {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      draw(cv.getContext('2d'));
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = tex.minFilter = THREE.NearestFilter;
      m = new THREE.MeshLambertMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      painted.set(key, m);
    }
    return m;
  }
  // Sail canvas with its bold team bands (drawWindmillSails: bands at 34/60/86%
  // of the arm, 12% tall, on the canvas spanning 22–98%).
  const sailMat = tc => paintedMat('sail' + tc, 4, 76, c => {
    c.fillStyle = '#f0ead8'; c.fillRect(0, 0, 4, 76); c.fillStyle = tc;
    for (const v of [0.34, 0.6, 0.86]) c.fillRect(0, 76 - (v - 0.22 + 0.06) * 100, 4, 12);
  });
  // The target's face: yellow, white and red rings (drawTarget).
  const targetMat = () => paintedMat('target', 64, 64, c => {
    for (const [r, col] of [[32, '#e2c046'], [19, '#f2ead8'], [9, '#c0392b']]) { c.fillStyle = col; c.beginPath(); c.arc(32, 32, r, 0, 2 * Math.PI); c.fill(); }
  });
  // Wheat that gives way: stalks and heads bend away from any unit standing
  // among them (wheatPushers, set each frame) and spring back as it moves on.
  const wheatPushers = { value: null }; // 8 × Vector3 [x, z, strength], made in initShared
  const wheatMats = new Map();
  function wheatMat(col){
    let m = wheatMats.get(col);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: col, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      m.onBeforeCompile = sh => {
        sh.uniforms.uPush = wheatPushers;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 uPush[8];')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
            for (int i = 0; i < 8; i++) {
              vec2 d = wp.xz - uPush[i].xy; float dist = length(d);
              if (dist < 0.32 && dist > 0.001) {
                float k = (1.0 - dist / 0.32) * uPush[i].z * wp.y * 3.0;
                transformed.xz += d / dist * k; transformed.y -= k * 0.4;
              }
            }`);
      };
      m.customProgramCacheKey = () => 'wheat';
      wheatMats.set(col, m);
    }
    return m;
  }
  // Many small boxes as one mesh ([x,y,z, sx,sy,sz, rx,rz] or [..., quaternion]
  // each): a farm's 30 sheaves stay a few draw calls.
  const batchTmpl = {};
  function boxBatch(parts, shape = 'box'){ // shape: unit 'box', 'rod' (diameter sx) or 'ball' (an oval sx×sy×sz)
    const tm = batchTmpl[shape] = batchTmpl[shape] || (shape === 'rod' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 6)
      : shape === 'ball' ? new THREE.SphereGeometry(0.5, 8, 6) : new THREE.BoxGeometry(1, 1, 1)).toNonIndexed();
    const P = tm.attributes.position, N = tm.attributes.normal, pos = [], nrm = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), eu = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3(), nm = new THREE.Matrix3();
    for (const [x, y, z, sx, sy, sz, rx = 0, rz = 0] of parts) {
      m.compose(v.set(x, y, z), rx.isQuaternion ? rx : q.setFromEuler(eu.set(rx, 0, rz)), sc.set(sx, sy, sz)); nm.getNormalMatrix(m);
      for (let i = 0; i < P.count; i++) {
        v.fromBufferAttribute(P, i).applyMatrix4(m); pos.push(v.x, v.y, v.z);
        v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); nrm.push(v.x, v.y, v.z);
      }
    }
    const geo = own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return geo;
  }
  // drawBuilding FARM's harvest-down state: food left → which sheaves still
  // stand (each has its own cut threshold, scattered per farm), or none once
  // exhausted. Shared by the model and its rebuild key.
  function farmStanding(e){
    const res = map[e.y] && map[e.y][e.x] ? map[e.y][e.x].res : 0;
    const growth = res / (farmFoodFor(e.team) || e.maxFood || 300), N = FARM_CROP_ROWS.length * FARM_CROP_COLS, fseed = e.x * 7 + e.y * 13;
    return Array.from({ length: N }, (_, n) => !e.exhausted && growth > (((n * 7 + fseed) % N + 0.5) / N));
  }

  // Camp hut (drawBuildingBlock half-width 20 → 0.625-tile block: wall 14px,
  // pyramid roof 8px) in the tile's back-right corner, so the props fit in
  // front; a door in its right (+x) face (drawDoorRight) and a team pennant.
  function campHut(g, e, wallCol, roofCol){
    const s = 20 / 32, wallH = 14 / HPX, box = [e.x + 1 - s, e.y, e.x + 1, e.y + s];
    patch(g, '#8a7252|soil', e.x, e.y, e.x + 1, e.y + 1); // drawCampClearing: packed dirt over the whole tile, faint edge
    const f = boxFaces(...box, 0, wallH);
    f.x1.holes.push(hole('x1', box, 0.5, SILL, s / 4, 8 / HPX));
    solid(g, wallCol, Object.values(f));
    // 'peaked' block roof: in the art's projection its apex sits roofH + bhh
    // (8 + 10px) above the wall top — a pyramid on the block's own corners.
    const rise = 18 / HPX;
    pyramid(g, roofCol, ...box, wallH, rise);
    pennant(g, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, wallH + rise, teamColor(e.team));
  }

  function refreshModel(e){
    const done = e.complete ? 1 : Math.max(0.15, e.buildProgress / e.buildTime);
    const key = ageOf(e) + ':' + teamColor(e.team) + ':' + (e.w || 0) + 'x' + (e.h || 0) + ':' + (e.complete ? 1 : 0)
      + (e.btype === 'FARM' ? ':' + farmStanding(e).map(Number).join('') : '');
    let rec = solids.get(e.id);
    if (!rec || rec.key !== key) {
      if (rec) dropSolid(rec);
      const g = new THREE.Group();
      MODELS[e.btype](g, e);
      addHulls(g);
      scene.add(g);
      const flags = [], horses = [];
      g.traverse(o => {
        if (o.name === 'flag') flags.push(o);
        if (o.name === 'horseNeck') horses.push({ neck: o, head: o.getObjectByName('horseHead'), tail: o.parent.getObjectByName('horseTail'), seed: o.parent.userData.horseSeed });
      });
      rec = { obj: g, key, sails: g.getObjectByName('sails'), flags, horses };
      solids.set(e.id, rec);
    }
    rec.obj.scale.y = done; // rises as it's built
  }
  // Dev check: a model rendered from the exact iso angle beside its 2D art.
  window.__povIsoCheck = id => {
    const rec = solids.get(id), e = entitiesById.get(id);
    if (!rec || !e) return null;
    const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h;
    const cw = (w + h) * HALF_TW + 64, ch = (w + h) * HALF_TH + BLDG_TOP, ay = ch - BLDG_BASE - (w + h) * HALF_TH / 2;
    const art = canvasTex(cw, ch);
    clearCtx(art.ctx);
    drawInto(art.ctx, centerOf(e).x, centerOf(e).y, cw / 2, ay, () => drawBuilding(e));
    const c = centerOf(e);
    const cam = new THREE.OrthographicCamera(-cw / 2 / PX, cw / 2 / PX, ay / PX, -(ch - ay) / PX, 0.1, 400);
    const d = new THREE.Vector3(Math.cos(Math.PI / 6) / Math.SQRT2, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6) / Math.SQRT2);
    cam.position.set(c.x, 0, c.y).addScaledVector(d, 100); cam.lookAt(c.x, 0, c.y);
    const r = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setSize(cw, ch); r.setPixelRatio(SS);
    const sc = new THREE.Scene();
    for (const l of scene.children) if (l.isLight) sc.add(l.clone());
    sc.add(rec.obj.clone());
    r.render(sc, cam);
    const out = { art: art.cv.toDataURL(), model: r.domElement.toDataURL() };
    r.dispose(); art.tex.dispose();
    return out;
  };
  // Viewer-only motion (animTick, never the sim): sails, gate doors, flags, horses.
  const ease = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  function animateModels(dt){
    const t = animTick * 0.13;
    for (const rec of solids.values()) {
      if (rec.sails) rec.sails.rotation.z += dt * 0.9;
      if (rec.door) { // gates slide their door up as they open (read-only)
        const ge = entitiesById.get(rec.doorOf);
        rec.door.position.y = ge ? (ge.gateProgress || 0) * 26 / HPX : 0;
      }
      if (rec.flags) for (const f of rec.flags) { // the art's travelling wave
        const pos = f.geometry.attributes.position, rest = f.geometry.userData.rest, L = f.userData.len;
        for (let i = 0; i < pos.count; i++) {
          const u = rest[3 * i] / L;
          pos.setZ(i, (Math.sin(t - u * 4.2) * 0.07 + Math.sin(t * 0.63 - u * 7) * 0.02) * u);
          pos.setY(i, rest[3 * i + 1] - 0.05 * u * u);
        }
        pos.needsUpdate = true;
      }
      if (rec.horses) for (const h of rec.horses) {
        // Each horse on its own ~11s cycle: head up (a slow bob), then down to
        // graze a few seconds, nibbling; the tail swishes throughout.
        const sec = animTick / 30 + h.seed * 11, ph = (sec / 11) % 1;
        const graze = ease(0.3, 0.4, ph) - ease(0.72, 0.82, ph);
        h.neck.rotation.z = -1.05 * graze + 0.07 * graze * Math.sin(sec * 7) + 0.04 * (1 - graze) * Math.sin(sec * 0.9);
        h.head.rotation.z = -0.8 * graze;
        h.tail.rotation.x = 0.35 * Math.sin(sec * 2.3 + h.seed * 6);
        h.tail.rotation.z = 0.08 * Math.sin(sec * 1.1);
      }
    }
  }

  function refreshBuildings(){
    const seen = new Set();
    for (const e of entities) {
      if (e.type !== 'building' || e.hp <= 0) continue;
      const c = centerOf(e);
      if (Math.abs(c.x - eye.x) > RANGE + 4 || Math.abs(c.y - eye.y) > RANGE + 4 || !bldgVisible(e)) continue;
      seen.add(e.id);
      if (isWallBtype(e.btype) || isGateBtype(e.btype)) refreshWall(e);
      else refreshModel(e);
    }
    for (const [id, w] of solids) if (!seen.has(id)) { dropSolid(w); solids.delete(id); }
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

  let lastUnitsAt = 0;
  function updateUnits(){
    const now = performance.now(), dt = lastUnitsAt ? Math.min(0.1, (now - lastUnitsAt) / 1000) : 0;
    lastUnitsAt = now;
    const near = [];
    for (const e of entities) {
      if (e.type !== 'unit' || (e.id === followId && mode === 'eye')) continue;
      const dx = e.x + 0.5 - camAt.x, dy = e.y + 0.5 - camAt.y, d2 = dx * dx + dy * dy;
      if (d2 > RANGE * RANGE || d2 < 0.5 || !unitVisible(e)) continue; // not ones standing on the camera
      near.push({ e, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2 || a.e.id - b.e.id);
    const used = new Set();
    const SU = feat.shadowU; SU.n = 0;
    const WP = wheatPushers.value; let wn = 0;
    for (const { e } of near) { if (wn >= 8) break; const a = animals.get(e.id); WP[wn++].set(a ? a.x : e.x + 0.5, a ? a.z : e.y + 0.5, 1); }
    for (; wn < 8; wn++) WP[wn].set(1e6, 1e6, 0);
    for (const { e, d2 } of near.slice(0, MAX_UNITS)) {
      used.add(e.id);
      if (e.utype !== 'sheep_carcass') { // a soft contact shadow under every standing unit
        const r = e.utype === 'bear' ? 0.42 : e.utype === 'sheep' ? 0.3 : isMountedUnit(e.utype) || e.utype === 'ram' || e.utype === 'tradecart' ? 0.4 : 0.2;
        const a = animals.get(e.id);
        put('shadowU', a ? a.x : e.x + 0.5, 0.007, a ? a.z : e.y + 0.5, 2 * r, 1, 2 * r);
      }
      if (ANIMAL_MODELS[e.utype]) { // 3D, posed live from its state
        const dead = e.utype === 'sheep_carcass', kind = dead ? 'sheep' : e.utype; // a carcass keeps its sheep, toppled
        const key = kind + teamColor(e.team), tx = e.x + 0.5, tz = e.y + 0.5;
        let a = animals.get(e.id);
        const ty = dead && a ? a.yaw : -worldFacing(e); // the fallen keep the heading they died with
        if (a && a.key !== key) { dropSolid(a); a = null; }
        if (!a) { const g = ANIMAL_MODELS[e.utype](teamColor(e.team)); addHulls(g, true); scene.add(g); animals.set(e.id, a = { obj: g, key, x: tx, z: tz, yaw: ty, phase: 0, gait: 0, graze: 0 }); }
        // Glide between sim steps and ease into turns (a jump of 2+ tiles snaps).
        const f = (tx - a.x) ** 2 + (tz - a.z) ** 2 > 4 ? 1 : Math.min(1, dt * 12), nx = a.x + (tx - a.x) * f, nz = a.z + (tz - a.z) * f;
        a.moved = Math.hypot(nx - a.x, nz - a.z); a.x = nx; a.z = nz;
        a.yaw += Math.atan2(Math.sin(ty - a.yaw), Math.cos(ty - a.yaw)) * Math.min(1, dt * 8);
        a.obj.position.set(a.x, 0, a.z); a.obj.rotation.y = a.yaw;
        if (dead) { // seen already dead: lying; then eaten down as it is harvested
          a.deadAt = a.deadAt || (a.alive ? now : now - 2000);
          deathPose(a.obj, 'sheep', now - a.deadAt);
          a.bones = a.bones || sheepBones(a.obj);
          harvestPose(a.obj, a.bones, Math.max(0, Math.min(1, e.hp / (e.maxHp || 100))));
        }
        else { a.alive = true; animateAnimal(a.obj, e, a, dt); }
        continue;
      }
      let rec = unitSprites.get(e.id);
      // Close up a unit fills much of the screen: paint it sharper (hysteresis
      // so one at the edge doesn't flip resolution every frame).
      const want = d2 < 16 ? SS_NEAR : d2 > 25 ? SS : rec ? rec.ctx._ss : SS;
      if (rec && rec.ctx._ss !== want) {
        rec.tex.dispose();
        Object.assign(rec, canvasTex(UNIT_BUF, UNIT_BUF, want));
        rec.sprite.material.map = rec.tex; rec.sprite.material.needsUpdate = true; rec.fresh = true;
      }
      if (!rec) {
        rec = canvasTex(UNIT_BUF, UNIT_BUF, want);
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
    SU.mesh.count = SU.n; SU.mesh.instanceMatrix.needsUpdate = true;
    for (const [id, a] of animals) if (!used.has(id)) { dropSolid(a); animals.delete(id); }
    updateCorpses(used);
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
      // The rig now faces RIG_DIRV[d] instead of the unit's real heading; turn
      // its attack aim by the same angle so swings and shots follow the body.
      window._povAimRot = Math.atan2(RIG_DIRV[d][1], RIG_DIRV[d][0]) - worldFacing(e);
      drawInto(rec.ctx, e.x, e.y, UNIT_BUF / 2 - ox, UNIT_ANCHOR_Y - HALF_TH - oy, () => drawUnit(e));
    } finally { Object.assign(e, keep); window._povAimRot = 0; }
    // The art draws feet (hooves most) a few px below the ground point; stand
    // each type on its lowest painted row, measured once, so none sink.
    let low = footRow.get(e.utype);
    if (low === undefined) {
      const { width: W, height: H } = rec.cv, d = rec.ctx.getImageData(0, 0, W, H).data;
      low = UNIT_ANCHOR_Y;
      for (let y = H - 1; y >= 0 && low === UNIT_ANCHOR_Y; y--) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 128) { low = Math.max(UNIT_ANCHOR_Y, (y + 1) / rec.ctx._ss); break; }
      footRow.set(e.utype, low);
    }
    rec.sprite.center.y = 1 - low / UNIT_BUF;
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
    animateFeatures(dt);
    updateArrows(now);
    clouds.position.set(camera.position.x, 0, camera.position.z); clouds.rotation.y = animTick * 0.00004;
    animateModels(dt);
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
    for (const a of animals.values()) dropSolid(a);
    animals.clear();
    for (const r of corpseModels.values()) dropCorpse(r);
    corpseModels.clear();
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
  window.povStats = () => ({ frames: frame, jsMs: +stats.js.toFixed(2), glMs: +stats.gl.toFixed(2), units: unitSprites.size, animals: animals.size, buildings: solids.size, arrows: feat.shaft ? feat.shaft.n : 0, shadows: feat.shadow ? feat.shadow.mesh.count : 0 });
})();
