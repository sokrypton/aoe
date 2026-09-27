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
  const unitSprites = new Map(), solids = new Map(), mats = new Map(), footRow = new Map(); // footRow: utype → lowest painted canvas row
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

    unitBox = new THREE.BoxGeometry(1, 1, 1);
    unitRod = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
    ink = new THREE.LineBasicMaterial({ color: 0x000000 });
    hullMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 });
    initFeatures();
    initClouds();
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
  let ink = null, hullMat = null, edgeCache = new Map(), pyramidGeo = null;
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
  function addHulls(g){
    g.updateMatrixWorld(true);
    const meshes = [];
    g.traverse(o => { if (o.isMesh && o.userData.hullGeo) meshes.push(o); });
    const s = new THREE.Vector3(), M = new THREE.Matrix3(), Mi = new THREE.Matrix3(), wp = new THREE.Vector3(), off = new THREE.Vector3();
    for (const m of meshes) {
      const src = m.userData.hullGeo;
      M.setFromMatrix4(m.matrixWorld); Mi.copy(M).invert();
      m.getWorldScale(s).set(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
      const hg = hullGeometry(src, s, m.userData.hullW || HULL, (i, o) => {
        if (wp.fromBufferAttribute(src.attributes.position, i).applyMatrix4(m.matrixWorld).y >= 0.004) return;
        off.copy(o).applyMatrix3(M); // on the ground: no downward growth
        if (off.y < 0) { off.y = 0; o.copy(off.applyMatrix3(Mi)); }
      });
      if (hg) m.add(new THREE.Mesh(own(hg), hullMat));
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
    g.add(inked(geo, [mat(col), mat(endCol), mat(endCol)], cx, y, cz, 1, 1, 1, 30));
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
        g.add(new THREE.Mesh(boxBatch(stalks, 'rod'), mat('#c9a227')));
        g.add(new THREE.Mesh(boxBatch(heads, 'ball'), mat('#e8c84a'))); // plain grain heads: no ink
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
  const TREE_H = 24 / HPX, CROWN_R = 12 / PX, STUMP_H = 8 / HPX;
  const wind = { value: 0 };
  const feat = {};
  let fallers = [], glints = [];
  // Bend a material in the art's wind toward screen-x, more the higher the
  // vertex. Instances may turn about y and scale, so the world wind direction
  // is taken into each instance's own frame (local y stays height).
  function swaying(m){
    m.onBeforeCompile = sh => {
      sh.uniforms.uWind = wind;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vec3 ip = instanceMatrix[3].xyz;
            float sw = sin(uWind * 0.015 + ip.x * 0.45 + ip.z * 0.35) * 0.035 + max(0.0, sin(uWind * 0.004 - (ip.x + ip.z) * 0.07) - 0.4) * 0.16;
            mat3 swayM = mat3(instanceMatrix); float swayK2 = dot(swayM[0], swayM[0]); // three already declares 'im'
            transformed += transpose(swayM) * vec3(0.7071, 0.0, -0.7071) / swayK2 * (transformed.y * length(swayM[1]) * sw);
          #endif`);
    };
    m.customProgramCacheKey = () => 'sway';
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
    const leaf = swaying(new THREE.MeshLambertMaterial({ color: '#ffffff' })), hullSway = swaying(hullMat.clone());
    // drawFullTreeBody: a round trunk 24px tall into a cloud of puffs (12px
    // centre, 9px cheeks round it, two 9px caps across the screen).
    const trunk = new THREE.CylinderGeometry(2.2 / PX, 2.2 / PX, TREE_H, 10).translate(0, TREE_H / 2, 0);
    // Three crown shapes so a forest isn't stamped: the art's round cloud, a
    // taller one (caps stacked higher), a wide spreading one.
    const puff = (r, x, y, z) => new THREE.SphereGeometry(r, 9, 6).translate(x, y, z), sm = 9 / PX;
    const ring = (n, rad, y, r, rot = Math.PI / 4) => Array.from({ length: n }, (_, i) => { const a = rot + i * 2 * Math.PI / n; return puff(r, Math.cos(a) * rad, y, Math.sin(a) * rad); });
    const caps = (y, d) => [-1, 1].map(s => puff(sm, s * SCREEN_X[0] * d, y, s * SCREEN_X[1] * d));
    const crowns = [
      merged([puff(CROWN_R, 0, TREE_H, 0), ...ring(4, CROWN_R * 0.8, TREE_H - 0.04, sm), ...caps(30 / HPX, 5 / PX)]),
      merged([puff(CROWN_R * 0.9, 0, TREE_H + 0.05, 0), ...ring(3, CROWN_R * 0.65, TREE_H - 0.02, sm * 0.95, 0.3), ...caps(TREE_H + 0.2, 3 / PX), puff(sm * 0.8, 0, TREE_H + 0.3, 0)]),
      merged([puff(CROWN_R, 0, TREE_H - 0.02, 0), ...ring(5, CROWN_R * 1.0, TREE_H - 0.06, sm, 0.2), puff(sm, 0, TREE_H + 0.13, 0)]),
    ];
    const crown = crowns[0];
    part('trunk', trunk, sway, one, HULL, hullSway);
    crowns.forEach((c, i) => part('crown' + i, c, leaf, one, HULL, hullSway));
    part('trunkF', trunk, new THREE.MeshLambertMaterial({ color: '#8B4513' }), one, HULL); // felled: no sway
    part('crownF', crown, new THREE.MeshLambertMaterial({ color: '#4db536' }), one, HULL);
    part('stump', new THREE.CylinderGeometry(2.6 / PX, 3.5 / PX, STUMP_H, 12).translate(0, STUMP_H / 2, 0),
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
        if ((wx - camAt.x) ** 2 + (wz - camAt.y) ** 2 < 1) continue; // never stand the chase camera inside a canopy
        const k = 1.05 * (0.8 + ((x * 17 + y * 23) % 5) * 0.08); // the art's per-tree size noise
        if (t.res > 60) { // each tree its own: crown shape, turn, proportions, shade, a nudge off the grid
          const h = n => tileHash(x, y, n);
          const tx = wx + (h(1) - 0.5) * 0.2, tz = wz + (h(2) - 0.5) * 0.2, rot = h(3) * 6.283, kw = k * (0.9 + h(4) * 0.2), kh = k * (0.9 + h(5) * 0.22);
          put('trunk', tx, 0, tz, kw, kh, kw, rot, _c2.setRGB(0.545, 0.271, 0.075, THREE.SRGBColorSpace).multiplyScalar(0.9 + h(6) * 0.2).getHex());
          put('crown' + Math.floor(h(7) * 3), tx, 0, tz, kw, kh, kw, rot, _c2.setHSL(0.31 + (h(8) - 0.5) * 0.05, 0.54, 0.46 + (h(9) - 0.5) * 0.1, THREE.SRGBColorSpace).getHex());
          continue;
        }
        // drawTreeEntity: at 60 the tree is cut (its fall clock lives in
        // treeFellTicks, a render-side map) — a stump, the tree falling or lying
        // beside it while wood remains above 20, then just the stump.
        const key = x + ',' + y;
        if (!treeFellTicks.has(key)) treeFellTicks.set(key, tick);
        put('stump', wx, 0, wz, k, k, k);
        const falling = tick - treeFellTicks.get(key) < T30(40);
        if (falling || t.res > 20) fallers.push({ wx, wz, k, key });
      } else if (t.t === TERRAIN.GOLD || t.t === TERRAIN.STONE) {
        // A main boulder with two smaller ones tucked in behind it (the art's
        // cluster), all worn lower together as it is mined. Per tile: the whole
        // deposit 0.8–1.2×, each boulder ±10%, and each small one at its own
        // angle on its side — mostly behind to mostly beside — at a distance
        // from the actual sizes so none ever touch; all inside the tile.
        const gold = t.t === TERRAIN.GOLD, p = Math.min(1, t.res / (gold ? 800 : 350)), k = 0.25 + 0.75 * p, w = 0.8 + 0.2 * p;
        const r = n => tileHash(x, y, n), size = 0.8 + 0.4 * r(20);
        const cols = gold ? ['#e8b90f', '#d1a017', '#c99815'] : ['#9d9d9d', '#8c8c8c', '#95958f'];
        const B = [[0.14, 0.34, 1.08, 0.94], [0.08, 0.22, 0.94, 1.06], [0.075, 0.19, 1, 0.92]]; // [half, height, x-, z-stretch]
        const V = B.map((_, i) => size * (0.9 + r(4 + i * 5) * 0.2));                       // each boulder's scale
        const R = B.map(([half, , sx, sz], i) => half * Math.max(sx, sz) * w * V[i] * 1.02); // its footprint radius (lathe bulge 1.02)
        B.forEach(([half, h, sx, sz], i) => {
          const vw = V[i];
          let bx = wx, bz = wz;
          if (i) { // back is world (−1,−1)/√2, screen-x the lateral
            const side = i === 1 ? -1 : 1, a = side * (0.45 + r(30 + i) * 0.95), d = R[0] + R[i] + 0.03;
            bx += d * (Math.cos(a) * -Math.SQRT1_2 + Math.sin(a) * SCREEN_X[0]); bz += d * (Math.cos(a) * -Math.SQRT1_2 + Math.sin(a) * SCREEN_X[1]);
          }
          const hh = h * k * size * (0.9 + r(3 + i * 5) * 0.2);
          put(gold ? 'gold' : 'stone', bx, 0, bz, half * sx * w * vw, hh, half * sz * w * vw, i * 0.7 + r(5 + i * 5) * 6.283, cols[i]);
          if (gold) for (const [u, v] of i === 0 ? [[0.3, -0.2], [-0.35, 0.3]] : [[0.1, 0.1]])
            glints.push({ x: bx + u * half * vw, y: hh * 1.02, z: bz + v * half * vw, size: (i === 0 ? 0.12 : 0.08) * size, phase: (x * 13 + y * 7 + glints.length * 2.3) % 6.28 });
        });
      } else if (t.t === TERRAIN.BERRIES) {
        // A low round mound of leaf puffs, stripped in two steps; berries on
        // the leaves, picked one by one (seeded per tile, like the art).
        const p = Math.min(1, t.res / 125), seed = x * 7 + y * 13;
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
  // Per frame: the wind clock, falling / fallen trees, twinkling glints.
  function animateFeatures(){
    wind.value = animTick;
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
    for (const { e, d2 } of near.slice(0, MAX_UNITS)) {
      used.add(e.id);
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
    animateFeatures();
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
  window.povStats = () => ({ frames: frame, jsMs: +stats.js.toFixed(2), glMs: +stats.gl.toFixed(2), units: unitSprites.size, buildings: solids.size, arrows: feat.shaft ? feat.shaft.n : 0 });
})();
