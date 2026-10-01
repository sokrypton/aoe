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
  const MAX_UNITS = 60, MAX_UNITS_WORLD = 150;   // the corner window / the 3D world view (rigs are cheap; nearest the camera first)
  const STATIC_MS = 500;             // terrain/trees/building-set refresh cadence
  const BLDG_TOP = 230, BLDG_BASE = 10; // px of headroom above / margin below a footprint

  let THREE = null, loading = null;
  let unrevealed = false;   // the world view opened, its first frame not drawn yet (window.world3D waits for it)
  let fadeIn = false;       // that first frame fades up (a match opening in 3D)
  let renderer, scene, camera, groundTex, groundData, groundMesh, groundFor = null, fowTex, fowData, SKY, VOID;
  const unitSprites = new Map(), solids = new Map(), mats = new Map(), footRow = new Map(), animals = new Map(); // animals: id → 3D sheep/bear // footRow: utype → lowest painted canvas row
  let unitBox = null, unitRod = null;
  let pip, titleEl, followId = null, raf = 0, lastStatic = 0, staticAt = null, frame = 0;
  let eye = null, yaw = 0;           // smoothed unit position / heading
  let camAt = { x: 0, y: 0 };        // where the camera stands (world tiles)
  let mode = 'chase', world = false;   // 'orbit' (the world view's RTS camera), 'chase' = behind the unit, 'eye' = first person; world: the 3D world view
  let btnFull, btnClose, hintEl, joyEl, actEl;
  let swingAt = 0; const SWING_MS = 650;   // a swing the player asked for (first person), played at once

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
    renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true }); // stencil: the behind-building outlines
    renderer.localClippingEnabled = true;                                   // construction sites (constructionSite)
    renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1)); // full screen on phones gets heavy
    pip.insertBefore(renderer.domElement, pip.firstChild);
    scene = new THREE.Scene();
    SKY = new THREE.Color('#9fc8e6'); VOID = new THREE.Color('#000000');
    scene.background = SKY;
    scene.fog = new THREE.Fog(SKY.clone(), RANGE * 0.45, RANGE);
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
    wheatPushers.value = Array.from({ length: WHEAT_PUSH }, () => new THREE.Vector4(1e6, 1e6, 0, 0.32));
    unitBox = new THREE.BoxGeometry(1, 1, 1);
    unitRod = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
    ink = new THREE.LineBasicMaterial({ color: 0x000000 });
    hullWorldMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 }); // shells pushed in world units (the few deliberately fine ones: arrows, berries)
    hullMat = screenHull(hullWorldMat.clone(), HULL, 1.5);
    HULL_MATS.add(hullWorldMat).add(hullMat);
    hullUnionMat = screenHull(new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, depthWrite: false }), HULL, 1.5);
    HULL_MATS.add(hullUnionMat);
  }
  // A character's outline shell sits ON its parts and the vertex shader pushes it out along its stored outward
  // direction (the normal attribute), measured on screen: the world width w (bold up close, like the solid it
  // outlines), never under minPx pixels — one even width on every part, thick or thin. A face turned to the
  // camera has no screen direction: its push shrinks rather than spikes.
  function screenHull(m, w, minPx){
    const U = { uHullRes: { value: new THREE.Vector2(1000, 700) }, uHullPx: { value: 2 }, uHullW: { value: w } };
    const prev = m.onBeforeCompile, k0 = m.customProgramCacheKey();                // on top of what it has (a tree's sway)
    m.onBeforeRender = r => { r.getDrawingBufferSize(U.uHullRes.value); U.uHullPx.value = minPx * r.getPixelRatio(); };
    m.onBeforeCompile = function(sh, r){ prev.call(this, sh, r); Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec2 uHullRes; uniform float uHullPx, uHullW;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          #ifdef USE_SKINNING
            vec3 hN = objectNormal;
          #else
            vec3 hN = normal;
            #ifdef USE_INSTANCING
              hN = mat3(instanceMatrix) * hN;
            #endif
          #endif
          if (dot(hN, hN) > 1e-10) {
            vec2 sd = (projectionMatrix * vec4(normalize(normalMatrix * hN), 0.0)).xy * uHullRes;
            vec2 n2 = sd / max(length(sd), 0.5 * projectionMatrix[1][1] * uHullRes.y);
            float pw = max(uHullPx, uHullW * projectionMatrix[1][1] * 0.5 * uHullRes.y / gl_Position.w);
            gl_Position.xy += n2 * pw * 2.0 / uHullRes * gl_Position.w;
          }`); };
    m.customProgramCacheKey = () => k0 + '|screen-hull';
    return m;
  }
  // A sky of puffy clouds (the tree crowns' idiom: clustered puffs, flat
  // undersides) round the horizon. They ride with the camera like a distant
  // sky, drift slowly on aTick, and skip the distance haze. Fixed layout.
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

  // Explored-but-unseen dims every object as it dims the ground (2D darkens buildings, trees and ore there): each
  // mesh material multiplies in the fog texture at its world position — patched once, just before its first draw.
  const fowU = { value: null }; let fowHooked = false;
  function fowPatch(m){
    if (!(m.isMeshBasicMaterial || m.isMeshLambertMaterial || m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial)) return;
    const prev = m.onBeforeCompile, key = m.customProgramCacheKey() + '|fow' + MAP;   // key read BEFORE the swap (the default key is the function's source)
    const f = function(sh, r){ prev.call(this, sh, r); sh.uniforms.fowMap = fowU;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vFowUv;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 fowW = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            fowW = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);   // (a tree, a rock: lit by the fog of the tile it stands on — a crown over unexplored ground doesn't go black)
          #endif
          fowW = modelMatrix * fowW; vFowUv = vec2(fowW.x / ${MAP}.0, 1.0 - fowW.z / ${MAP}.0);`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D fowMap; varying vec2 vFowUv;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb *= texture2D(fowMap, vFowUv).r;'); };
    f.fow = true; m.onBeforeCompile = f; m.customProgramCacheKey = () => key; m.needsUpdate = true;
  }
  function hookFow(){
    if (fowHooked) return; fowHooked = true;
    THREE.Mesh.prototype.onBeforeRender = function(r, s, c, g, m){ if (m && !m.onBeforeCompile.fow && fowU.value) fowPatch(m); };
  }
  function buildGround(){
    if (groundMesh) { scene.remove(groundMesh); groundMesh.traverse(o => o.geometry && o.geometry.dispose()); groundTex.dispose(); fowTex.dispose(); }
    groundData = new Uint8Array(MAP * MAP * 4);
    groundTex = new THREE.DataTexture(groundData, MAP, MAP);
    groundTex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(MAP, MAP);
    geo.rotateX(-Math.PI / 2);
    // No depth writes, drawn first: sprite billboards may dip below y=0.
    fowData = new Uint8Array(MAP * MAP * 4);
    fowTex = new THREE.DataTexture(fowData, MAP, MAP); fowTex.magFilter = fowTex.minFilter = THREE.NearestFilter; // crisp tile edges, as 2D
    fowU.value = fowTex; hookFow();
    const gm = new THREE.MeshBasicMaterial({ map: groundTex, depthWrite: false });
    gm.onBeforeCompile = sh => { sh.uniforms.fowMap = { value: fowTex };
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D fowMap;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= texture2D(fowMap, vMapUv).r;'); };
    gm.customProgramCacheKey = () => 'ground-fow';
    gm.onBeforeCompile.fow = true;
    groundMesh = new THREE.Mesh(geo, gm);
    groundMesh.renderOrder = -1;
    groundMesh.position.set(MAP / 2, 0, MAP / 2);
    scene.add(groundMesh);
    // beyond the map's edge: black too (the 2D map's void), just under the ground
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(MAP * 5, MAP * 5).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#000000', depthWrite: false })); // hazed like the ground: no hard band against the sky
    edge.position.set(0, -0.002, 0); edge.renderOrder = -2; groundMesh.add(edge);             // (a child: it's rebuilt and dropped with the ground)
    groundFor = map;
    dropBuildings(); heading.clear(); // a new world reuses entity ids
  }

  const rgbCache = new Map();
  function rgb(hex){
    let c = rgbCache.get(hex);
    if (!c) { const n = parseInt(hex.slice(1), 16); c = [n >> 16, (n >> 8) & 255, n & 255]; rgbCache.set(hex, c); }
    return c;
  }
  const shadowed = new Set();
  function refreshGround(){
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
      const f = (fog[y] && fog[y][x]) || 0;
      const i = ((MAP - 1 - y) * MAP + x) * 4; // texture row 0 is the plane's far (+Z) edge
      // the tile's own colour and the fog of war, both per tile and crisp as 2D: unexplored black, explored-but-unseen dimmed
      fowData[i] = f === 2 ? 255 : f ? 140 : 0; fowData[i + 1] = fowData[i + 2] = 0; fowData[i + 3] = 255;
      const cols = TCOL[map[y][x].t === TERRAIN.FOREST ? TERRAIN.GRASS : map[y][x].t] || TCOL[0]; // under a tree, grass: its shadow does the darkening
      const c = rgb(cols[(x * 7 + y * 13) % cols.length]);
      groundData[i] = c[0]; groundData[i + 1] = c[1]; groundData[i + 2] = c[2]; groundData[i + 3] = 255;
    }
    // A building shows at ONE fog level, as 2D draws it (buildingFogLevel): its whole footprint takes that level in the
    // fog texture, so a building half on unexplored ground isn't half black
    for (const e of entities) {
      if (e.type !== 'building' || e.hp <= 0 || !bldgVisible(e)) continue;
      const lv = buildingFogLevel(e) === 2 ? 255 : 140, b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h;
      for (let y = e.y; y < e.y + h; y++) for (let x = e.x; x < e.x + w; x++) {
        if (x < 0 || y < 0 || x >= MAP || y >= MAP) continue; const i = ((MAP - 1 - y) * MAP + x) * 4; if (fowData[i] < lv) fowData[i] = lv; }
    }
    // Building shadows baked into the ground, tile by tile (16% darker under each footprint, as 2D's 16% black): on the
    // grid, once per tile however many pieces meet there (a wall run never doubles up); farms and the open market none.
    for (const e of entities) {
      if (e.type !== 'building' || e.hp <= 0 || e.btype === 'FARM' || e.btype === 'MARKET' || !bldgVisible(e)) continue;
      const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h;
      for (let y = e.y; y < e.y + h; y++) for (let x = e.x; x < e.x + w; x++) {
        if (x < 0 || y < 0 || x >= MAP || y >= MAP || shadowed.has(y * MAP + x)) continue;
        shadowed.add(y * MAP + x); const i = ((MAP - 1 - y) * MAP + x) * 4;
        for (let k = 0; k < 3; k++) groundData[i + k] = Math.round(groundData[i + k] * 0.84);
      }
    }
    shadowed.clear();
    groundTex.needsUpdate = true; fowTex.needsUpdate = true;
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
      m.userData.detail = detail; m.userData.plain = !detail;             // (plain: a colour and nothing more — a rig merges these)
      mats.set(k, m);
      // made in the cached poses' placeholder team colour (or its light tint): a clone swaps it for the real team's
      if (color === VIL_TC) tcSwaps.set(m, t => mat(t + col.slice(VIL_TC.length), twoSided));
      else if (color === lightOf(VIL_TC)) tcSwaps.set(m, t => mat(lightOf(t) + col.slice(color.length), twoSided));
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
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = mat3(modelMatrix) * objectNormal;'); // after skinning: patterns ride a skinned part
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
  // The walls' inner lines, soft as the 2D wall art's strokes (not the black ink):
  // a box's 12 edges, or — for a run or door butting into pillars — only its
  // 4 edges ALONG `along` ('x'|'z'), never the end edges buried in a pillar face.
  let softInk = null;
  function softEdges(g, x0, z0, x1, z1, y0, y1, along){
    softInk = softInk || new THREE.LineBasicMaterial({ color: '#2b2118', transparent: true, opacity: 0.4 });
    const P = [], seg = (a, b) => P.push(...a, ...b);
    for (const y of [y0, y1]) for (const z of [z0, z1]) if (along !== 'z') seg([x0, y, z], [x1, y, z]);
    for (const y of [y0, y1]) for (const x of [x0, x1]) if (along !== 'x') seg([x, y, z0], [x, y, z1]);
    if (!along) for (const x of [x0, x1]) for (const z of [z0, z1]) seg([x, y0, z], [x, y1, z]);
    const geo = own(new THREE.BufferGeometry()); geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.add(new THREE.LineSegments(geo, softInk));
  }
  const occupantAt = (x, y) => { const row = map[y], cell = row && row[x]; return cell && cell.occupied != null ? entitiesById.get(cell.occupied) : null; };
  function refreshWall(e){
    const arms = wallArms(e, occupantAt, n => !isTowerBtype(n.btype)), hurt = isHurt(e), key = wallKey(e, arms) + (hurt ? ':hurt' : '');
    let rec = solids.get(e.id);
    if (rec && rec.key === key) return;
    if (rec) { if (rec.site && e.complete) siteDone(e); dropSolid(rec); }
    const r = wallModel(e, arms); r.obj.userData.bid = e.id;
    const b = BLDGS[e.btype];
    if (!e.complete) { r.site = constructionSite(r.obj, e.x, e.y, e.w || b.w, e.h || b.h, false); r.siteOf = e.id; }
    else if (hurt) { r.dmg = buildingDamage(r.obj, e.x, e.y, e.w || b.w, e.h || b.h); r.dmg.jump(Math.min(DMG_FROM, e.hp / e.maxHp)); }
    scene.add(r.obj); solids.set(e.id, { ...r, key });
  }
  // The links a wall/gate e draws to its same-team wall-like neighbors (at(x, y) → the entity there); shared(n):
  // n draws that link itself, so e leaves its -x/-z one to it.
  function wallArms(e, at, shared){
    const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h, arms = [];
    for (let fy = e.y; fy < e.y + h; fy++) for (let fx = e.x; fx < e.x + w; fx++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = at(fx + dx, fy + dy);
        if (!n || n === e || n.id === e.id || n.team !== e.team || !isWallLike(n)) continue;
        if (dx + dy < 0 && shared(n)) continue;
        arms.push(fx, fy, dx, dy, pillarHalf(e), pillarHalf(n));
      }
    }
    return arms;
  }
  const wallKey = (e, arms) => (e.complete ? 1 : 0) + ':' + ageOf(e) + ':' + teamColor(e.team) + ':' + arms.join(',');
  function wallModel(e, arms){
    const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h, gate = isGateBtype(e.btype);
    const stone = e.btype === 'SWALL' || e.btype === 'SGATE', a = ageOf(e), tc = teamColor(e.team);
    const k = 1; // (full height: a site rises by its cut — constructionSite)
    const g = new THREE.Group(), body = stone ? '#cfc8b6|stone' : WOOD.L + '|stakes';
    const pw = (stone ? 9 : 7) / 32, T = pw, linkH = 14 / HPX * k; // links as thick as the pillars (drawWallLink thick = pw/2 px each side)
    // A link from this pillar's face to the neighbor's (half-widths o1, o2): a slab with a team top.
    for (let i = 0; i < arms.length; i += 6) {
      const [fx, fy, dx, dy, o1, o2] = arms.slice(i, i + 6), cx = fx + 0.5, cz = fy + 0.5;
      const a0 = o1, a1 = 1 - o2;
      const x0 = dx ? Math.min(cx + dx * a0, cx + dx * a1) : cx - T / 2, x1 = dx ? Math.max(cx + dx * a0, cx + dx * a1) : cx + T / 2;
      const z0 = dy ? Math.min(cz + dy * a0, cz + dy * a1) : cz - T / 2, z1 = dy ? Math.max(cz + dy * a0, cz + dy * a1) : cz + T / 2;
      boxAt(g, topped(body, tc), x0, z0, x1, z1, 0, linkH, 'hull'); softEdges(g, x0, z0, x1, z1, 0, linkH, dx ? 'x' : 'z');
    }
    if (!gate) {
      for (let fy = e.y; fy < e.y + h; fy++) for (let fx = e.x; fx < e.x + w; fx++) {
        const pH = 22 / HPX * k, cx = fx + 0.5, cz = fy + 0.5;
        boxAt(g, topped(body, tc), cx - pw / 2, cz - pw / 2, cx + pw / 2, cz + pw / 2, 0, pH, 'hull'); softEdges(g, cx - pw / 2, cz - pw / 2, cx + pw / 2, cz + pw / 2, 0, pH);
      }
      addHulls(g, true); // union outlines: drawn first, the parts paint over them — a run's outline can't show through the pillar it butts into
      return { obj: g };
    }
    // Gate: end pillars on the first and last tile of its line, a door between.
    const alongZ = h > w, n = Math.max(w, h), P = 14 / 32, pH = 28 / HPX * k;
    const ends = [[e.x + 0.5, e.y + 0.5], alongZ ? [e.x + 0.5, e.y + n - 0.5] : [e.x + n - 0.5, e.y + 0.5]];
    for (const [cx, cz] of ends) {
      boxAt(g, topped(stone ? '#c8c0ae|stone' : WOOD.L + '|stakes', a >= 2 && stone ? '#b0b0a4' : tc), cx - P / 2, cz - P / 2, cx + P / 2, cz + P / 2, 0, pH, 'hull'); softEdges(g, cx - P / 2, cz - P / 2, cx + P / 2, cz + P / 2, 0, pH);
      if (stone && a >= 2) for (const [mx, mz] of [[0, 0], [1, 0], [0, 1], [1, 1]])
        boxAt(g, '#e0d8c6', cx - P / 2 + mx * (P - 0.1), cz - P / 2 + mz * (P - 0.1), cx - P / 2 + mx * (P - 0.1) + 0.1, cz - P / 2 + mz * (P - 0.1) + 0.1, pH, pH + 6 / HPX, 'hull');
    }
    const [a0, a1] = ends, doorH = 16 / HPX * k, dt = 2 / 32; // the door slab: drawWallLink thick 2 each side
    const door = new THREE.Group(), span0 = (alongZ ? a0[1] : a0[0]) + P / 2 + 0.004, span1 = (alongZ ? a1[1] : a1[0]) - P / 2 - 0.004; // a hair short of the pillars: no end face lying on theirs, none inside them (an open site shows their inside)
    const dx0 = alongZ ? a0[0] - dt : span0, dx1 = alongZ ? a0[0] + dt : span1, dz0 = alongZ ? span0 : a0[1] - dt, dz1 = alongZ ? span1 : a0[1] + dt;
    boxAt(door, topped('#8b5a2b|stakes', '#a5723a'), dx0, dz0, dx1, dz1, 0, doorH, 'hull'); softEdges(door, dx0, dz0, dx1, dz1, 0, doorH, alongZ ? 'z' : 'x');
    g.add(door);
    addHulls(g, true); // union outlines: drawn first, the parts paint over them — a run's outline can't show through the pillar it butts into
    return { obj: g, door, doorOf: e.id };
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
  const HULL_MATS = new Set(); // every outline-shell material
  let ink = null, hullMat = null, hullUnionMat = null, hullWorldMat = null, edgeCache = new Map(), pyramidGeo = null;
  // Geometry made for one model (not the shared box/rod/pyramid) is freed with it.
  const own = geo => { geo.userData.own = true; return geo; };
  function dropSolid(rec){
    if (rec.trainees) for (const t of rec.trainees) dropVillager(t);
    scene.remove(rec.obj);
    rec.obj.traverse(o => {
      if (o.userData.siteOwn) [].concat(o.material).forEach(m => m.dispose());
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
      if (!o.userData.fadeOwn) { if (a >= 1) return; // nothing fading yet: keep the shared material
        o.userData.fadeHull = HULL_MATS.has(o.material);
        // Material.clone() drops onBeforeCompile — the world-mapped detail (planks, stone) would vanish
        const own = m => { const c = m.clone(); c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; c.onBeforeRender = m.onBeforeRender; return c; };
        o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material); o.userData.fadeOwn = true; }
      const k = o.userData.fadeHull ? Math.max(0, 2 * a - 1) : Math.min(1, 2 * a);
      for (const m of [].concat(o.material)) { m.transparent = k < 1; m.opacity = k; }
      if (o.userData.fadeHull) o.visible = k > 0.01;
    });
    g.visible = a > 0.01;
  }
  const disposeFaded = g => g.traverse(o => { if (o.userData.fadeOwn) [].concat(o.material).forEach(m => m.dispose()); });
  function addHulls(g, union = false){
    if (RIG_NOHULL) return;                                                   // a rig makes its own (rigTemplate)
    g.updateMatrixWorld(true);
    if (union) g.traverse(o => { if (o.isMesh) o.renderOrder = 2; });
    const meshes = [];
    g.traverse(o => { if (o.isMesh && o.userData.hullGeo) meshes.push(o); });
    const s = new THREE.Vector3(), M = new THREE.Matrix3(), Mi = new THREE.Matrix3(), wp = new THREE.Vector3(), off = new THREE.Vector3();
    for (const m of meshes) {
      const src = m.userData.hullGeo;
      M.setFromMatrix4(m.matrixWorld); Mi.copy(M).invert();
      m.getWorldScale(s).set(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
      const ht = m.userData.hullTube, scr = union || !(m.userData.hullW < HULL), hm = union ? hullUnionMat : scr ? hullMat : hullWorldMat; // a deliberately fine outline keeps its world width
      if (ht) { const th = new THREE.Mesh(own(new THREE.TubeGeometry(ht.path, segs(12), ht.r + (scr ? 0 : m.userData.hullW / s.x), segs(8), false)), hm); if (union) th.renderOrder = 1; m.add(th); continue; }
      const hg = hullGeometry(src, s, m.userData.hullW || HULL, union ? null : (i, o) => { // characters keep their outline under the feet (the ground draws first and blocks nothing)
        if (wp.fromBufferAttribute(src.attributes.position, i).applyMatrix4(m.matrixWorld).y >= 0.004) return;
        off.copy(o).applyMatrix3(M); // on the ground: no downward growth
        if (off.y < 0) { off.y = 0; o.copy(off.applyMatrix3(Mi)); }
      }, scr);
      if (!hg) continue;
      const h = new THREE.Mesh(own(hg), hm);
      if (union) h.renderOrder = 1;
      m.add(h);
    }
  }
  // The hull of src seen at scale s (its own units; null if too thin to show):
  // every vertex out along its averaged face normal so each face moves HW.
  // ground(i, offset) may trim a vertex's offset in place.
  function hullGeometry(src, s, HW, ground, screen = false){ // screen: the shell stays on the part, its push direction in the normals (screenHull)
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
    // Two limits keep hard-edged parts from outlining heavier than round ones:
    // no mitre on a cylinder (its rim would push out ~1.4× as far), and never
    // further out than 40% of the part's own size along each axis (a thin blade,
    // disc or plank gets a thin edge, not a black slab when seen edge-on).
    const mitre = src.type !== 'CylinderGeometry', cap = [0.4 * d.x * s.x, 0.4 * d.y * s.y, 0.4 * d.z * s.z];
    const out = new Float32Array(pos.count * 3), nOut = screen ? new Float32Array(pos.count * 3) : null;
    for (let i = 0; i < pos.count; i++) {
      const e = acc.get(key(i));
      o.set(0, 0, 0);
      if (e && e.sum.lengthSq() > 1e-9 && screen) { const dir = e.sum.clone().normalize(); // the push direction as a normal (scale's inverse-transpose), after any ground trim
        o.set(dir.x * HW / s.x, dir.y * HW / s.y, dir.z * HW / s.z); if (ground) ground(i, o);
        const k = 1 / HW; nOut[3 * i] = o.x * s.x * s.x * k; nOut[3 * i + 1] = o.y * s.y * s.y * k; nOut[3 * i + 2] = o.z * s.z * s.z * k; o.set(0, 0, 0); } // (per unit width: the shader normalizes)
      else if (e && e.sum.lengthSq() > 1e-9) {
        const dir = e.sum.clone().normalize();
        const L = mitre ? HW / Math.max(0.33, Math.min(...e.ns.map(q => q.dot(dir)))) : HW;
        const w = [dir.x * L, dir.y * L, dir.z * L].map((v, k) => Math.max(-cap[k], Math.min(cap[k], v)));
        o.set(w[0] / s.x, w[1] / s.y, w[2] / s.z);
        if (ground) ground(i, o);
      }
      out[3 * i] = pos.getX(i) + o.x; out[3 * i + 1] = pos.getY(i) + o.y; out[3 * i + 2] = pos.getZ(i) + o.z;
    }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(out, 3));
    if (nOut) hg.setAttribute('normal', new THREE.BufferAttribute(nOut, 3));
    if (idx) hg.setIndex(idx);
    return hg;
  }

  // Axis-aligned box from footprint corners (world x/z) and heights.
  // col: one color, or six per face in BoxGeometry order [+x, -x, +y, -y, +z, -z]
  // — team trim is a face's color, never an extra plate.
  const faceMats = col => Array.isArray(col) ? col.map(c => mat(c)) : mat(col);
  const topped = (body, top) => [body, body, top, body, body, body];
  // inkIt: true = edge lines + outline hull; false = neither; 'hull' = the outline hull only (parts that
  // butt against each other — their edge lines would show through the face they meet)
  function boxAt(g, col, x0, z0, x1, z1, y0, y1, inkIt = true){
    const m = inkIt === true ? inked(unitBox, faceMats(col), 0, 0, 0, 1, 1, 1) : new THREE.Mesh(unitBox, faceMats(col));
    if (inkIt === 'hull') m.userData.hullGeo = unitBox;
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
  const V3 = (a) => new THREE.Vector3(...a);
  // What an opening looks into: the wall's own colour inside, in the walls' shade (SITE_SHADE — as a site's inside), not black.
  const INTERIOR_MATS = new Set();
  function interiorMat(col){
    const [c, detail] = col.split('|'), n = parseInt(c.slice(1), 16), ch = v => Math.round(v * SITE_SHADE).toString(16).padStart(2, '0'); // (on the screen colour, as the site's shade)
    const m = mat('#' + ch(n >> 16) + ch((n >> 8) & 255) + ch(n & 255) + (detail ? '|' + detail : ''));
    INTERIOR_MATS.add(m); return m; }
  function solidGeo(faces, T, nMats, pierce, rims = [], level = false){ // level: openings tunnel straight in (a site's slabs: thickGeo)
    const buckets = Array.from({ length: nMats + 1 }, () => []);
    const tri = (b, p0, p1, p2, want, smooth) => { // flat-shaded unless smooth(p) gives the vertex normal
      const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0));
      if (n.lengthSq() < 1e-12) return;                                   // (a sliver from the triangulation: no facing, so no outline to grow)
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
        const nIn = level ? new THREE.Vector3(n.x, 0, n.z).normalize() : n, out3 = h.map(to3), in3 = out3.map(p => p.clone().addScaledVector(nIn, -T)), mid = out3[0].clone().add(out3[2]).multiplyScalar(0.5);
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
  function solid(g, cols, faces, { T = 0.06, thresh, depth = T } = {}){ // depth: the wall's thickness (a site's cut shows it)
    cols = [].concat(cols);
    const rims = [], m = new THREE.Mesh(solidGeo(faces, T, cols.length, true, rims), cols.map(c => mat(c)).concat(interiorMat(cols[0])));
    const plain = solidGeo(faces, T, cols.length, false);
    m.add(new THREE.LineSegments(own(new THREE.EdgesGeometry(plain, thresh)), ink));
    if (rims.length) { const rl = new THREE.LineSegments(own(new THREE.BufferGeometry().setFromPoints(rims)), ink); rl.userData.rims = true; m.add(rl); }
    m.userData.hullGeo = plain; m.userData.T = depth;
    m.userData.slab = jag => thickGeo(faces, depth, cols.length, jag);                    // (a site's walls: real slabs)
    m.userData.slabRims = () => { const r = []; solidGeo(faces, depth, cols.length, true, r, true); return r; }; // (their openings' frames, back edge on the inner face)
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
  // open: a construction site's — no sloped top (the roof closes it as it goes on)
  function houseFaces(x0, z0, x1, z1, wallH, rise, alongX = true, open = false){
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
    if (open) { delete f.s0; delete f.s1; }
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
  // A camp's little team pennant: it swings on its pole (animateModels, the 'pennant' pivot); damaged, it comes down
  // with the big flags (buildingDamage: 'flagPole').
  function pennant(g, x, z, y0, col){
    pole(g, '#1c1208', [x, y0, z], [x, y0 + 8 / HPX, z], 0.012, 'line').name = 'flagPole';
    const t = own(new THREE.BufferGeometry());
    t.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 7 / 32, -2 / HPX, 0, 0, -4 / HPX, 0], 3));
    t.computeVertexNormals();
    const pv = new THREE.Group(); pv.name = 'pennant'; pv.position.set(x, y0 + 8 / HPX, z); pv.userData.phase = (x * 3.7 + z * 5.3) % 6.28;
    pv.add(inked(t, mat(col, true), 0, 0, 0, 1, 1, 1)); g.add(pv);
  }
  // A stone boulder as the map's deposits draw them (initFeatures 'stone'): the same squat spun profile, flat-shaded, in
  // their greys; radius r, height h.
  let _oreGeo = null; const _oreMat = new Map();
  const rock = (g, col, x, z, r, h = r * 1.7) => {
    _oreGeo = _oreGeo || (() => { const q = new THREE.LatheGeometry([[0, 0], [0.95, 0], [1.02, 0.35], [0.82, 0.74], [0.4, 0.98], [0, 1]].map(([a, b]) => new THREE.Vector2(a, b)), 7).toNonIndexed(); q.computeVertexNormals(); return q; })();
    let m0 = _oreMat.get(col); if (!m0) _oreMat.set(col, m0 = new THREE.MeshLambertMaterial({ color: col, flatShading: true }));
    const m = new THREE.Mesh(_oreGeo, m0); m.position.set(x, 0, z); m.scale.set(r, h, r); m.rotation.y = x * 7.1 + z * 3.3;
    m.userData.hullGeo = _oreGeo; g.add(m); return m;                                 // (an outline, no inner edge lines: as the deposits)
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
  // loop() as the art's travelling wave (aTick; viewer-only). s: the building's art scale (the TC's k), cloth included.
  function flag(g, x, z, y0, h, col, s = 1){
    const poleH = h != null ? h : 22 / HPX;
    pole(g, '#1c1208', [x, y0, z], [x, y0 + poleH, z], 0.012, 'line').name = 'flagPole'; // thin, as the art's 1.5px stroke
    const knob = inked(own(new THREE.SphereGeometry(0.03 * s, 8, 6)), mat('#1c1208'), x, y0 + poleH + 0.02 * s, z, 1, 1, 1, 30); knob.name = 'flagPole'; g.add(knob);
    const L = 17 * s / PX, Hf = 8.5 * s / HPX, geo = own(new THREE.PlaneGeometry(L, Hf, 8, 1).translate(L / 2, -Hf / 2, 0));
    geo.userData.rest = Float32Array.from(geo.attributes.position.array);
    const f = new THREE.Mesh(geo, mat(col, true));
    f.position.set(x, y0 + poleH - 0.01, z); f.rotation.y = -3 * Math.PI / 4;
    f.name = 'flag'; f.userData.len = L; f.userData.s = s; g.add(f);
    // Its ink border shares the cloth's vertices, so it waves with it.
    const nx = 9, rim = [];
    for (let i = 0; i < nx - 1; i++) rim.push(i, i + 1, nx + i, nx + i + 1);
    rim.push(0, nx, nx - 1, 2 * nx - 1);
    const edge = own(new THREE.BufferGeometry()); edge.setAttribute('position', geo.attributes.position); edge.setIndex(rim);
    f.add(new THREE.LineSegments(edge, ink));
  }


  const ageOf = e => (teamAge && isPlayerTeam(e.team)) ? teamAge[e.team] : 0;

  // A part set in place whole on a construction site (a roof, a cap, an awning), not built up course by course.
  const piece = g => { const p = new THREE.Group(); p.userData.piece = true; g.add(p); return p; };
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
      const standing = farmStandingLive(e), stalks = [], heads = [], stubs = [], prev = farmPrev.get(e.id), live = farmLive.get(e.id); farmPrev.set(e.id, standing);
      const up = new THREE.Vector3(0, 1, 0);
      FARM_CROP_ROWS.forEach((t, ri) => {
        for (let i = 0; i < FARM_CROP_COLS; i++) {
          const n = ri * FARM_CROP_COLS + i;
          const x = e.x + w * farmSheafU(ri, i) + (((n * 5 + fseed) % 5) - 2) * 0.5 * px, z = e.y + h * t + (((n * 11 + fseed) % 3) - 1) * px;
          if (!standing[n]) { stubs.push([x, 0.03, z, 0.018, 0.06, 0.018]); if (prev && prev[n]) cutSheaf(x, z, live && live.away.has(n) ? live.away.get(n) : n * 2.39996); continue; } // just cut: it falls away from the blade
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
      const thick = 0.035, rise = roofH - thick, f = houseFaces(x0, z0, x1, z1, wallH, rise, true, !e.complete || e.openTop);
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
      roofOn(piece(g), tc + '|shingles', box, wallH, rise, thick, true, 0.05, 0.1, 0.13);
      if (a >= 1) { // chimney: 30% along the ridge, 30% down the +z slope, 16px proud
        const cx = x0 + 0.3, cz = z0 + 0.665, top = wallH + 0.67 * roofH + 16 / HPX, ch = piece(g);
        boxAt(ch, '#9a4a34', cx - 0.08, cz - 0.08, cx + 0.08, cz + 0.08, wallH, top);
        boxAt(ch, '#8d857a', cx - 0.11, cz - 0.11, cx + 0.11, cz + 0.11, top, top + 3 / HPX);
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
      for (const f of FACES) inner[f].out = inner[f].out.map(v => -v);     // the parapet's inner faces look into the recess
      const H0 = keepH, rim = [
        [[x, H0, z], [x + mid, H0, z], [i1, H0, j0], [i0, H0, j0]], [[x + mid, H0, z], [x + mid, H0, z + mid], [i1, H0, j1], [i1, H0, j0]],
        [[x + mid, H0, z + mid], [x, H0, z + mid], [i0, H0, j1], [i1, H0, j1]], [[x, H0, z + mid], [x, H0, z], [i0, H0, j0], [i0, H0, j1]],
      ].map(loop => ({ loop, out: [0, 1, 0] }));
      solid(g, [kL, kT], [...FACES.map(f => outer[f]), outer.bottom, ...rim, ...FACES.map(f => inner[f]), { ...inner.bottom, out: [0, 1, 0], mat: 1 }], { T: 0.08, depth: rimW * 0.97 }); // (walls nearly as thick as the parapet: inside, straight up to the rim; the parapet's back stays a hair inside the outer face, not on it)
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
      leanTo(piece(g), fascia(WOOD.plankR + '|planks'), x + mid, z, x + W, z + mid, hK, hO, true, fas);   // boards run down each slope
      leanTo(piece(g), fascia(WOOD.plankL + '|planksR'), x, z + mid, x + mid, z + W, hK, hO, false, fas);
      // Posts under the outer corners, up to the slab's underside (the keep carries the inner edge).
      const run = W - mid, under = d => hK + (hO - hK) * d / run - fas * Math.hypot(run, hK - hO) / run;
      for (const [px, pz] of [[x + W - 0.12, z + 0.12], [x + W - 0.12, z + mid - 0.12]]) post(g, px, pz, under(px - x - mid), WOOD.post, 0.06);
      for (const [px, pz] of [[x + 0.12, z + W - 0.12], [x + mid - 0.12, z + W - 0.12]]) post(g, px, pz, under(pz - z - mid), WOOD.post, 0.06);
      // The pole stands on the keep floor, its flag 42px up (28px above the rim at Castle) (×k).
      if (e.complete) flag(g, x + mid / 2, z + mid / 2, F, a >= 2 ? keepH + 28 * k / HPX - F : 42 * k / HPX, tc, k);
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
      const f = houseFaces(...hall, wallH, roofH, false, !e.complete || e.openTop);
      f.z1.holes.push(hole('z1', hall, 0.5, SILL, 0.42, wallH * 0.7));                 // door, lit gable end
      for (const u of [0.18, 0.38, 0.62, 0.82]) f.x1.holes.push(hole('x1', hall, u, wallH * 0.46, 0.2, 0.19));
      solid(g, wall + '|plaster', Object.values(f));
      roofOn(piece(g), tc + '|shingles', hall, wallH, roofH, 0.04, false, 0.06, 0.05, 0.05);
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
      // The yard's gear (dummies, target, rack, hay, the horse) and the flags arrive with the finished building.
      if (e.complete) for (const [A, B] of a === 0 ? [[-12, 32], [12, 32]] : [[0, 30]]) { // straw dummy on a post: oval body, head, arm bar through the shoulders
        const p = BP(A, B), bodyY = 0.37, bodyH = 0.126, headY = bodyY + bodyH + 0.06;
        pole(g, WOOD.beam, [p.x, 0, p.z], [p.x, headY, p.z], 0.02);
        { const q = BP(A, B + 10), dx = q.x - p.x, dz = q.z - p.z, L = Math.hypot(dx, dz) || 1; // a trainee a spear's reach out toward the fence, stabbing it
          (g.userData.trainees = g.userData.trainees || []).push({ x: p.x + dx / L * 0.66, z: p.z + dz / L * 0.66, yaw: -Math.atan2(-dz, -dx), seed: (A + B) * 0.13 }); }
        pole(g, WOOD.beam, [p.x, bodyY + bodyH * 0.6, p.z - 0.17], [p.x, bodyY + bodyH * 0.6, p.z + 0.17], 0.02);
        ball(g, '#c8a878', p.x, bodyY, p.z, 0.09, 1.4);
        ball(g, '#e2c046', p.x, headY, p.z, 0.07);
      }
      if (a >= 1 && e.complete) {
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
        horse(g, BP(14, 33), a >= 2 ? '#e9e6de' : '#8b5a2b', a >= 2 ? '#9a948a' : '#3f2810', e.id * 0.37 % 1, tc);
      }
      const fp = BP(30, 0); // on the far gable's ridge end
      if (e.complete) flag(g, fp.x, fp.z + 0.02, wallH + roofH, 22 * s / HPX, tc);
    },
    // Hut with a door in its right face and a team pennant; in front, a log
    // pile (three logs along SE) and a chopping stump (drawBuilding LCAMP).
    // Laid out on the tile: the art's screen offsets overlap in plan.
    LCAMP(g, e){
      const hut = campHut(g, e, '#b89868|planks', '#8a6a48|shingles');
      if (!e.complete) return;
      // Everything inside the tile, in front of the hut (z > 0.625), the pile lower than its walls.
      const rr = 0.075, lz = e.y + 0.81;
      for (const dz of [-rr, rr]) log(g, TREE_BARK, e.x + 0.29, lz + dz, 0.5, rr, true, rr, TREE_CUT);
      log(g, TREE_BARK, e.x + 0.29, lz, 0.5, rr, true, rr * (1 + Math.sqrt(3)), TREE_CUT); // resting in the two's groove
      round(g, TREE_BARK, e.x + 0.8, e.y + 0.82, 0.1, 0.1, 0, 9 / HPX, 12, true, TREE_CUT); // stump with a pale cut top
      return hut;
    },
    // Same hut in dark timber; in front, an ore cart heaped with gold nuggets
    // and a pair of boulders (drawBuilding MCAMP), laid out clear of each other.
    MCAMP(g, e){
      campHut(g, e, '#7a6a55|planks', '#55483a|shingles');                        // (the 2D art's dark timber mine shed)
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
      for (const [x, z, r, col] of [[0.8, 0.8, 0.15, '#9d9d9d'], [0.6, 0.96, 0.07, '#8c8c8c']]) rock(g, col, e.x + x, e.y + z, r);
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
      piece(g).add(inked(cap, mat(WOOD.L + '|shingles'), c.x, H, c.y, 1, 1, 1, 30));
      if (!e.complete) return;
      // Sails face the iso front (+x,+z); the 'sails' group turns in loop().
      // The hub stands out on a windshaft far enough that a sail pointing
      // straight down clears the tapered wall; moving it out along the view
      // diagonal is matched by a rise (tan 30°), so it holds the art's spot.
      const ap = Math.cos(Math.PI / seg), A = r0 * ap, B = (r0 - r1) / H * ap, K = Math.tan(Math.PI / 6);
      const D0 = r1 + 0.1, y0 = H + 0.06, D = Math.max(D0, (A - B * (y0 - D0 * K - 1) + 0.05) / (1 + B * K)), hy = y0 + (D - D0) * K;
      const shaft = own(new THREE.CylinderGeometry(0.04, 0.04, D - r1 * 0.5, 8).rotateX(Math.PI / 2).rotateY(Math.PI / 4));
      const sh = inked(shaft, mat(WOOD.beam), c.x + (D + r1 * 0.5) / 2 * Math.SQRT1_2, hy, c.y + (D + r1 * 0.5) / 2 * Math.SQRT1_2, 1, 1, 1, 30);
      sh.name = 'millShaft'; g.add(sh);                                          // (goes with the sails when it's damaged)
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
      solid(g, col, Object.values(f));
      if (!isP && a >= 2) {
        for (const [mx, mz] of [[0, 0], [1, 0], [0, 1], [1, 1]])
          boxAt(g, '#e0d8c6', box[0] + mx * 0.32, box[1] + mz * 0.32, box[0] + mx * 0.32 + 0.12, box[1] + mz * 0.32 + 0.12, H, H + 7 / HPX);
        if (e.complete) flag(g, x + 0.5, z + 0.5, H, null, tc);
      } else {
        const c0 = [x + 0.31, z + 0.31, x + 0.69, z + 0.69], cy = H + 4 / HPX;
        boxAt(g, col, ...c0, H, cy);
        const rise = 14 / HPX; // 'peaked': roofH 8 + bhh 6 above the cap slab
        pyramid(piece(g), tc + '|shingles', ...c0, cy, rise);
        if (e.complete) flag(g, x + 0.5, z + 0.5, cy + rise, null, tc);
      }
    },
    // Paved plaza; on three corner tiles a stall — four posts
    // under a flat canvas canopy striped in team color with a scalloped team
    // valance — over its goods (grain sacks, gold, stone); a crate and a log
    // on the front tile (drawBuilding MARKET, drawMarketPlaza).
    MARKET(g, e){
      const x = e.x, z = e.y, W = e.w || 3, tc = teamColor(e.team), H = 20 / HPX;
      patch(g, '#b7b2a6|slabs', x, z, x + W, z + W);
      const r = 21 / 32 / 2, gd = new THREE.Group(); gd.name = 'goods'; g.add(gd); // (the goods: gone with the awnings when it's damaged)
      for (const [tx, tz, good] of [[0, 0, 'sacks'], [0, W - 1, 'gold'], [W - 1, 0, 'stone']]) {
        const cx = x + tx + 0.5, cz = z + tz + 0.5;
        for (const [px, pz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) post(g, cx + px, cz + pz, H - 0.025, WOOD.post, 0.028); // under the canopy, outline included
        awning(piece(g), cx, cz, r + 0.02, H, '#efe7d2', tc);
        if (!e.complete) continue;                                                            // (the goods come with the finished market)
        // drawGood: plump grain sacks / a pyramid of gold bars / squared stone blocks
        if (good === 'sacks') for (const [dx, dz] of [[-0.14, 0.03], [0.14, -0.03]]) ball(gd, '#c9a86a', cx + dx, 0.12, cz + dz, 0.13, 0.92);
        if (good === 'gold') for (const [i, layer] of [[0, 0], [1, 0], [2, 0], [0.5, 1], [1.5, 1], [1, 2]]) {
          const bx = cx - 0.2 + i * 0.14, y = layer * 0.075;
          boxAt(gd, '#e8b90f', bx - 0.065, cz - 0.12, bx + 0.065, cz + 0.12, y, y + 0.075);
        }
        if (good === 'stone') for (const [dx, dz, sz, y] of [[-0.13, -0.05, 0.11, 0], [0.13, 0.05, 0.11, 0], [0, 0, 0.1, 0.2]]) // two blocks, one across them
          boxAt(gd, '#9a9a9a', cx + dx - sz, cz + dz - sz, cx + dx + sz, cz + dz + sz, y, y + 0.2);
      }
      if (!e.complete) return;
      const cr = { x: x + 2.47, z: z + 2.22 }, lg = { x: x + 2.52, z: z + 2.64 }; // on the front tile, clear of each other
      boxAt(gd, WOOD.plankL + '|planks', cr.x - 0.2, cr.z - 0.2, cr.x + 0.2, cr.z + 0.2, 0, 0.36);
      for (const [dz, y] of [[-0.1, 0.09], [0.1, 0.09], [0, 0.09 + Math.sqrt(0.18 * 0.18 - 0.1 * 0.1)]]) log(gd, TREE_BARK, lg.x, lg.z + dz, 0.55, 0.09, true, y, TREE_CUT);
    },
  };
  MODELS.PTOWER = MODELS.TOWER;

  // A horse in side profile along local x (barracks yard; drawYardHorse): a
  // rounded barrel on four tapered legs and dark hooves, an arched neck and a
  // head that narrows to the muzzle, ears, a mane and a hanging tail. The neck
  // (with the head) and the tail are pivot groups: animateModels lowers the
  // head to graze now and then and swishes the tail. Turned side-on to the iso
  // view (x → world (+x,-z)) and scaled to the art's ~0.7-tile horse.
  // The yard's horse is the cavalry's horse (horseKit), grazing (animateModels drives its neck, head and tail).
  function horse(g, p, coat, mane, seed, tc){
    const hg = new THREE.Group(); hg.position.set(p.x, 0, p.z); hg.rotation.y = Math.PI / 4; g.add(hg);
    horseKit(hg, coat, mane, coat === '#e9e6de' ? '#b3ada1' : '#6e4520', tc, coat === '#e9e6de' ? '#b8b2a6' : undefined);
    hg.userData.horseSeed = seed;
  }

  // ---- Resources: trees, gold, stone and berry bushes, in 3D ----
  // One InstancedMesh per part (its outline hull shares the instance
  // matrices), refilled from the map every STATIC_MS. Trees sway (the art's
  // wind: a per-tree sway plus rolling gusts, bent in the vertex shader),
  // fall when cut, and gold glints twinkle — viewer-only, on aTick.
  const FEAT_CAP = (2 * (RANGE + 4)) ** 2, SCREEN_X = [Math.SQRT1_2, -Math.SQRT1_2]; // iso screen-x in world
  // The art's tree (24px trunk, 12px crown) stands only villager-high in true 3D;
  // the trunk is lengthened so the canopy clears a head, the crown grown to match.
  const ART_TREE_H = 24 / HPX, TRUNK_K = 1.8, CROWN_K = 1.5;
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
    const scr = !(w < HULL); if (!scr) hullMaterial = hullWorldMat;                  // a deliberately fine outline (arrows, berries) keeps its world width
    const hg = s && hullGeometry(geo, s, w, (i, o) => { if (geo.attributes.position.getY(i) < 1e-4 && o.y < 0) o.y = 0; }, scr); // never below its base
    if (hg) { hull = new THREE.InstancedMesh(hg, hullMaterial, FEAT_CAP); hull.instanceMatrix = mesh.instanceMatrix; hull.count = 0; hull.frustumCulled = false; scene.add(hull); }
    mesh.userData.feat = name; feat[name] = { mesh, hull, n: 0, tiles: new Int32Array(FEAT_CAP) };
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
    const leaf = swaying(new THREE.MeshLambertMaterial({ color: '#ffffff' }), true), hullSway = screenHull(swaying(hullWorldMat.clone()), HULL, 1.5), hullCrown = screenHull(swaying(hullWorldMat.clone(), true), HULL, 1.5);
    HULL_MATS.add(hullSway).add(hullCrown);
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
    part('trunkF', trunk, new THREE.MeshLambertMaterial({ color: TREE_BARK }), one, HULL); // felled: no sway
    part('crownF', crown, new THREE.MeshLambertMaterial({ color: '#4db536' }), one, HULL);
    part('stump', new THREE.CylinderGeometry(TRUNK_R * 1.1, TRUNK_R * 1.5, STUMP_H, 12).translate(0, STUMP_H / 2, 0),
      [mat(TREE_BARK), mat(TREE_CUT), mat(TREE_BARK)], one, HULL); // drawStump: a pale cut top
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
    // Arrows (drawProjectiles): a pale 20px shaft behind a steel head, built
    // along +y with the tip at the origin; fletched archer arrows add two
    // crossed team-color vanes at the tail.
    const L = 20 / PX, thin = new THREE.Vector3(1, 1, 1); // (bigger than the 2D art's 14px: thinner reads as nothing at a 3D distance)
    part('shaft', new THREE.CylinderGeometry(0.017, 0.017, L, 6).translate(0, -L / 2, 0), new THREE.MeshLambertMaterial({ color: '#f5f2e9' }), thin, 0.008);
    part('head', new THREE.ConeGeometry(0.035, 0.1, 6).translate(0, -0.01, 0), new THREE.MeshLambertMaterial({ color: '#dde3ea' }), thin, 0.008);
    const vane = new THREE.BufferGeometry();
    vane.setAttribute('position', new THREE.Float32BufferAttribute([0, -L + 0.11, 0, 0.04, -L + 0.02, 0, 0, -L + 0.02, 0, 0, -L + 0.11, 0, 0, -L + 0.02, 0.04, 0, -L + 0.02, 0,
      0, -L + 0.11, 0, -0.04, -L + 0.02, 0, 0, -L + 0.02, 0, 0, -L + 0.11, 0, 0, -L + 0.02, -0.04, 0, -L + 0.02, 0], 3));
    vane.computeVertexNormals();
    part('vane', vane, new THREE.MeshLambertMaterial({ color: '#ffffff', side: THREE.DoubleSide }), null);
  }
  let putTile = -1; // the map tile (y·MAP + x) the next put() belongs to: a click on the instance picks that tile
  let _m, _q, _p, _s, _c, _c2, _e, _e2, FALL_AXIS; // scratch, made once THREE has loaded (initFeatures)
  function put(name, x, y, z, sx, sy, sz, rotY = 0, color){
    const f = feat[name];
    if (f.n >= FEAT_CAP) return;
    f.mesh.setMatrixAt(f.n, _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, rotY, 0)), _s.set(sx, sy, sz)));
    if (color) f.mesh.setColorAt(f.n, _c.set(color));
    f.tiles[f.n++] = putTile;
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
      const wx = x + 0.5, wz = y + 0.5; putTile = y * MAP + x;
      if (t.t === TERRAIN.FOREST) {
        const k = 1.05 * (0.8 + ((x * 17 + y * 23) % 5) * 0.08); // the art's per-tree size noise
        const shade = (r, x0 = wx, z0 = wz) => put('shadow', x0, 0.006, z0, 2 * r, 1, 2 * r);
        if (t.res > 60) { // each tree its own: crown shape, turn, proportions, shade, a nudge off the grid
          const h = n => tileHash(x, y, n);
          const tx = wx + (h(1) - 0.5) * 0.2, tz = wz + (h(2) - 0.5) * 0.2, rot = h(3) * 6.283, kw = k * (0.9 + h(4) * 0.2), kh = k * (0.9 + h(5) * 0.22);
          shade(0.36 * CROWN_K * kw, tx, tz);
          put('trunk', tx, 0, tz, kw, kh, kw, rot, _c2.set(TREE_BARK).multiplyScalar(0.9 + h(6) * 0.2).getHex());
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
    putTile = -1;
    for (const k in feat) { const f = feat[k]; f.mesh.count = f.n; if (f.hull) f.hull.count = f.n; f.mesh.instanceMatrix.needsUpdate = true; if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true; }
  }
  // Villagers chopping near the camera drive the trees they hit: the blow lands
  // when their 2D work swing does (render-units: phRaw = aTick·0.055 + id·0.37,
  // the strike ending as it wraps), so the shake and chips match the axe.
  const lastPh = new Map(), chips = [];
  function updateTreeHits(){
    const H = treeHits.value; let n = 0;
    for (const e of entities) {
      if (n >= 8 || e.type !== 'unit' || e.utype !== 'villager' || e.task !== 'chop' || e.path.length || !(e.gatherX >= 0) || hasUpgrade(e.team, 'bow_saw')) continue;
      if ((e.x - camAt.x) ** 2 + (e.y - camAt.y) ** 2 > 400 || !atGatherTile(e, e.gatherX, e.gatherY)) continue;
      const ph = workPhase(e, 'chop'), tx = e.gatherX + 0.5, tz = e.gatherY + 0.5;          // the 3D chop's own cycle: the blow lands as it wraps
      const ang = Math.atan2(tz - (e.y + 0.5), tx - (e.x + 0.5));
      H[n++].set(tx, tz, ph / VIL_RATE.chop / 30, ang);                                // seconds since the blow
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
    wind.value = aTick;
    updateTreeHits(); updateChips(dt); updateFlyers(dt); updateSheaves(dt);
    // A cut tree pivots on its stump's top toward screen-right, coming to rest where its crown meets the ground.
    // As 2D, it lies mostly on its own square: a little smaller, and slid back off the stump as it goes down so the
    // crown ends near the square's edge rather than across the next tile.
    const T = feat.trunkF, C = feat.crownF, FIT = 0.85;
    const dir = _e2 = _e2 || new THREE.Vector3(0, 1, 0).applyAxisAngle(FALL_AXIS, -Math.PI / 2); // the way it falls, on the ground
    T.n = C.n = 0;
    for (const f of fallers) {
      const u = Math.min(1, (tick - treeFellTicks.get(f.key)) / T30(40)), sc = f.k * (1 + (FIT - 1) * u);
      const rest = Math.acos(Math.min(1, Math.max(0, (CROWN_R * sc - STUMP_H * f.k) / (TREE_H * sc))));
      const back = Math.max(0, (TREE_H + CROWN_R) * f.k * FIT - 1.05) * u * u;                  // slides with the fall
      _m.compose(_p.set(f.wx - dir.x * back, STUMP_H * f.k, f.wz - dir.z * back), _q.setFromAxisAngle(FALL_AXIS, -rest * u * u), _s.set(sc, sc, sc)); // accelerating, like a real fall
      T.mesh.setMatrixAt(T.n++, _m); C.mesh.setMatrixAt(C.n++, _m);
    }
    for (const f of [T, C]) { f.mesh.count = f.n; f.hull.count = f.n; f.mesh.instanceMatrix.needsUpdate = true; }
    // Glints face the camera and twinkle: each swells and fades on its own phase.
    const G = feat.glint, face = _q.setFromAxisAngle(_p.set(0, 1, 0), Math.atan2(-Math.cos(yaw), -Math.sin(yaw)));
    G.n = 0;
    for (const g of glints) {
      const tw = Math.max(0, Math.sin(aTick * 0.05 + g.phase)) ** 3;
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
  // The angle an arrow leaves the bow at: the flight below climbs (eH − sH + π·A)/HPX over its D-tile run, A = 7·D px —
  // the same for every shot but for the small launch-to-impact drop (taken at the archer's range, 4 tiles).
  const ARROW_LAUNCH = Math.atan2((8 - 12 + Math.PI * 7 * 4) / HPX, 4);
  let arrowTick = -1, arrowT0 = 0, _d;
  // Where each arrow is drawn from (viewer-side, kept per projectile): a building's, the point of its footprint nearest
  // the target; a unit's, the unit.
  const arrowStart = new WeakMap();
  function arrowFrom(p){
    let S = arrowStart.get(p);
    if (!S) { const b = entitiesById.get(p.attackerId);
      S = b && b.type === 'building' ? [Math.max(b.x - 0.5, Math.min(b.x + b.w - 0.5, p.tx)), Math.max(b.y - 0.5, Math.min(b.y + b.h - 0.5, p.ty))] : [p.startX, p.startY];
      arrowStart.set(p, S); }
    return S;
  }
  function updateArrows(now){
    if (tick !== arrowTick) { arrowTick = tick; arrowT0 = now; }
    const ahead = Math.min(1, (now - arrowT0) / (1000 / TPS)) * PROJECTILE_TILES_PER_TICK;
    const S = feat.shaft, Hd = feat.head, V = feat.vane, dir = _d = _d || new THREE.Vector3();
    S.n = Hd.n = V.n = 0;
    for (const p of projectiles) {
      const gx = Math.round(p.x), gy = Math.round(p.y);
      if (!Number.isFinite(gx) || !Number.isFinite(gy) || !fog[gy] || fog[gy][gx] !== 2 || S.n >= FEAT_CAP) continue;
      const rx = p.tx - p.x, ry = p.ty - p.y, left = Math.hypot(rx, ry), step = Math.min(ahead, left);
      const ax_ = p.x + (left > 1e-6 ? rx / left * step : 0), ay_ = p.y + (left > 1e-6 ? ry / left * step : 0);
      const D = p.totalDist, prog = D > 0.1 ? Math.max(0, Math.min(1, 1 - Math.hypot(ax_ - p.tx, ay_ - p.ty) / D)) : 1;
      // drawn from where it's loosed: a building's arrow leaves its EDGE facing the target (the sim flies it from the
      // footprint's centre — out of the middle of a TC roof); same progress, same landing
      const from = arrowFrom(p), x = from[0] + (p.tx - from[0]) * prog, y = from[1] + (p.ty - from[1]) * prog;
      const sH = p.startH || 12, eH = 8, A = 35 * (D / 5);
      const h = (sH + (eH - sH) * prog + Math.sin(prog * Math.PI) * A) / HPX;
      // Flight tangent: ground run over the whole flight, and d(height)/d(progress).
      const gdx = p.tx - from[0], gdy = p.ty - from[1];
      dir.set(gdx, ((eH - sH) + Math.cos(prog * Math.PI) * Math.PI * A) / HPX, gdy).normalize();
      _m.compose(_p.set(x + 0.5, h, y + 0.5), _q.setFromUnitVectors(_s.set(0, 1, 0), dir), _s.set(1, 1, 1));
      S.mesh.setMatrixAt(S.n++, _m); Hd.mesh.setMatrixAt(Hd.n++, _m);
      const a = p.attackerSnap; // bare shafts until the archer's team has Fletching (tower/TC bolts fly bare)
      if (a && a.utype === 'archer' && hasUpgrade(a.team, 'fletching')) { V.mesh.setMatrixAt(V.n, _m); V.mesh.setColorAt(V.n++, _c.set(teamColorLight(a.team))); }
    }
    // stuck arrows (stickArrow, js/core.js): the tip a little into what it hit, the shaft up and back along the flight;
    // on a unit they ride its drawn spot; fading, they sink and shrink away
    tendStuckArrows();
    for (const a of stuckArrows) {
      if (a.hidden || S.n >= FEAT_CAP) continue;
      const gx = Math.round(a.x), gy = Math.round(a.y), f = fog[gy] && fog[gy][gx];
      if (f === 2) a.seen = true;
      if (!f || (f === 1 && !a.seen)) continue;
      const hv = a.hostId != null ? villagers.get(a.hostId) || animals.get(a.hostId) : null;
      const x = hv ? hv.x + a.ox : a.x + 0.5, z = hv ? hv.z + a.oy : a.y + 0.5, k = a.alpha;
      const c = Math.cos(a.tilt); dir.set(a.dx * c, -Math.sin(a.tilt), a.dy * c);
      _m.compose(_p.set(x + dir.x * 0.03, a.h / HPX - (1 - k) * 0.12 + dir.y * 0.03, z + dir.z * 0.03), _q.setFromUnitVectors(_s.set(0, 1, 0), dir), _s.set(k, k, k));
      S.mesh.setMatrixAt(S.n++, _m);
      if (a.fl != null) { V.mesh.setMatrixAt(V.n, _m); V.mesh.setColorAt(V.n++, _c.set(teamColorLight(a.fl))); }
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
  const blobGeos = new Map();
  function blob(parent, col, x, y, z, rx, ry = rx, rz = rx){ // an outlined ellipsoid
    const gk = segs(12) * 100 + segs(9); let geo = blobGeos.get(gk);                 // one shared unit sphere per resolution (never disposed)
    if (!geo) blobGeos.set(gk, geo = new THREE.SphereGeometry(1, segs(12), segs(9)));
    const m = new THREE.Mesh(geo, typeof col === 'string' ? mat(col) : col);          // col: a colour, or a material (armor)
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
    // the fringe of wool on its head, in its owner's colour (white: gaia, nobody's yet) — 'band' (sheepBones plucks it with the fleece)
    blob(neck, tc === teamColor(GAIA_TEAM) ? wool : tc, hx - 0.01, hy + 0.11, 0, 0.058).name = 'band';
    return g;
  }
  // The 2D bear's cartoon mass in the round: a boulder body with a shoulder
  // hump and a lighter belly, chunky stub legs on dark paws (under the body,
  // so they rear and lunge with it), a big round head with a tan muzzle, a
  // big black nose, shiny eyes and round ears; the lower jaw hinges to maul.
  function bearModel(){
    const g = new THREE.Group(), body = pivot(g, 0, 0, 0, 'body'), fur = '#6b4a2c';
    // (BEAR in render-units: the same fat cartoon boulder on stubby legs the 2D art draws)
    blob(body, fur, -0.01, 0.38, 0, 0.42, 0.36, 0.33);
    blob(body, fur, -0.1, 0.6, 0, 0.23, 0.2, 0.22);             // shoulder hump
    blob(body, fur, -0.43, 0.4, 0, 0.065);                       // stub tail
    BEAR.hips.forEach(([x, z], i) => {
      const leg = pivot(body, x, BEAR.hipY, z, 'leg' + i);
      pole(leg, BEAR.legCol, [0, 0, 0], [0, -BEAR.leg + 0.01, 0], BEAR.legR);
      blob(leg, BEAR.paw, 0.015, -BEAR.leg, 0, 0.1, 0.032, 0.088);
    });
    const neck = pivot(body, 0.32, 0.46, 0, 'neck'), hx = 0.13, hy = 0.02, R = 0.2;
    blob(neck, fur, hx, hy, 0, R);
    blob(neck, '#c9a578', hx + 0.19, hy - 0.005, 0, 0.1, 0.065, 0.09);     // muzzle (as 2D)
    blob(neck, '#141414', hx + 0.285, hy + 0.025, 0, 0.04, 0.032, 0.045);  // big black nose
    eyes(neck, hx, hy, 0, R, R, R, 0.75, 0.45, 0.48, 0.022);
    for (const z of [-1, 1]) {
      blob(neck, fur, hx - 0.03, hy + 0.185, z * 0.13, 0.04, 0.066, 0.062); // round ears, cupped forward (as 2D)
      blob(neck, '#4a3018', hx - 0.005, hy + 0.185, z * 0.13, 0.012, 0.038, 0.036);
    }
    const jaw = pivot(neck, hx + 0.11, hy - 0.04, 0, 'jaw');
    blob(jaw, '#c9a578', 0.08, -0.01, 0, 0.085, 0.028, 0.065);               // tan lower jaw (as 2D)
    return g;
  }
  // The dragon, from the same kit and as simple as the others (drawDragonBody, render-units, is its 2D twin): a
  // chest and haunch on four legs, a tapering neck up to a horned head with a hinged jaw, a long tail to a spade,
  // a few plates along the back, two membrane wings on bones. The flame (hidden till it breathes) rides the jaw.
  const DRAGON3D = { body: '#3f7a3a', dark: '#2c5a28', belly: '#dcc47e', membrane: '#6f9e4c', horn: '#efe3c4', eye: '#ffd23a' };
  let dragonPlateGeo = null, dragonClawGeo = null;
  // leg bones (thigh, shin) and the knee's bend: hind knees forward (+1), fore back (−1); a little longer than the hip's
  // height, so standing they're a touch bent
  // A tube along a smooth path through pts, its radius easing r0 → r1 (a neck, a tail); outlined like a blob.
  function taper(g, col, pts, r0, r1){
    const path = new THREE.CatmullRomCurve3(pts.map(p => V3(p))), N = segs(20), R = segs(10);
    const geo = own(new THREE.TubeGeometry(path, N, 1, R, false)), P = geo.attributes.position, c = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i <= N; i++) { const u = i / N, r = r0 + (r1 - r0) * u * u * (3 - 2 * u); path.getPointAt(u, c);
      for (let k = 0; k <= R; k++) { const q = i * (R + 1) + k; v.fromBufferAttribute(P, q).sub(c).multiplyScalar(r).add(c); P.setXYZ(q, v.x, v.y, v.z); } }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat(col)); m.userData.hullGeo = geo; g.add(m);
    for (const [p, r] of [[pts[0], r0], [pts[pts.length - 1], r1]]) blob(g, col, p[0], p[1], p[2], r); // round ends
    return path;
  }
  function dragonModel(){
    const C = DRAGON3D, g = new THREE.Group(), body = pivot(g, 0, 0, 0, 'body');
    if (!dragonClawGeo) { dragonClawGeo = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0); dragonClawGeo.userData.kept = true; } // a claw: base at its root, tip +y
    if (!dragonPlateGeo) { dragonPlateGeo = new THREE.ConeGeometry(1, 1, 3).translate(0, 0.5, 0).scale(1, 1, 0.35); dragonPlateGeo.userData.kept = true; }
    const plate = (par, x, y, z, h, lean = -0.35) => { const m = new THREE.Mesh(dragonPlateGeo, mat(C.dark)); m.position.set(x, y, z); m.scale.set(h * 0.55, h, h * 0.55); m.rotation.z = lean; m.userData.hullGeo = dragonPlateGeo; par.add(m); };
    // the trunk: chest, barrel, haunch; a banded belly
    blob(body, C.body, 0.28, 0.8, 0, 0.5, 0.46, 0.46);
    blob(body, C.body, -0.12, 0.74, 0, 0.62, 0.42, 0.44);
    blob(body, C.body, -0.52, 0.72, 0, 0.36, 0.36, 0.4);
    blob(body, C.belly, 0.02, 0.46, 0, 0.62, 0.2, 0.34);                                   // belly
    for (let k = 0; k < 5; k++) plate(body, 0.42 - k * 0.24, 1.14 - Math.abs(k - 2) * 0.05, 0, 0.36 - Math.abs(k - 2) * 0.07, -0.3); // big back plates, tallest mid-back
    // legs, jointed: a muscled thigh from the hip (leg i) to the knee, a shin to the ankle, a flat foot — posed by
    // placing the foot on the ground (animateAnimal: dragonLegs). Hind 0/1 heavier.
    [[-0.45, -0.34], [-0.45, 0.34], [0.36, -0.32], [0.36, 0.32]].forEach(([x, z], i) => {
      const hind = i < 2, L = DRAGON_LEG[hind ? 'hind' : 'fore'], leg = pivot(body, x, 0.62, z, 'leg' + i);
      blob(leg, C.body, 0, -0.03, 0, hind ? 0.21 : 0.16, hind ? 0.22 : 0.17, hind ? 0.17 : 0.14);   // the haunch / shoulder
      taper(leg, C.body, [[0, -0.05, 0], [0, -L.th / 2, 0], [0, -L.th, 0]], hind ? 0.17 : 0.13, hind ? 0.11 : 0.095);  // stout: it carries tons
      const knee = pivot(leg, 0, -L.th, 0, 'knee'); knee.userData.leg = L;
      taper(knee, C.body, [[0, 0, 0], [0, -L.sh / 2, 0], [0, -L.sh + 0.03, 0]], hind ? 0.11 : 0.095, 0.065); // ends inside the foot
      const ankle = pivot(knee, 0, -L.sh, 0, 'ankle');
      // the foot: a heel pad round the shin's end, three toes splayed forward, a pale claw hooking down at each tip to the ground
      blob(ankle, C.dark, 0.02, -DRAGON_FOOT * 0.5, 0, 0.12, DRAGON_FOOT * 0.5, 0.11);
      for (const z of [-1, 0, 1]) {
        const tz = z * (hind ? 0.075 : 0.065), tx = 0.1 - Math.abs(z) * 0.015;
        blob(ankle, C.dark, tx, -DRAGON_FOOT * 0.65, tz, 0.07, 0.035, 0.036);
        const cl = new THREE.Mesh(dragonClawGeo, mat(C.horn)); cl.userData.hullGeo = dragonClawGeo;
        cl.position.set(tx + 0.065, -DRAGON_FOOT * 0.72, tz * 1.12); cl.rotation.set(0, -tz * 2.2, -Math.PI / 2 - 0.55); cl.scale.set(0.028, 0.075, 0.028); ankle.add(cl);
      }
    });
    // tail: three jointed segments tapering down and back to a spade (the joints' round ends hide the seams as it bends)
    const tail = pivot(body, -0.8, 0.74, 0, 'tail');
    taper(tail, C.body, [[0, 0, 0], [-0.3, -0.05, 0], [-0.6, -0.16, 0]], 0.26, 0.17);
    const tail2 = pivot(tail, -0.6, -0.16, 0, 'tail2');
    taper(tail2, C.body, [[0, 0, 0], [-0.3, -0.09, 0], [-0.6, -0.2, 0]], 0.17, 0.1);
    const tail3 = pivot(tail2, -0.6, -0.2, 0, 'tail3');
    taper(tail3, C.body, [[0, 0, 0], [-0.28, -0.02, 0], [-0.55, 0.02, 0]], 0.1, 0.05);
    const spade = pivot(tail3, -0.55, 0.02, 0, 'spade');
    const sp = new THREE.Mesh(dragonPlateGeo, mat(C.dark)); sp.scale.set(0.16, 0.26, 0.18); sp.rotation.z = Math.PI / 2 + 0.15; sp.userData.hullGeo = dragonPlateGeo; spade.add(sp);
    // neck up to the head, plates down its back
    const neck = pivot(body, 0.62, 0.95, 0, 'neck');
    taper(neck, C.body, [[0, 0, 0], [0.18, 0.3, 0], [0.3, 0.58, 0], [0.42, 0.74, 0]], 0.26, 0.15);
    const head = pivot(neck, 0.5, 0.78, 0, 'head');
    blob(head, C.body, 0.06, 0.02, 0, 0.24, 0.19, 0.2);                                    // skull
    blob(head, C.body, 0.32, -0.02, 0, 0.24, 0.12, 0.14);                                  // snout
    for (const z of [-1, 1]) {
      const eye = blob(head, C.eye, 0.17, 0.08, z * 0.14, 0.045, 0.04, 0.02); eye.name = 'eye';
      blob(eye, '#111', 0.3, 0, z * 0.6, 0.45, 0.55, 0.4);                                 // pupil
      tube(head, C.horn, [-0.02, 0.15, z * 0.1], [-0.15, 0.27, z * 0.15], [-0.28, 0.25, z * 0.19], 0.042);   // horn swept back
    }
    const jaw = pivot(head, 0.08, -0.12, 0, 'jaw');
    blob(jaw, C.belly, 0.2, -0.02, 0, 0.2, 0.04, 0.09);
    // the fire: nested cones out of the mouth (+x), glowing where they overlap, no outline
    const flame = pivot(jaw, 0.5, 0.02, 0, 'flame');
    const cone = (col, r, L, op, add) => { const m = new THREE.Mesh(new THREE.ConeGeometry(r, L, 16, 1, true).rotateZ(Math.PI / 2).translate(L / 2, 0, 0),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, blending: add ? THREE.AdditiveBlending : THREE.NormalBlending }));
      m.material.onBeforeCompile = function(){}; m.material.onBeforeCompile.fow = true; m.renderOrder = add ? 4 : 3; flame.add(m); return m; }; // (the glowing core over the solid fire)
    cone('#e0441a', 0.5, 2.1, 0.7); cone('#ff8a1e', 0.34, 1.8, 0.85); cone('#ffd24a', 0.2, 1.3, 0.9, true); cone('#fff6c8', 0.09, 0.8, 0.9, true); // (outer fire solid: it read washed-out white against the sky)
    flame.visible = false;
    for (const side of [1, -1]) dragonWing(body, side);
    return g;
  }
  // A wing, built as a bat's: bones shoulder → elbow → wrist, three fingers fanning from the wrist, and one membrane
  // stretched between them and the hip — the flank panel (shoulder, elbow, wrist, last finger, hip) and the panels
  // between the fingers, scalloped at their edges. The membrane is rebuilt each frame from where the bones are
  // (poseDragonWing), so it can't come loose. All in the wing's own plane: x chord (back −), y span (out), z its
  // normal; 'fold' turns that plane out of the flank.
  // the flank panel (shoulder, elbow, wrist, last finger, hip) and the two panels between the fingers, each scalloped (M*)
  const WING_TRIS = [['S', 'E', 'B'], ['E', 'W', 'B'], ['W', 'M3', 'B'], ['W', 'F2', 'M3'], ['W', 'F2', 'M23'], ['W', 'M23', 'F1'], ['W', 'F0', 'M01'], ['W', 'M01', 'F1']];
  function dragonWing(body, side){
    const C = DRAGON3D, w = pivot(body, 0.1, 1.08, 0.32 * side, side > 0 ? 'wingL' : 'wingR');
    const fold = pivot(w, 0, 0, 0, 'fold'); fold.rotation.x = side * Math.PI / 2;
    const n = WING_TRIS.length * 3, pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    const gm = new THREE.BufferGeometry(); gm.setAttribute('position', pos); gm.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3).map((_, k) => k % 3 === 2 ? 1 : 0), 3));
    const gh = new THREE.BufferGeometry(); gh.setAttribute('position', pos); gh.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); // the outline's push directions
    const mem = new THREE.Mesh(gm, mat(C.membrane, true)); mem.frustumCulled = false; mem.renderOrder = 2; fold.add(mem);
    dragonHullDS = dragonHullDS || (HULL_MATS.add(dragonHullDS = screenHull(new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, depthWrite: false }), HULL, 1.5)), dragonHullDS);
    const hull = new THREE.Mesh(gh, dragonHullDS); hull.frustumCulled = false; fold.add(hull);
    const bones = [[0.045], [0.04], [0.032], [0.024], [0.022]].map(([r]) => { const b = pole(fold, C.dark, [0, 0, 0], [0, 1, 0], r); b.userData.r = r; return b; });
    const knob = blob(fold, C.dark, 0, 0, 0, 0.055);                                         // the wrist knuckle
    w.userData.wing = { pos, gh, bones, knob, side, hull, mem };
  }
  let dragonHullDS = null; const _wv = {};
  // Lay the wing out for fold fd (0 spread … 1 folded): joints from the blended angles, then the membrane triangles
  // between them, the outline pushed out from the wing's middle, the bones set end to end.
  function poseDragonWing(w, fd, tuck = 0){
    const d = w.userData.wing, pt = dragonWingJoints(fd, tuck, d.side), { S, E, W } = pt, F = [pt.F0, pt.F1, pt.F2]; // (render-units: shared with the 2D art)
    let cx = 0, cy = 0; for (const k of ['S', 'E', 'W', 'B', 'F0', 'F1', 'F2']) { cx += pt[k][0] / 7; cy += pt[k][1] / 7; }
    const P3 = d.pos.array, N = d.gh.attributes.normal.array; let i = 0;
    for (const tri of WING_TRIS) for (const k of tri) { const p = pt[k]; P3[i] = p[0]; P3[i + 1] = p[1]; P3[i + 2] = p[2];
      const nx = p[0] - cx, ny = p[1] - cy, nl = Math.hypot(nx, ny) || 1; N[i] = nx / nl; N[i + 1] = ny / nl; N[i + 2] = 0; i += 3; }
    d.pos.needsUpdate = true; d.gh.attributes.normal.needsUpdate = true;
    d.hull.renderOrder = 1; d.mem.renderOrder = 2;                                                // (addHulls' union pass levels every mesh: the outline must go first)
    const set = (b, a, c) => { _wv.a = _wv.a || new THREE.Vector3(); _wv.d = _wv.d || new THREE.Vector3(); _wv.a.set(a[0], a[1], a[2]); _wv.d.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const L = _wv.d.length() || 1e-4; b.scale.set(2 * b.userData.r, L, 2 * b.userData.r); b.position.copy(_wv.a).addScaledVector(_wv.d, 0.5); b.quaternion.setFromUnitVectors(_wv.y = _wv.y || new THREE.Vector3(0, 1, 0), _wv.d.normalize()); };
    set(d.bones[0], S, E); set(d.bones[1], E, W); for (let k = 0; k < 3; k++) set(d.bones[2 + k], W, F[k]);
    d.knob.position.set(W[0], W[1], W[2]);
  }
  // Pose an animal from its state (viewer-only). A four-beat walk — hind,
  // fore, other hind, other fore — with each leg lifting on its forward
  // swing and a bob at every footfall; the phase advances by the distance
  // actually covered (a.moved) over the stride 4·L·sin A — a foot is down for
  // half the cycle while it sweeps its whole arc (2·L·sin A), so the body must
  // cover twice that per cycle for planted feet not to slide. a.gait eases
  // in/out, so legs settle when it stops.
  const GAIT = { sheep: { A: 0.55, L: 0.14, lift: 0.03, bob: 0.01 }, bear: { A: 0.45, L: 0.28, lift: 0.05, bob: 0.02 }, dragon: { A: 0.6, L: 0.5, lift: 0.12, bob: 0.03 } }; // (the dragon: long, slow strides — a heavy, unhurried walk; DRAGON_STRIDE in render-units matches)
  const LEG_PHASE = [0, 0.5, 0.25, 0.75].map(f => f * 2 * Math.PI); // legs 0/1 hind, 2/3 fore
  let _dv = null;
  function animateAnimal(model, e, a, dt){
    const G = GAIT[e.utype], b = model.getObjectByName('body'), neck = model.getObjectByName('neck'), idp = e.id || 0;
    const legs = [0, 1, 2, 3].map(i => model.getObjectByName('leg' + i));
    if (e.utype === 'dragon') dragonGaitStep(e, a, a.moved, dt, G.L * Math.sin(G.A));   // (its pivots step too)
    else if (e.utype !== 'bear') { a.gait += ((a.moved > 1e-4 ? 1 : 0) - a.gait) * Math.min(1, dt * 8);
      a.phase += a.moved / (4 * G.L * Math.sin(G.A)) * 2 * Math.PI; }
    const look = 0.35 * Math.sin(aTick * 0.013 + idp) ** 3 * (1 - a.gait); // now and then a slow look round
    const bob = G.bob * Math.abs(Math.sin(2 * a.phase)) * a.gait;
    let reach = 0; // bear pounce: fore legs reach, hind brace
    if (e.utype === 'sheep') {
      a.graze += ((e.eatingGrass ? 1 : 0) - a.graze) * Math.min(1, dt * 4);
      b.position.y = bob;
      b.scale.y = 1 + Math.sin(aTick * 0.06 + idp) * 0.015 * (1 - a.gait); // breathing
      neck.rotation.z = -0.95 * a.graze + Math.sin(aTick * 0.6) * 0.05 * a.graze; // head down, chewing
      neck.rotation.y = look * (1 - a.graze);
      model.getObjectByName('tail').rotation.y = Math.sin(aTick * (e.eatingGrass ? 0.35 : a.gait > 0.5 ? 0.25 : 0.08) + idp) * 0.4;
    } else if (e.utype === 'dragon') {
      // A huge, heavy beast: its pose comes from dragonAnim (render-units, shared with the 2D art) — here set on the
      // model, with the dust and the ground's shake at its footfalls and slam, and smoke from its nostrils.
      const P = dragonAnim(e, a, dt), head = model.getObjectByName('head');
      b.scale.set(1 + P.chest * 0.35, 1 + P.chest, 1 + P.chest * 0.8);
      b.rotation.set(P.roll, 0, P.pitch);
      b.position.set(P.bodyX, P.bodyY + bob * 0.4, 0);
      neck.rotation.z = P.neck; neck.rotation.y = P.neckY;
      head.rotation.z = P.head; head.rotation.x = P.headX;
      model.getObjectByName('jaw').rotation.z = -P.jaw;
      for (const eye of head.children.filter(o => o.name === 'eye')) { eye.userData.sy ??= eye.scale.y; eye.scale.y = eye.userData.sy * (1 - 0.92 * P.eyeShut); }
      ['tail', 'tail2', 'tail3'].forEach((n, k) => { const j = model.getObjectByName(n); j.rotation.y = P.tail[k]; j.rotation.z = P.tailZ[k]; });
      model.getObjectByName('spade').rotation.y = P.spade;
      for (const [nm, sd] of [['wingL', 1], ['wingR', -1]]) { const w = model.getObjectByName(nm);
        poseDragonWing(w, 1 - P.open, P.sl);
        w.rotation.set(-sd * ((1.35 + (0.35 + 0.6 * P.rr + P.beat - 1.35) * P.open) * (1 - P.sl) + (0.45 + P.chest * 1.5) * P.sl), 0, 0); } // (roaring, spread high in a V)
      const fl = model.getObjectByName('flame'); fl.visible = P.flame > 0;
      if (fl.visible) fl.scale.set(P.flame * (0.92 + 0.08 * Math.sin(P.ck * 40)), 0.85 + 0.15 * Math.sin(P.ck * 33), 0.85 + 0.15 * Math.cos(P.ck * 29));
      if (!a.lab) {
        for (const i of P.ev.steps) { const f = legs[i].getWorldPosition(_dv || (_dv = new THREE.Vector3())); puffBurst(f.x, 0.04, f.z, 3, '#b7a27a'); shakeFrom(f.x, f.z, 0.03); }
        if (P.ev.slam) { for (const l of [legs[2], legs[3]]) { const f = l.getWorldPosition(_dv || (_dv = new THREE.Vector3())); puffBurst(f.x, 0.04, f.z, 7, '#b7a27a'); } shakeFrom(a.x, a.z, 0.12); }
        if (world) dragonSounds(e, P.ev);                                                  // (the 2D map is off while the world view shows)
        if (P.ev.snore || P.ev.smoke) { const n = head.localToWorld((_dv || (_dv = new THREE.Vector3())).set(0.52, 0.04, 0)); puffBurst(n.x, n.y, n.z, 2, '#9a9a9a'); }
      }
      reach = P.reach;
    } else {
      // bearAnim (render-units, shared with the 2D art): a lumbering planted-paw walk, the maul on the real bite clock
      const P = bearAnim(e, a, dt, a.moved), hind = -0.22, c = Math.cos(P.pitch), sn = Math.sin(P.pitch);
      b.rotation.set(P.roll, 0, P.pitch); b.position.set(hind - hind * c + P.lunge, -hind * sn + P.bob, 0);   // pitched about the hind paws
      b.scale.set(1 + P.breath, 1 + P.breath, 1 + P.breath);
      neck.rotation.set(P.shake, -P.neckYaw, P.neckPitch);
      model.getObjectByName('jaw').rotation.z = -0.7 * P.jaw;
      legs.forEach((l, i) => { l.userData.y0 ??= l.position.y; l.position.y = l.userData.y0; l.rotation.z = P.legs[i].ang; l.scale.y = P.legs[i].len; });
      return;
    }
    // Each leg: half the cycle planted, its foot sweeping back at an even pace (it keeps pace with the ground),
    // half swinging forward through the air.
    if (e.utype === 'dragon') { dragonLegs(model, a, legs, reach, G); return; }
    legs.forEach((l, i) => {
      if (l.userData.y0 === undefined) l.userData.y0 = l.position.y;
      const q = (((a.phase + LEG_PHASE[i] - Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let x, up = 0;                                                                   // x: the foot, −1 (back) … 1 (ahead)
      if (q < Math.PI) x = 1 - 2 * q / Math.PI; else { const u = q / Math.PI - 1; x = -Math.cos(u * Math.PI); up = Math.sin(u * Math.PI); }
      l.rotation.z = Math.asin(Math.sin(G.A) * x) * a.gait + (i < 2 ? -0.35 : 0.45) * reach + (a.lie ? (i < 2 ? -1.3 : 1.3) * a.lie : 0); // (a lying dragon tucks its legs)
      l.position.y = l.userData.y0 + G.lift * up * a.gait;
    });
  }
  // The dragon's legs: each foot's spot is found — under the hip on the ground, swept back through the stance, lifted
  // and brought forward on the swing — and the hip and knee solved to reach it (two-bone IK in the leg's plane). So
  // the feet stay planted as the heavy body sinks and rolls over them. The foot rolls: heel up at toe-off, toes down
  // through the swing. Rearing, the fore feet paw the air; lying (a.lie) the legs blend to a resting pose splayed
  // beside the body — forelegs out in front like a sphinx's, hind legs folded knee-forward.
  let _lw = null, _qa = null, _qb = null, _ea = null;
  function dragonLegs(model, a, legs, reach, G, lie = a.lie || 0, i0 = 0){
    const body = model.getObjectByName('body'), ck = a.dr ? a.dr.ck : 0; model.updateMatrixWorld(true);
    _lw = _lw || new THREE.Vector3();
    legs.forEach((l, j) => { const i = j + i0;
      const knee = l.getObjectByName('knee'), ankle = l.getObjectByName('ankle'), L = knee.userData.leg, hind = i < 2, side = Math.sign(l.position.z);
      const { x, up, roll } = dragonStride(a.phase, i);                                  // (render-units: the stride, shared with the 2D art)
      l.getWorldPosition(_lw); _lw.y = DRAGON_FOOT + G.lift * 1.8 * up * a.gait; body.worldToLocal(_lw);
      let tx = _lw.x - l.position.x + x * G.L * Math.sin(G.A) * a.gait, ty = _lw.y - l.position.y;
      if (!hind && reach > 0.2) { const pw = ck * 5.5 + (side > 0 ? 0 : Math.PI);     // rearing: the fore feet paw the air, alternately
        const px = 0.2 + 0.14 * Math.sin(pw), py = -0.3 + 0.1 * Math.cos(pw), w = Math.min(1, (reach - 0.2) * 2);
        tx += (px - tx) * w; ty += (Math.max(ty, py) - ty) * w; }
      let [hip, kn] = dragonLegIK(L, tx, ty);
      const T = DRAGON_TUCK[hind ? 'hind' : 'fore'];
      hip += (T.hip - hip) * lie; kn += (T.knee - kn) * lie;
      l.rotation.set(-side * T.out * lie, 0, hip); l.position.y = l.userData.y0 ??= l.position.y;
      knee.rotation.set(hind ? -side * 0.7 * lie : 0, 0, kn);                            // lying, the hind shin swings out to the side: the ankle and foot sit beside the thigh, not tucked under it
      // The foot, set in the body's frame whatever the leg's splay: flat, rolling through the step; lying, its toes turned
      // out to the side — the hind ones well out, so the foot sits beside the folded shin, not inside it (the leg's own
      // splay rolled the sole onto its edge)
      _qa = _qa || new THREE.Quaternion(); _qb = _qb || new THREE.Quaternion(); _ea = _ea || new THREE.Euler(0, 0, 0, 'YZX');
      l.updateMatrix(); knee.updateMatrix();
      _qa.copy(l.quaternion).multiply(knee.quaternion).invert();
      _qb.setFromEuler(_ea.set(0, side * (hind ? 0.5 : 0.35) * lie, roll * a.gait * (1 - lie)));
      ankle.quaternion.copy(_qa.multiply(_qb));
    });
  }
  // The dragon's death (age: ms): one heavy collapse — the legs buckle and the body drops (a bounce as it lands), the
  // neck follows it down and the head comes to rest on the ground; the wings sag open onto the ground, the tail goes
  // limp, the eyes close.
  function dragonDeath(model, age){
    const body = model.getObjectByName('body'), neck = model.getObjectByName('neck'), head = model.getObjectByName('head');
    const fall = (t0, dur) => { const u = Math.max(0, Math.min(1, (age - t0) / dur)); return u * u; };        // accelerating
    const ease = (t0, dur) => { const u = Math.max(0, Math.min(1, (age - t0) / dur)); return u * u * (3 - 2 * u); };
    const bounce = (t0, amp) => age > t0 ? amp * Math.exp(-(age - t0) / 170) * Math.sin((age - t0) / 60) : 0;
    const fb = fall(100, 650), fn = fall(450, 600), limp = ease(300, 900);
    model.rotation.x = 0;
    body.position.set(0, -0.44 * fb + bounce(750, 0.05), 0); body.rotation.set(0, 0, bounce(750, 0.03));
    const legs = [0, 1, 2, 3].map(i => model.getObjectByName('leg' + i)), a = { phase: 0, gait: 0, dr: null };
    dragonLegs(model, a, legs, 0, GAIT.dragon, Math.min(1, fb * 1.3));
    neck.rotation.set(0, 0.25 * fn, 0.1 - 1.2 * fn + bounce(1050, 0.08));
    head.rotation.set(0, 0, 0.5 * fn + bounce(1070, 0.08));
    model.getObjectByName('jaw').rotation.z = -0.25 * fall(1000, 400);
    for (const eye of head.children.filter(o => o.name === 'eye')) { eye.userData.sy ??= eye.scale.y; eye.scale.y = eye.userData.sy * (1 - 0.92 * fall(900, 300)); }
    model.getObjectByName('tail').rotation.set(0, 0.2 * limp, -0.2 * limp);
    model.getObjectByName('tail2').rotation.set(0, 0.15 * limp, -0.1 * limp);
    model.getObjectByName('tail3').rotation.set(0, 0.2 * limp, 0.1 * limp);
    for (const [nm, sd] of [['wingL', 1], ['wingR', -1]]) { const w = model.getObjectByName(nm);
      poseDragonWing(w, 1 - 0.35 * limp, 0);
      w.rotation.set(-sd * (1.35 - 1.6 * limp), 0, 0.15 * limp); }                                   // folded upright → sagging open onto the ground
    model.getObjectByName('flame').visible = false;
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
  let POLY = 1; // curve/sphere resolution: 1 in the lab, lower for the game's cached villager poses
  const segs = n => Math.max(4, Math.round(n * POLY));
  function tube(g, col, a, c, b, r, t0 = 0, t1 = 1, c2){ // c2: a cubic a → c, c2 → b
    const curve = c2 ? new THREE.CubicBezierCurve3(V3(a), V3(c), V3(c2), V3(b)) : new THREE.QuadraticBezierCurve3(V3(a), V3(c), V3(b)), pts = [];
    for (let i = 0; i <= 8; i++) pts.push(curve.getPoint(t0 + (t1 - t0) * i / 8));
    const rec = { pts, r, col };                                            // what a rig needs (its rings follow pts)
    if (RIG_LIGHT) { const m = new THREE.Object3D(); m.userData.tubeRec = rec; g.add(m); for (const p of [pts[0], pts[8]]) blob(g, col, p.x, p.y, p.z, r); return m; }
    const path = new THREE.CatmullRomCurve3(pts), geo = own(new THREE.TubeGeometry(path, segs(12), r, segs(8), false)), m = new THREE.Mesh(geo, mat(col));
    m.userData.tubeRec = rec;
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
    // Seen through its own eyes only the arms, hands and what they hold show (as in any first-person game): every
    // other body part is tagged here and collapses in the fp pose (rigPose).
    const fpTag = (grp, n, self) => (self ? [grp] : grp.children.slice(n)).forEach(o => o.traverse(c => { c.userData.fpHide = true; }));
    const g0 = g.children.length;
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
      const foot = [fx + 0.5, 3.7 - lift, z], hip = [0, hipY, z], seg = (3.7 - (o.dress ? -2 : -3)) / 2 * 1.02; // the ankle at the boot's middle: the leg's end stays inside it
      const dx = foot[0] - hip[0], dy = foot[1] - hip[1], d = Math.hypot(dx, dy), h = Math.sqrt(Math.max(0, seg * seg - d * d / 4));
      const kn = [(hip[0] + foot[0]) / 2 + dy / d * h, (hip[1] + foot[1]) / 2 - dx / d * h, z];   // forward of the hip→foot line
      const knee = [2 * kn[0] - (hip[0] + foot[0]) / 2, 2 * kn[1] - (hip[1] + foot[1]) / 2, z];  // the hose passes through the knee
      tube(g, LEG, P(...hip), P(...knee), P(...foot), ar(o.dress ? 0.85 : 0.95));
      blob(g, BOOT, ...P(fx + 0.6, 3.9 - lift, z), ar(o.dress ? 1.3 : 1.5), ar(0.9), ar(o.dress ? 1 : 1.2));
    }
    fpTag(g, g0);
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
    const u0 = U.children.length;
    const local = pt => { if (U === g) return pt; const v = V3(P(...pt)).applyMatrix4(toU); return [v.x / UK, 5 - (v.y - Y) / UK, v.z / UK]; };
    if (o.dress) { // one smooth dress from the hem up, rising into the head (DRESS_SHAPES)
      const prof = DRESS_SHAPES.tunic; // hem → skirt → waist → bust → shoulder → neck up into the head
      const hem = prof[0][1], geo = own(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(ar(r), chh(y) - chh(hem))), 20));
      const m = new THREE.Mesh(geo, mat(tc)); m.position.set(0, chh(hem) + Y, 0); m.userData.hullGeo = geo; U.add(m);
    } else if (o.armor) { // armor over the tunic (armorMat: the 2D layout, team colour kept)
      blob(U, armorMat(o.armor, o.metal || FORGE[1], tc), ...P(0, -6), ar(4.6), ar(5), ar(4.2)).userData.body = 'torso';
    } else blob(U, tc, ...P(0, -6), ar(4.6), ar(5), ar(4.2)).userData.body = 'torso'; // torso
    fpTag(U, u0);
    let hn = H.children.length;
    blob(H, SKIN, ...P(0, -14), ar(4)).userData.body = 'head';                    // head
    if (o.hat !== 'great') eyes(H, ...P(0, -14), ar(4), ar(4), ar(4), 1, 0.12, 0.35, ar(0.5));
    fpTag(H, hn);
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
      const a0 = U.children.length;
      tube(U, SKIN, P(...shA), P(...bend), P(...hand), ar(1.05));
      tube(U, tc, P(...shA), P(...bend), P(...hand), ar(1.45), 0, 0.22);    // the puffy sleeve: the tube's first stretch
      // first person shows the forearm: the arm folds into its elbow, the shoulder cap and the sleeve go (tube = [tube, start cap, end cap])
      U.children[a0].userData.fpForearm = true; for (const i of [1, 3, 4, 5]) fpTag(U.children[a0 + i], 0, true);
      blob(U, SKIN, ...P(...hand), ar(1.3));                                   // the hand
    }
    const hat = o.hat; hn = H.children.length;
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
    if (hat === 'spiked') { blob(H, '#b9bec6', ...P(-0.3, -15.8), ar(4.4), ar(3.6), ar(4.4)); const sp = new THREE.Mesh(own(new THREE.ConeGeometry(ar(0.9), ar(3.4), 8)), mat('#b9bec6')); sp.position.set(...P(-0.3, -20.6)); sp.userData.hullGeo = sp.geometry; H.add(sp); }
    if (o.feather) { // Fletching's tell (drawHelmet): a tall light-team plume pinned upright in the cap's crown, leaning back, a quill up the middle
      const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.quadraticCurveTo(-2.2, 3.6, -1.1, 7.6); sh.quadraticCurveTo(-0.1, 9.4, 1.4, 7.9); sh.quadraticCurveTo(1.7, 3.6, 0.9, 0.2);
      const geo = own(new THREE.ExtrudeGeometry(sh, { depth: 0.5, bevelEnabled: false, curveSegments: 6 }).translate(0, 0, -0.25).scale(ar(1), ar(1), ar(1)));
      const f = new THREE.Mesh(geo, mat(lightOf(tc))); f.position.set(...P(-1.2, -18.2)); f.rotation.set(o.flutter ? o.flutter[1] : 0, 0, 0.25 + (o.flutter ? o.flutter[0] : 0)); f.userData.hullGeo = geo; f.userData.hullW = HULL * 0.5; H.add(f); // o.flutter [lean, twist]
      pole(f, '#00000055', [ar(0.1), ar(0.4), 0], [ar(0.1), ar(7.4), 0], ar(0.12), 'line'); }
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
    fpTag(H, hn);
  }
  // drawBigSword in the round: a flat blade (parallel edges tapering to a
  // point), a flat gold crossguard in the blade's own plane, a leather grip,
  // no pommel. Built with the grip's middle at the origin — that's where the
  // fist closes — then stood along `dir`. tier (attack techs): brighter
  // steel and a longer blade, as the 2D art.
  // edge: the way its cutting edge faces (made square to dir) — a swing leads with the edge; else the plain turn to dir
  function sword(g, hand, tier = 0, dir = [0.75, 0.66, 0], edge = null){ // held out in front, tipped forward — clear of the face
    const sw = new THREE.Group(), ext = tier >= 2 ? 3 : tier >= 1 ? 1.5 : 0, k = UNIT_SCALE / PX;
    const outline = [[-2.2, 4.5], [2.2, 4.5], [1.9, 19.5 + ext], [0, 24.5 + ext], [-1.9, 19.5 + ext]];
    const blade = own(new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x * k, y * k))), { depth: 0.7 * k, bevelEnabled: false }).translate(0, 0, -0.35 * k));
    const bm = new THREE.Mesh(blade, mat(['#a7abb0', '#dde3ea', '#f2f6fb'][tier])); bm.userData.hullGeo = blade; sw.add(bm);
    boxAt(sw, GOLD, -3.8 * k, -0.9 * k, 3.8 * k, 0.9 * k, 2.7 * k, 4.5 * k);                  // crossguard
    pole(sw, '#5c3d24', [0, -2.7 * k, 0], [0, 2.7 * k, 0], 0.8 * k);                        // grip
    sw.position.copy(V3(hand)); const d = V3(dir).normalize();
    const x = edge && V3(edge).addScaledVector(d, -V3(edge).dot(d));
    if (x && x.lengthSq() > 1e-4) { x.normalize(); sw.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, d, x.clone().cross(d))); } // (the blade's flat lies in its local x–y: x is the edge)
    else sw.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
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
  const roundShield = (g, at3, tc) => { // one piece (the boss centred on the face, facing +x), so it turns as a whole
    const sh = new THREE.Group(); sh.position.set(...at3); g.add(sh);
    const d = own(new THREE.CylinderGeometry(ar(4.8), ar(4.8), ar(1.2), 16).rotateZ(Math.PI / 2)), m = new THREE.Mesh(d, mat('#a5723a')); m.userData.hullGeo = d; sh.add(m);
    blob(sh, '#f5f5f0', ar(0.7), 0, 0, ar(1.6)); return sh; };
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
  // pose: legs [[hoof dx, lift] ×4] (hind −z, hind +z, fore −z, fore +z), bob (body up, art px), nod (head), tail (swing).
  function horseKit(g, coat, mane, legC, tc, muzzle = legC, pose = {}){
    const k = 1.35, B = pose.bob || 0, H = (x, y, z = 0) => [ax(x, k), chh(y - B, k), ar(z, k)], G = (x, y, z = 0) => [ax(x, k), chh(y, k), ar(z, k)], r = v => ar(v, k);
    blob(g, coat, ...H(-0.4, -6.2), r(8.2), r(4.4), r(4.7)).userData.body = 'horse'; // barrel
    // Saddle cloth: a shell draped over the back and down both flanks (a
    // cylinder arc along the body, hugging the barrel's cross-section).
    const cloth = own(new THREE.CylinderGeometry(1, 1, r(7), 20, 1, true, Math.PI / 2 - 1.15, 2.3).rotateZ(Math.PI / 2));
    const cm = new THREE.Mesh(cloth, mat(tc, true));
    cm.position.set(...H(-0.6, -6.2)); cm.scale.set(1, r(4.45), r(4.8)); cm.userData.hullGeo = cloth; g.add(cm);
    [[-5.4, -2.7, -1.2], [-4.6, 2.7, -1.2], [4.6, -2.7, 1], [5.4, 2.7, 1]].forEach(([x, z, bend], i) => { // hind (hocks back), fore (knees forward): from the body to a planted or lifted hoof
      const [dx, lift] = (pose.legs && pose.legs[i]) || [0, 0], hy = 3.9 - lift;
      tube(g, legC, H(x, -5, z), G(x + bend * (1 + lift * 0.35) + dx * 0.5, (-5 - B + hy) / 2, z), G(x + dx, hy, z), r(0.95));
      blob(g, '#241408', ...G(x + dx + 0.3, hy + 0.4, z), r(1.3), r(0.75), r(1.1));
    });
    // Neck (with head and mane) and tail hang from named pivots — the shoulder, the poll, the tail root — so a
    // grazing animator (animateModels' horses) can lower and turn them.
    const pivot = (parent, at3, name) => { const q = new THREE.Group(), inner = new THREE.Group(); q.position.set(...at3); q.name = name; inner.position.set(...at3.map(v => -v)); q.add(inner); parent.add(q); return inner; };
    const N = pivot(g, H(4.5, -7.5), 'horseNeck');
    tube(N, coat, H(4.5, -7.5), H(8.5, -10.5), H(9.6, -14.2), r(2.3));              // neck, arched
    const poll = pivot(N, H(10, -14), 'horseHead');
    const head = new THREE.Group(); head.position.set(...H(10, -14)); head.rotation.z = -0.55 - (pose.nod || 0); poll.add(head); // the long head, nose down (nodding with the gait)
    blob(head, coat, r(2.8), 0, 0, r(4), r(2.3), r(2.2)).userData.body = 'horsehead'; // a big cartoon head
    blob(head, muzzle, r(5.9), -r(0.2), 0, r(1.8), r(1.9), r(1.9));                // lighter muzzle
    eyes(head, r(1.9), r(0.7), 0, r(1.6), r(1.6), r(2.2), 0.2, 0.4, 0.9, r(0.5));
    for (const s of [-1, 1]) { const e = blob(head, coat, -r(0.4), r(2.1), s * r(0.9), r(0.55), r(1.4), r(0.4)); e.rotation.z = -0.3; } // leaf ears
    tube(N, mane, H(3.6, -9.5), H(7.6, -13.6), H(9.4, -15.8), r(0.95));               // mane along the crest
    const tl = pose.tail || 0; tube(pivot(g, H(-8.2, -7.6), 'horseTail'), mane, H(-8.2, -7.6), H(-10.4 - 2 * tl, -4.5 - 2 * tl), H(-9.6 - 4 * tl, -0.8 - 4.5 * tl), r(1.05)); // tail, hanging (streaming at a gallop)
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
  // The ram, built from its rigid parts — side walls, gable ends (the front with
  // the log's opening), two roof slopes with the team fascia, the log, six wheels
  // — each on its own hinge, so the living ram and its wreck are the same pieces.
  // pose: roll (wheel turn, rad; + rolls forward), log (px the log slides, +
  // forward), shake (shed jolt, px up), pitch; wreck { age (ms), weathered }:
  // drawRamCorpse's order in the round — the axles snap and the shed drops; the
  // walls and gables topple outward over their bottom edges and land flat; the
  // roof slopes keep their length as the ridge drops onto the log, so their eaves
  // swing out onto the fallen walls; the log drops out of its slings; the wheels
  // tip over their outer rims. Every fall accelerates and lands with a small
  // bounce. Weathered (the bones stage): grey.
  function ramModel(tc, pose = {}){
    const g = new THREE.Group(), k = 1.45, X = x => ax(x, k), Yh = y => chh(-y + 5, k) - chh(5, k), R = r => ar(r, k);
    const Wr = pose.wreck, age = Wr ? Wr.age : 0, weathered = !!(Wr && Wr.weathered), cl = v => Math.max(0, Math.min(1, v));
    const fall = (a, d) => Wr ? (weathered ? 1 : cl((age - a) / d) ** 2) : 0;                                   // gravity: accelerating (0: standing)
    const bump = (a, d, amp) => Wr && !weathered && age > a && age < a + d ? amp * Math.sin((age - a) / d * Math.PI) : 0; // the landing bounce
    const L = X(12), WB = R(6), WE = R(7.2), T = R(0.9), CB = Yh(3), wallH = Yh(9) - Yh(3), rise = Yh(17) - Yh(3), RLOG = R(2.6);
    const wallC = weathered ? '#877e6c|planks' : '#987848|planks', roofC = weathered ? '#9a917f|planks' : '#b89868|planks';
    // the shed body (walls, gables, roof, log) drops as the axles give
    const shed = new THREE.Group(); g.add(shed); shed.position.y = CB * (1 - fall(260, 280)) + bump(540, 220, R(0.6)) + (pose.shake ? Yh(pose.shake) - Yh(0) : 0); shed.rotation.z = pose.pitch || 0;
    // side walls: solid plank slabs hinged at the bottom outer edge, toppling outward to lie flat
    const tw = (Math.PI / 2) * fall(560, 420) - bump(980, 200, 0.07);
    for (const s of [-1, 1]) { const pv = new THREE.Group(); pv.position.z = s * WB; pv.rotation.x = s * tw; shed.add(pv);
      boxAt(pv, wallC, -L, s > 0 ? -T : 0, L, s > 0 ? 0 : T, 0, wallH); }
    // gable ends: thick pentagons (the front with the log's opening) toppling out over their bottom edges
    const tg = (Math.PI / 2) * fall(620, 430) - bump(1050, 200, 0.07);
    for (const sA of [-1, 1]) {
      const sh = new THREE.Shape([[-WB, 0], [WB, 0], [WB, wallH], [0, rise], [-WB, wallH]].map(([z, y]) => new THREE.Vector2(z, y)));
      if (sA > 0) { const h = new THREE.Path(), hw = R(2.95), y0 = Yh(6.1) - CB, y1 = Yh(11.9) - CB; h.moveTo(-hw, y0); h.lineTo(hw, y0); h.lineTo(hw, y1); h.lineTo(-hw, y1); sh.holes.push(h); }
      const geo = own(new THREE.ExtrudeGeometry(sh, { depth: T, bevelEnabled: false }).rotateY(Math.PI / 2).translate(sA > 0 ? -T : 0, 0, 0));
      const pv = new THREE.Group(); pv.position.x = sA * L; pv.rotation.z = -sA * tg; shed.add(pv);
      const m = new THREE.Mesh(geo, mat(wallC)); m.userData.hullGeo = geo; pv.add(m); }
    // the log drops straight out of its slings
    const lf = fall(620, 430); log(shed, weathered ? '#877e6c' : TREE_BARK, X(12 + (pose.log || 0)), 0, X(12), RLOG, true, (Yh(9) - CB) * (1 - lf) + RLOG * lf + bump(1050, 220, R(0.8)), weathered ? '#9a917f' : '#8a6a4a');
    // the roof slopes: rigid slabs (length w0) whose ridge drops onto the log while the eave swings out onto the fallen wall
    const Tr = R(1), Lr = L + R(1.2), w0 = Math.hypot(WE, rise - wallH), phi0 = Math.atan2(rise - wallH, WE);
    const rf = fall(600, 520), ridgeY = rise + (2 * RLOG + Tr * 0.3 - rise) * rf + bump(1120, 220, R(0.9)), phi1 = Math.asin(Math.min(1, (2 * RLOG + Tr * 0.3 - T) / w0)), phi = phi0 + (phi1 - phi0) * rf;
    for (const s of [-1, 1]) {
      const dir = new THREE.Vector3(0, Math.sin(phi), -s * Math.cos(phi)), n = new THREE.Vector3(0, Math.cos(phi), s * Math.sin(phi)); // up the slope, and its outward face
      const E = new THREE.Vector3(0, ridgeY, s * R(0.3) * rf).addScaledVector(dir, -w0);                                          // the eave, a slope's length down from the ridge
      const sl = new THREE.Group(); sl.position.copy(E); sl.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(-s, 0, 0), n, dir)); shed.add(sl); // x flipped per side keeps the basis right-handed (a mirrored one isn't a rotation)
      boxAt(sl, roofC, -Lr, 0, Lr, w0 + R(0.8), 0, Tr);                                                                           // x along the ram, z up the slope, y through the slab
      boxAt(sl, tc, -Lr - R(0.1), 0, Lr + R(0.1), R(1.3), Tr, Tr + R(0.25));                                                      // the team fascia along the eave
    }
    // the wheels: each tips over its outer rim and lies flat, one after another
    [-8, 0, 8].forEach((x, i) => { for (const s of [-1, 1]) {
      const kk = i * 2 + (s > 0 ? 1 : 0), tw2 = (Math.PI / 2) * fall(300 + kk * 55, 380) - bump(680 + kk * 55, 180, 0.08);
      const pv = new THREE.Group(); pv.position.set(X(x), 0, s * (R(6.7) + R(0.7))); pv.rotation.x = s * tw2; g.add(pv);
      const wg = new THREE.Group(); wg.position.set(0, CB, -s * R(0.7)); wg.rotation.z = -(pose.roll || 0); pv.add(wg); // spinning on its hub as the ram rolls
      wheel(wg, 0, 0, 0, R(3), R(1.4), weathered ? '#6f6858' : '#33261a', weathered ? '#8a826f' : '#5a4630');
      pole(wg, weathered ? '#8a826f' : '#5a4630', [-R(2.6), 0, s * R(0.75)], [R(2.6), 0, s * R(0.75)], R(0.35));
    } });
    return g;
  }
  // drawTradeCartBody (CART_DIM ×1.32): an open team-walled bed on two spoked
  // wheels, the grain sack while loaded, an ox yoked ahead on shafts — built from
  // rigid parts on their own hinges (as the ram), so the living cart and its
  // wreck are the same pieces. pose: roll (wheel turn, rad), step (the ox's walk
  // phase, or null standing), load (the sack shows), wreck { age, weathered }:
  // drawTradeCartCorpse's order — the wheels tip off outward, the bed drops and
  // its walls fall open, the sack slumps out; the ox, a beat later, goes down on
  // its side (its bones at the skeleton stage). Weathered: grey.
  function cartModel(tc, pose = {}){
    const g = new THREE.Group(), k = 1.32, X = x => ax(x, k), Yh = y => chh(-y + 5, k) - chh(5, k), R = r => ar(r, k);
    const Wr = pose.wreck, age = Wr ? Wr.age : 0, grey = !!(Wr && Wr.weathered), cl = v => Math.max(0, Math.min(1, v));
    const fall = (a, d) => Wr ? (grey ? 1 : cl((age - a) / d) ** 2) : 0;
    const bump = (a, d, amp) => Wr && !grey && age > a && age < a + d ? amp * Math.sin((age - a) / d * Math.PI) : 0;
    const G = c => grey ? '#8a826f' : c, TC = grey ? '#8f877a' : tc;
    const WR = 7.4, y0 = Yh(WR - 1.2), y1 = Yh(WR - 1.2 + 7.6), w = 5, L = 9, t = 0.5, jog = pose.step != null ? R(0.25) * Math.abs(Math.sin(2 * Math.PI * pose.step * 2)) : 0;
    const bed = new THREE.Group(); g.add(bed); bed.position.y = jog - (y0 - R(0.6)) * fall(280, 300) + bump(580, 220, R(0.5)); // the bed rides the axle; drops when the wheels go
    bed.rotation.x = 0.06 * fall(280, 300);
    boxAt(bed, G('#3a2c1c'), X(-L), R(-w), X(L), R(w), y0 - R(0.6), y0);                                 // floor
    const tw = (Math.PI / 2) * fall(600, 450) - bump(1050, 200, 0.07);                                   // the walls fall open about their bottom edges
    for (const [a0, b0, a1, b1, ax_, sg] of [[-L, -w, L, -w + t, 'x', -1], [-L, w - t, L, w, 'x', 1], [-L, -w, -L + t, w, 'z', -1], [L - t, -w, L, w, 'z', 1]]) {
      const pv = new THREE.Group(); bed.add(pv);
      if (ax_ === 'x') { pv.position.set(0, y0, R(sg > 0 ? w : -w)); pv.rotation.x = sg * tw; }
      else { pv.position.set(X(sg > 0 ? L : -L), y0, 0); pv.rotation.z = -sg * tw; }
      const o = pv.position; boxAt(pv, topped(TC, G('#b48c58')), X(a0) - o.x, R(b0) - o.z, X(a1) - o.x, R(b1) - o.z, 0, y1 - y0, 'hull');
    }
    if (pose.load) { // a big fat sack heaped high over the rim (cartoon-big, as the loads), its neck tied off on top; it slumps out as the walls fall
      const sf = cl((age - 650) / 500), sk = new THREE.Group(); bed.add(sk);
      // widest at the rim, no wider than the bed's inside (so it only narrows below, clear of the walls), resting on the floor, heaped tall above
      const iL = L - t - 0.35, iW = w - t - 0.3, up = 7.4;
      sk.position.set(X(0) + X(7) * sf, y1 - (y1 - y0 - R(4)) * sf, R(3.5) * sf); sk.rotation.z = -0.5 * sf;
      blob(sk, G('#cdb98c'), 0, 0, 0, X(iL), R(up) * (1 - 0.2 * sf), R(iW));                           // the belly
      blob(sk, G('#cdb98c'), -R(0.5), R(up - 0.2), 0, R(2), R(2), R(1.8));                             // the gathered neck
      const tie = new THREE.Mesh(own(new THREE.TorusGeometry(R(1.7), R(0.45), 6, 14).rotateX(Math.PI / 2)), mat(G('#8b5a2b')));
      tie.position.set(-R(0.4), R(up - 1.2), 0); tie.userData.hullGeo = tie.geometry; sk.add(tie);      // the cord round it
      blob(sk, G('#cdb98c'), -R(0.7), R(up + 1.7), 0, R(1.4), R(1.3), R(1.5));                         // the tuft above the tie
    }
    for (const s of [-1, 1]) { // spoked wheels, each hinged at its outer rim: rolling alive, tipping off in the wreck
      const kk = s > 0 ? 1 : 0, tw2 = (Math.PI / 2) * fall(600 + kk * 70, 320) - bump(920 + kk * 70, 180, 0.08);
      const cz = s * R(w + 1.2), cy = R(WR), pv = new THREE.Group(); pv.position.set(0, 0, cz + s * R(0.6)); pv.rotation.x = s * tw2; g.add(pv);
      const wg = new THREE.Group(); wg.position.set(0, cy, -s * R(0.6)); wg.rotation.z = -(pose.roll || 0); pv.add(wg);
      const rim = new THREE.Mesh(own(new THREE.TorusGeometry(R(WR - 0.5), R(0.75), 6, 24)), mat(G('#5a4630'))); rim.userData.hullGeo = rim.geometry; wg.add(rim);
      wheel(wg, 0, 0, 0, R(1.6), R(1.5), G('#5a4630'), G('#74593a'));
      for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3, dx = Math.cos(a) * R(WR - 0.8), dy = Math.sin(a) * R(WR - 0.8); pole(wg, G('#74593a'), [-dx, -dy, 0], [dx, dy, 0], R(0.45)); }
    }
    // The ox (OX_PROFILE): heavy barrel, shoulder hump, stocky tube legs stepping
    // with the walk, the head low on a thick neck nodding, big horns, the yoke.
    const oxRoot = new THREE.Group(); oxRoot.position.set(X(L + 13), 0, 0); g.add(oxRoot);
    const K = 1.2, O = (x, y, z = 0) => [ax(x, K), chh(y, K), ar(z, K)], q = v => ar(v, K), coat = G('#8d6b47');
    const of = cl((age - 350) / 700), orot = Wr ? (Math.PI / 2.1) * (grey ? 1 : of * of) * (age > 1050 && age < 1350 && !grey ? 1 + 0.07 * Math.sin((age - 1050) / 300 * Math.PI) : 1) : 0;
    const ox = new THREE.Group(); oxRoot.add(ox); ox.rotation.x = -orot; ox.position.y = q(5.4) * Math.sin(Math.min(orot, Math.PI / 2)) * 0.9;
    // the ox's bones where its body came to rest: the roll onto its −z flank carries the barrel a body-height sideways (bearSkeleton's legs lie toward +z, as the rolled ox's)
    if (grey && Wr) { const sk = oxSkeleton(); sk.position.z = -chh(-6.5, K); oxRoot.add(sk); ox.visible = false; }
    const gait = pose.step != null ? horseGait('walk', pose.step) : { legs: [[0, 0], [0, 0], [0, 0], [0, 0]], bob: 0, nod: 0 };
    const B = gait.bob * 0.6, OB = (x, y, z = 0) => O(x, y - B, z);
    blob(ox, coat, ...OB(0, -6.5), q(8), q(5.4), q(5));                                  // heavy barrel
    blob(ox, coat, ...OB(3.5, -9.8), q(3.8), q(2.6), q(3.6));                            // shoulder hump
    [[-5, -2.6], [-4.4, 2.6], [4.4, -2.6], [5, 2.6]].forEach(([x, z], i) => { const [dx, lift] = gait.legs[i]; const d = dx * 1.3, hy = 3.6 - lift * 0.7; // a stride of ≈0.28 tiles a cycle: the hooves plant as the cart rolls
      // the leg (r 1.25) ends a little up inside the hoof, which is tall enough (±1) to hold its rounded end
      tube(ox, G('#705232'), OB(x, -5, z), O(x + 0.3 + d * 0.5, (-5 - B + hy) / 2, z), O(x + 0.3 + d, hy - 0.2, z), q(1.25));
      blob(ox, G('#241408'), ...O(x + 0.3 + d, hy + 0.35, z), q(1.55), q(1), q(1.4)); });
    const hd = new THREE.Group(); ox.add(hd); const pivot = OB(6, -8); hd.position.set(...pivot); hd.rotation.z = -(gait.nod || 0) - 0.3 * (Wr ? of : 0);
    const H = (x, y, z = 0) => { const p = OB(x, y, z); return [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]]; };
    tube(hd, coat, H(6, -8), H(9, -8.8), H(10.5, -6.5), q(2.6));                                     // thick neck sloping down
    blob(hd, coat, ...H(12, -5.8), q(3.4), q(3), q(3));                                             // head, low
    blob(hd, G('#5a3f28'), ...H(14.6, -4.3), q(1.9), q(1.7), q(2.2));                               // broad muzzle
    eyes(hd, ...H(12, -5.8), q(3.4), q(3), q(3), 0.55, 0.45, 0.75, q(0.5));
    for (const s of [-1, 1]) {
      tube(hd, G('#ece4cf'), H(11.2, -8.4, s * 1.8), H(11, -9.6, s * 5.8), H(10.6, -12.8, s * 6.6), q(0.75)); // horns: out, then up
      const e = blob(hd, coat, ...H(10.2, -7.2, s * 3.6), q(1.6), q(0.6), q(1)); e.rotation.x = s * 0.4;     // droopy ears
    }
    const sw = pose.tail || 0, tl = new THREE.Group(), root = OB(-7.6, -8); tl.position.set(...root); tl.rotation.set(0.5 * sw, 0, 0.15 * Math.abs(sw)); ox.add(tl); // the tail swishes from its root
    const T = (x, y) => { const p = OB(x, y); return [p[0] - root[0], p[1] - root[1], p[2] - root[2]]; };
    tube(tl, G('#5a3f28'), T(-7.6, -8), T(-9.2, -4), T(-8.6, -1), q(0.8)); blob(tl, G('#3a2818'), ...T(-8.6, -0.6), q(1), q(1.3), q(1)); // tail and its tuft
    // the yoke: a round rod lying on the neck's crest, forward of the hump (not through it), its bows down either side to the shafts
    const YX = 8.4, YY = -11.8;
    pole(ox, G(WOOD.beam), [ax(YX, K), chh(YY + B, K), -q(5.6)], [ax(YX, K), chh(YY + B, K), q(5.6)], q(0.8));
    for (const s of [-1, 1]) pole(ox, G(WOOD.beam), [ax(YX, K), chh(YY + B, K), s * q(5)], [ax(YX, K), chh(-6.2 + B, K), s * q(5)], q(0.5));
    // The shafts: from the bed's front corners to the foot of each bow, wherever the ox is (walking, falling).
    g.updateMatrixWorld(true);
    for (const s of [-1, 1]) {
      const a = bed.localToWorld(new THREE.Vector3(X(L), y0 + R(2.5), s * R(5))), b = ox.localToWorld(new THREE.Vector3(ax(YX, K), chh(-6.2 + B, K), s * q(5)));
      pole(g, G('#6e5138'), a.toArray(), b.toArray(), R(0.6));
    }
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
    if (kind === 'wood') for (const z of [-1.7, 1.7]) log(L, TREE_BARK, 0, K(z), K(13), K(1.9), true, 0, TREE_CUT);
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
  const splitPose = t => overheadPose(t, { top: 70, low: -30, R: 10, cock: 40, lead: -14 });  // a felled trunk: the axe brought straight down onto it
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
    else if (age >= DIE.land + 280 && age < DIE.land + 440) fall *= 1 - 0.022 * Math.sin((age - DIE.land - 280) / 160 * Math.PI); // and a smaller one
    const rest = s => [1, -2.4, s * 5.6], fling = s => [-1.5, -15.5, s * 8.6], limp = s => [2.2, -5, s * 6.4], trail = s => [-1.2, -17.5, s * 7.5], splay = s => [-1, -11.5, s * 10.5];
    const hand = s => mix(mix(mix(mix(rest(s), fling(s), hit), limp(s), buck), trail(s), u), splay(s), flop);
    return { fall, hands: [hand(-1), hand(1)], headYaw: 0.7 * flop - 0.25 * Math.sin(Math.PI * u),
      torso: { yaw: 0.12 * hit * (1 - u) + 0.35 * Math.sin(Math.PI * u), lean: -0.35 * hit * (1 - buck) + 0.3 * buck * (1 - u), dip: 3 * buck * (1 - u * u) + 0.3 * u }, // twisting as he goes over
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
  const DIE_LAB = { skel: 4800, life: 8000 };
  // A dropped weapon or tool (death): built upright on its base at the origin,
  // it leaves the hand, tips over sideways as it falls (accelerating), clatters
  // with a small bounce and lies flat. `fall`: the world direction it topples.
  // Tossed out to the side it's held on (`fall`), it spins a little in the air and clatters flat, clear of the body.
  const DROP_FALL = [0.3, 0, 0.95];
  function droppedItem(g, age, from, build, fall = DROP_FALL, travel = 0.24){
    const u = Math.max(0, Math.min(1, (age - 120) / 560)), bounce = age > 680 && age < 920 ? 1 - 0.07 * Math.sin((age - 680) / 240 * Math.PI) : 1;
    const it = new THREE.Group(); g.add(it); build(it, [fall[2], 0, -fall[0]]);
    const tip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(fall[2], 0, -fall[0]), (Math.PI / 2) * u ** 1.5 * bounce);
    it.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.9 * u).multiply(tip);          // the spin about the vertical keeps the landing flat
    const f0 = at(...from); it.position.set(f0[0] + fall[0] * travel * u, f0[1] + (ar(0.9) - f0[1]) * u * u + 0.1 * 4 * u * (1 - u), f0[2] + fall[2] * travel * u);
    return it;
  }  // the lab's compressed timeline (the game: CORPSE_SKEL / CORPSE_LIFE)
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
  // ---- Military (foot): militia, spearman, archer ----
  // Gear by age and the Blacksmith lines, as unitEquipment decides it in 2D:
  // helmet and shield by age; the torso by the armor line (tunic → scale →
  // chain); weapon steel by the attack line; the archer's fletching pin and
  // Castle-age quiver.
  const FORGE = ['#8f8a7d', '#a8adb3', '#c6cdd8'];
  function soldierEquip(ut, age, atk, arm, fletch){
    const v = { metal: FORGE[atk], weapon: atk, torso: arm >= 2 ? 'chain' : arm >= 1 ? 'scale' : null, helmet: 'hood', shield: null, feather: false, quiver: false };
    if (ut === 'militia') { v.helmet = age >= 2 ? 'norman' : age === 1 ? 'kettle' : 'hood'; v.shield = age >= 2 ? 'kite' : age === 1 ? 'round' : null; }
    if (ut === 'spearman') v.helmet = age >= 2 ? 'norman' : 'kettle';
    if (ut === 'archer') { v.feather = fletch; v.quiver = age >= 2; }
    if (ut === 'scout' || ut === 'knight') { v.helmet = ut === 'knight' ? 'great' : age >= 2 ? 'spiked' : 'hood'; v.shield = ut === 'knight' ? 'kite' : age >= 2 ? 'round' : null; }
    return v;
  }
  // Armor worn over the tunic, painted on the torso: overlapping scale rows or a ring mesh, in the forge's steel.
  // The 2D armor read (drawBodyLayer): SCALE is forge-steel scallop rows over
  // the lower torso under a hard edge, the shoulders and chest left team colour;
  // CHAIN is light steel over the whole torso, finer rows, a faint team wash.
  // Canvas top = the sphere's top (SphereGeometry uv), so the rows are bands.
  const armorMats = new Map(), tcSwaps = new Map(); // tcSwaps: team-coloured materials → a maker for any team (cached poses swap them)
  const lightOf = hex => { const n = parseInt(hex.slice(1), 16), f = v => Math.round(v + (255 - v) * 0.45); // teamColorLight's mix toward white
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(v => f(v).toString(16).padStart(2, '0')).join(''); };
  function armorMat(kind, metal, tc){
    const key = kind + metal + tc; let m = armorMats.get(key);
    if (!m) {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c = cv.getContext('2d');
      const row = (y0, n, r, dx, col) => { c.strokeStyle = col; c.lineWidth = 1.3; for (let i = 0; i < n; i++) for (let x = (i % 2) * dx / 2 - dx; x < 70; x += dx) { c.beginPath(); c.arc(x, y0 + i * r * 1.45, r, 0, Math.PI); c.stroke(); } };
      if (kind === 'scale') {
        c.fillStyle = tc; c.fillRect(0, 0, 64, 64);
        c.fillStyle = metal; c.fillRect(0, 30, 64, 34);
        row(31, 6, 3.2, 6.4, 'rgba(0,0,0,0.4)');
        c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(0, 29, 64, 1.6);          // the hard upper edge: a piece, not a stain
      } else {
        c.fillStyle = '#dde3ea'; c.fillRect(0, 0, 64, 64);
        c.globalAlpha = 0.2; c.fillStyle = tc; c.fillRect(0, 0, 64, 64); c.globalAlpha = 1;
        row(2, 22, 2.1, 4.2, 'rgba(0,0,0,0.33)');
      }
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.wrapS = THREE.RepeatWrapping; tex.repeat.set(3, 1);
      m = new THREE.MeshLambertMaterial({ map: tex }); armorMats.set(key, m); tcSwaps.set(m, t => armorMat(kind, metal, t));
    }
    return m;
  }
  // A bow in the hand with its string drawn to `pull` (or resting straight):
  // two limbs curving back from the grip to the tips, the string tip → pull → tip.
  function drawnBow(g, grip, pull, draw){
    const G = V3(grip), up = new THREE.Vector3(0, 1, 0), back = V3(pull).sub(G).setY(0); if (back.lengthSq() < 1e-8) back.set(-1, 0, 0); back.normalize();
    const L = ar(10.6), bend = ar(2.2 + 1.8 * draw), tips = [1, -1].map(s => G.clone().addScaledVector(up, s * L).addScaledVector(back, bend));
    for (const tp of tips) tube(g, '#b3874a', G.toArray(), G.clone().lerp(tp, 0.5).addScaledVector(back, -ar(1.2)).toArray(), tp.toArray(), ar(0.75));
    const P = tips[0].clone().lerp(tips[1], 0.5).lerp(V3(pull), Math.min(1, Math.max(0, draw) / 0.15)); // (eased onto the hand as the draw starts, not snapped)
    for (const tp of tips) pole(g, '#e8e8e8', tp.toArray(), P.toArray(), ar(0.22), 'line');
    return { tips, P };
  }
  function arrowAt(g, nock, dir, fletched, tc){ // an arrow from the nock along dir: shaft, light-steel head, and (Fletching) two light-team vanes
    const N = V3(nock), d = V3(dir).normalize(), tip = N.clone().addScaledVector(d, ar(15));
    pole(g, '#8b6a3a', N.toArray(), tip.toArray(), ar(0.35), 'line');
    const h = new THREE.Mesh(own(new THREE.ConeGeometry(ar(0.9), ar(2.4), 4)), mat('#dde3ea')); h.position.copy(tip); h.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d); h.userData.hullGeo = h.geometry; h.userData.hullW = HULL * 0.4; g.add(h);
    if (!fletched) return;
    const f = new THREE.Group(); f.position.copy(N); f.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), d); g.add(f);
    const sh = new THREE.Shape([[4.6, 0.3], [1.2, 2.4], [-1.6, 2.4], [-0.4, 0.3]].map(([x, y]) => new THREE.Vector2(ar(x), ar(y)))); // hugging the shaft, swept back from the front
    const vg = own(new THREE.ExtrudeGeometry(sh, { depth: ar(0.15), bevelEnabled: false }).translate(0, 0, -ar(0.075)));
    for (const [rx, sy] of [[0, 1], [0, -1], [Math.PI / 2, 1], [Math.PI / 2, -1]]) { const v = new THREE.Mesh(vg, mat(lightOf(tc))); v.rotation.x = rx; v.scale.y = sy; v.userData.hullGeo = vg; v.userData.hullW = HULL * 0.25; f.add(v); }
  }
  function spearAt(g, hand, dir, metal){ // shaft through the hand along dir (9px behind, 16 ahead), a steel point
    const h = V3(hand), d = V3(dir).normalize();
    pole(g, '#8B4513', h.clone().addScaledVector(d, -ar(9)).toArray(), h.clone().addScaledVector(d, ar(16)).toArray(), ar(0.8));
    const tip = new THREE.Mesh(own(new THREE.ConeGeometry(ar(1.5), ar(5), 4)), mat(metal)); tip.position.copy(h).addScaledVector(d, ar(18.5)); tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d); tip.userData.hullGeo = tip.geometry; g.add(tip);
  }
  function quiver(g, tc, fletched){ // on the back, slung from the right shoulder: a leather tube, fletchings showing
    const q = new THREE.Group(); q.position.set(...at(-4.2, -9, 1.5)); q.rotation.set(0.35, 0, -0.25); g.add(q);
    tube(q, '#7a5230', [0, -ar(4), 0], [0, 0, 0], [0, ar(4), 0], ar(1.5));
    for (const z of [-0.8, 0.8]) { pole(q, '#8b6a3a', [0, ar(3.6), ar(z)], [0, ar(5.6 + z * 0.25), ar(z)], ar(0.35), 'line'); if (fletched) blob(q, lightOf(tc), 0, ar(5.6 + z * 0.25), ar(z), ar(0.9)); } // shafts peeking out; the tech's light-team fletching
  }
  const mixP = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
  // A sword swing through key poses [phase, hand, blade dir, the way its edge faces (null: as the sword sits unkeyed, so
  // a rest pose matches the idle one)] at t: each edge squared to its blade and chained to agree with the one before (a
  // blade looks the same turned over, so it never rolls through a half turn between two poses).
  const restEdge = dir => new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), V3(dir).normalize()));
  function swingPose(K, t){
    // (compared with the one before carried along the blade's own swing: a cut turns its edge with it, forward to down)
    let prev = null, pd = null; const E = K.map(k => { const d = V3(k[2]).normalize(), e = k[3] ? V3(k[3]) : restEdge(k[2]);
      e.addScaledVector(d, -e.dot(d)).normalize();
      if (prev && e.dot(prev.clone().applyQuaternion(new THREE.Quaternion().setFromUnitVectors(pd, d))) < 0) e.negate();
      prev = e; pd = d; return e.toArray(); });
    let i = 0; while (i < K.length - 2 && t > K[i + 1][0]) i++;
    const u = easeC(Math.max(0, Math.min(1, (t - K[i][0]) / (K[i + 1][0] - K[i][0]))));
    return { hand: mixP(K[i][1], K[i + 1][1], u), dir: mixP(K[i][2], K[i + 1][2], u), edge: mixP(E[i], E[i + 1], u) };
  }
  const along = (p, d, k) => { const L = Math.hypot(...d); return [p[0] + d[0] / L * k, p[1] - d[1] / L * k, p[2] + d[2] / L * k]; }; // art pt + k px along a world-style dir
  // Poses by unit and action: { hands, torso, headYaw, feet, weapon: {...} }.
  function militiaPose(kind, t, eq){
    const two = !eq.shield, shieldHand = [5.6, -6.6, -6.4]; // out from the body and below the chin, so a turning head clears the shield's top
    if (kind === 'attack') { // a diagonal cut: from guard the blade is laid back over the right shoulder (the
      // torso turned away), then driven down across the front to the low left with a step in, followed through, and recovered to guard
      const K = [ // [phase, hand, blade dir (world-style, y up), the way its edge faces: where the blade is heading]
        [0.00, [7.5, -6.5, 1.5], [0.75, 0.66, 0], null],                   // guard (as it stands)
        [0.2, [5.2, -10.5, two ? 5 : 6.8], [0.25, 0.92, 0.3], [-0.9, -0.4, 0.2]],     // raised up the sword side, the blade clear of the chest
        [0.42, [-0.5, -14, 6.4], [-0.75, 0.35, 0.45], [0.3, 0.9, -0.2]],   // wound up: blade back over the shoulder, edge up for the stroke
        [0.50, [2.5, -15.5, 5], [-0.1, 0.99, 0.15], [1, 0.1, -0.2]],       // coming over, edge leading forward
        [0.60, [8.8, -8, 0.5], [0.95, -0.1, -0.3], [0.05, -1, -0.3]],      // the cut, at full extension: edge down into it
        two ? [0.70, [7.8, -5, -4.6], [0.5, -0.3, -0.8], [-0.45, -0.2, -0.5]]      // followed through low across the body (the blade kept off the ground)
            : [0.70, [7.6, -4.6, 1], [0.7, -0.35, -0.25], [-0.25, -0.25, 0.05]],   // with a shield: finished low in front, clear of the shield arm
        [1.00, [7.5, -6.5, 1.5], [0.75, 0.66, 0], null]];                  // back to guard
      const { hand, dir, edge } = swingPose(K, t);
      const wind = t < 0.42 ? easeC(t / 0.42) : t < 0.6 ? 1 - easeC((t - 0.42) / 0.18) : 0, cut = t >= 0.5 && t < 0.72 ? Math.sin(Math.PI * (t - 0.5) / 0.22) : 0, rec = t >= 0.72 ? easeC((t - 0.72) / 0.28) : 0;
      const follow = t >= 0.6 ? Math.min(1, (t - 0.6) / 0.1) * (1 - rec) : 0; // the turn builds through the follow-through
      return { hands: two ? [along(hand, dir, -2), hand] : [shieldHand, hand], weapon: { hand, dir, edge },
        // with a shield up the cut is tighter (less turn and lean), or the head swings into its top edge
        torso: { yaw: (two ? -0.12 : 0) - (two ? 0.8 : 0.5) * wind + (two ? 0.85 : 0.22) * follow, lean: -0.12 * wind + (two ? 0.3 : 0.16) * cut + (two ? 0.15 : 0.05) * follow, dip: (two ? 1.2 : 0.7) * cut },
        headYaw: 0.35 * wind - 0.3 * follow, feet: [[1.2 + 1.8 * (cut + follow * 0.6), 0], [-1.5, 0.4 * wind]], shieldHand };
    }
    const walk = kind === 'walk' ? walkPose(t) : null, L = carryLife(kind, t);
    const hand = addP(two ? [7.6, -6.2, 0.4] : [5.8, -6.4, 4.6], L.d), dir = two ? [0.72, 0.68 + L.tilt, 0] : [0.45 + L.tilt, 0.88, 0.1];
    const hands = two ? [along(hand, dir, -2), hand] : [walk ? walk.hands[0] : shieldHand, hand];
    if (eq.shield) hands[0] = addP(shieldHand, [0, L.d[1] * 0.8, 0]);
    const it = idlePose(t).torso; // two-handed: the body turned a little toward the sword side, so the far arm reaches round the chest
    return { hands, weapon: { hand, dir }, torso: two ? { ...it, yaw: it.yaw - 0.12 } : it, headYaw: kind === 'idle' ? idlePose(t).headYaw * 0.5 : 0, feet: walk ? walk.feet : L.feet, bob: walk ? walk.bob : 0, shieldHand: hands[0] };
  }
  function spearmanPose(kind, t, eq){
    if (kind === 'attack') { // spear levelled, driven forward in a lunge and drawn back
      const th = t < 0.3 ? easeC(t / 0.3) * 0.25 : t < 0.5 ? 0.25 - 1.25 * easeC((t - 0.3) / 0.2) : -1 + easeC((t - 0.5) / 0.5);
      const d = -th * 6, dir = [1, 0.06, -0.24];                                               // + forward: a deep thrust
      const rear = [2 + d, -7.2, 5], front = [6.4 + d, -8.2, 3.6];            // the shaft held out past the hip, angled in toward the target
      const lunge = Math.max(0, -th);
      return { hands: [front, rear], weapon: { hand: rear, dir }, torso: { yaw: -0.5 + 0.2 * lunge - 0.15 * Math.max(0, th) * 4, lean: 0.08 + 0.5 * lunge, dip: 1.8 * lunge }, headYaw: 0.2, feet: [[2 + 3.2 * lunge, 0.6 * Math.max(0, Math.sin(Math.PI * lunge))], [-1.8 - 0.6 * lunge, 0]] };
    }
    const walk = kind === 'walk' ? walkPose(t) : null, L = carryLife(kind, t), hand = addP([5, -6.5, 3.6], L.d), dir = [0.3 + L.tilt, 0.95, 0]; // the spear tip sways with the step
    return { hands: [walk ? walk.hands[0] : [1, -2.4, -5.6], hand], weapon: { hand, dir }, torso: idlePose(t).torso, headYaw: kind === 'idle' ? idlePose(t).headYaw * 0.5 : 0, feet: walk ? walk.feet : L.feet, bob: walk ? walk.bob : 0 };
  }
  function archerPose(kind, t, eq){
    if (kind === 'attack') { // side-on: the bow arm out, nock, draw to the cheek, hold, loose (the string hand flicks back), recover
      // anchored at the outside of the cheek (the head's a sphere), and the bow straight out AHEAD of that anchor: the arrow
      // between them lies along the facing — the way the loosed one flies (bow off to the side, it pointed ~40° astray)
      const bowH = [9.6, -12, 3.6], nock = [5.8, -12.6, 3.9], cheek = [2.6, -12.2, 4.2], after = [0.4, -11.6, 6];
      const draw = t < 0.15 ? 0 : t < 0.55 ? easeC((t - 0.15) / 0.4) : t < 0.75 ? 1 : 0;
      const loose = t >= 0.75 ? Math.max(0, 1 - (t - 0.75) / 0.12) : 0;                    // the snap after the release
      // after the loose the string hand fetches the next arrow — over the shoulder from the Castle quiver, else from the hip — and nocks it
      const src = eq.quiver ? [-2.2, -16.8, 3.2] : [0.6, -2.8, 6.4];
      let hand = t < 0.75 ? mixP(nock, cheek, draw) : t < 0.85 ? mixP(after, cheek, loose) : t < 0.92 ? mixP(after, src, easeC((t - 0.85) / 0.07)) : mixP(src, nock, easeC((t - 0.92) / 0.08));
      bowH[1] -= 0.8 * Math.sin(Math.PI * Math.min(1, (t - 0.75) / 0.12)) * (t >= 0.75 && t < 0.87 ? 1 : 0); bowH[0] += 0.6 * loose * (t >= 0.75 ? 1 : 0); // the bow arm kicks
      // aimed up along the flight the arrow takes (ARROW_LAUNCH): the draw pitched about the shoulder, so the nocked
      // arrow points the way the loosed one flies
      const aimed = q => { const dx = q[0] - 2.2, u = -(q[1] + 13), c = Math.cos(ARROW_LAUNCH), sn = Math.sin(ARROW_LAUNCH);
        return [2.2 + dx * c - u * sn, -13 - (dx * sn + u * c), q[2]]; };
      const bh = aimed(bowH); hand = aimed(hand);
      bowH[0] = bh[0]; bowH[1] = bh[1];
      return { hands: [bowH, hand], bow: { grip: bowH, pull: hand, draw, arrow: t < 0.75, fetched: t >= 0.92 }, torso: { yaw: -0.75 - 0.1 * draw, lean: 0.05 - 0.08 * draw, dip: 0.3 + 0.3 * draw }, headYaw: 0.75 + 0.1 * draw, feet: [[1.8, 0], [-1.8, 0]] };
    }
    const walk = kind === 'walk' ? walkPose(t) : null, L = carryLife(kind, t), bowH = addP([3.2, -4.8, -5.8], L.d);
    return { hands: [bowH, walk ? walk.hands[1] : [1, -2.4, 5.6]], bow: { grip: bowH, pull: bowH, draw: 0, arrow: false }, torso: idlePose(t).torso, headYaw: kind === 'idle' ? idlePose(t).headYaw * 0.5 : 0, feet: walk ? walk.feet : L.feet, bob: walk ? walk.bob : 0 };
  }
  // Life at rest and on the march, shared: at rest the weight rolls from foot to
  // foot and the weapon hand drifts; marching, the carried hands bounce with each
  // step and swing a little with the stride.
  function carryLife(kind, t){
    const s = Math.sin(2 * Math.PI * t), c = Math.cos(2 * Math.PI * t);
    if (kind === 'walk') return { d: [0.35 * s, -0.55 * Math.abs(c), 0], tilt: 0.06 * s };
    return { d: [0.25 * s, 0.3 * Math.sin(4 * Math.PI * t), 0.15 * c], tilt: 0.04 * c, feet: [[0.4 + 0.45 * s, 0], [-0.3 + 0.45 * s, 0.15 * Math.max(0, -s)]] };
  }
  const addP = (a, d) => a.map((v, i) => v + d[i]);
  const SOLDIER_POSE = { militia: militiaPose, spearman: spearmanPose, archer: archerPose };
  // One posed foot soldier (lab + game). Death uses the villager's staged fall,
  // the weapon (and shield) dropped beside the body.
  function soldierFrame(g, body, ut, kind, t, eq, tc, opt){
    const hat = eq.helmet === 'hood' ? 'hood' : eq.helmet;
    // the plume flutters: swaying at rest, streaming back on the march, whipping as the arrow's loosed
    const fl = kind === 'walk' ? [0.45 + 0.15 * Math.sin(4 * Math.PI * t), 0.25 * Math.sin(2 * Math.PI * t)] : kind === 'attack' && t > 0.75 ? [0.2 + 0.45 * Math.exp(-(t - 0.75) * 12) * Math.sin((t - 0.75) * 60), 0.3 * Math.sin((t - 0.75) * 40)] : [0.14 * Math.sin(4 * Math.PI * t), 0.2 * Math.sin(2 * Math.PI * t + 1)];
    const dress = { hat, armor: eq.torso, metal: eq.metal, feather: eq.feather, flutter: fl };
    if (kind === 'die') {
      const age = t * DIE_LAB.life, { skel, life } = DIE_LAB;
      const tg = new THREE.Group(); tg.userData.fade = age < skel ? 1 : Math.max(0, Math.min(1, (life - age) / 1500)); g.add(tg);
      if (ut === 'militia') droppedItem(tg, age, [3, -6.5, 5.8], it => sword(it, [0, ar(2.7), 0], eq.weapon, [0, 1, 0]));
      if (ut === 'spearman') droppedItem(tg, age, [3, -6.5, 5.8], it => spearAt(it, [0, ar(9), 0], [0, 1, 0], eq.metal));
      if (ut === 'archer') droppedItem(tg, age, [3, -6.5, 5.8], (it, k) => drawnBow(it, [0, ar(10.6), 0], [k[0], ar(10.6), k[2]], 0)); // bent toward the tip axis: it lands flat on its side
      if (eq.shield) { const F = [0.25, 0, -0.97]; // off the shield arm to its own side; built face against the fall, so it lands face up
        droppedItem(tg, age, [4, -7, -6], it => { if (eq.shield === 'kite') kiteShield(it, [0, ar(8.5), 0], tc).rotation.y = Math.atan2(-F[0], -F[2]); else roundShield(it, [0, ar(4.8), 0], tc).rotation.y = Math.atan2(F[2], -F[0]); }, F, 0.2); }
      if (age < skel) { const p = villagerDeathPose(age); const pv = new THREE.Group(); pv.position.set(ax(-2.4), 0, 0); g.add(pv); pv.add(body); body.position.x = -ax(-2.4);
        pv.rotation.z = p.fall; human(body, tc, { ...dress, hands: p.hands, torso: p.torso, headYaw: p.headYaw, feet: p.feet }); }
      else { const sk = humanSkeleton(); sk.userData.fade = Math.max(0, Math.min(1, (life - age) / 1500)); g.add(sk); }
      return;
    }
    const p = SOLDIER_POSE[ut](kind, t, eq);
    if (p.bob) body.position.y = p.bob * UNIT_SCALE / PX;
    human(body, tc, { ...dress, hands: p.hands, torso: p.torso, headYaw: p.headYaw, feet: p.feet });
    if (ut === 'militia') { weaponTag(body, () => sword(body, at(...p.weapon.hand), eq.weapon, p.weapon.dir, p.weapon.edge));
      if (eq.shield === 'round') weaponTag(body, () => roundShield(body, at(p.shieldHand[0] + 1.2, p.shieldHand[1], p.shieldHand[2] - 0.5), tc));
      if (eq.shield === 'kite') weaponTag(body, () => kiteShield(body, at(p.shieldHand[0] + 1.4, p.shieldHand[1] + 1, p.shieldHand[2] + 0.4), tc)).rotation.y = Math.PI / 2 - 0.3; } // its face (the cross, +z) turned forward
    if (ut === 'spearman') weaponTag(body, () => spearAt(body, at(...p.weapon.hand), p.weapon.dir, eq.metal));
    if (ut === 'archer') { const b = weaponTag(body, () => drawnBow(body, at(...p.bow.grip), at(...p.bow.pull), p.bow.draw));
      if (p.bow.arrow) arrowAt(body, b.P.toArray(), V3(at(...p.bow.grip)).sub(b.P).toArray(), eq.feather, tc);
      else if (p.bow.fetched) arrowAt(body, at(...p.bow.pull), V3(at(...p.bow.grip)).sub(V3(at(...p.bow.pull))).toArray(), eq.feather, tc); // the next arrow, carried to the string
      if (eq.quiver) quiver(body, tc, eq.feather); }
  }
  // ---- Cavalry: scout, knight ----
  // Gaits in horseKit's leg order [hind −z, hind +z, fore −z, fore +z]: each leg
  // plants (its hoof sliding back under the moving body) then lifts and swings
  // forward. walk: four-beat, three feet down; gallop: the hinds then the fores
  // in quick pairs, a long reach, the body rocking and the head pumping.
  const GAITS = {
    walk:   { ph: [0, 0.5, 0.25, 0.75], stance: 0.72, S: 2.4, lift: 2.3, bob: 0.35, nod: 0.05 },
    gallop: { ph: [0, 0.1, 0.48, 0.58], stance: 0.42, S: 4.6, lift: 4.2, bob: 1.3, nod: 0.16 },
  };
  function horseGait(kind, t){
    const G = GAITS[kind], legs = G.ph.map(ph => { const u = ((t + ph) % 1 + 1) % 1;
      return u < G.stance ? [G.S * (1 - 2 * u / G.stance), 0] : [G.S * (-1 + 2 * (u - G.stance) / (1 - G.stance)), G.lift * Math.sin(Math.PI * (u - G.stance) / (1 - G.stance))]; });
    const c = Math.cos(2 * Math.PI * t * (kind === 'walk' ? 2 : 1));
    return { legs, bob: G.bob * (0.5 + 0.5 * c), nod: G.nod * c, tail: kind === 'gallop' ? 0.8 + 0.3 * c : 0.2 * c };
  }
  const HORSE_COAT = { scout: ['#8b5a2b', '#3f2810', '#6e4520'], knight: ['#e9e6de', '#9a948a', '#b3ada1', '#b8b2a6'] };
  // The rider's sword arm, by action: at rest the blade up by the neck; the
  // attack a cut raised high on the sword side and swept forward-down past the
  // horse's head (kept ≥5px out from the neck line), then recovered.
  function riderArm(kind, t){
    const rest = [[6.5, -7, 6], [0.5, 0.84, 0.2]], up = [[1.5, -16, 6.8], [-0.45, 0.88, 0.15]], cut = [[9.5, -8.5, 6.8], [0.93, -0.3, 0.2]];
    if (kind === 'die') return [[3.2, -6.5, 6.2], [-0.9, -0.25, 0.3]];   // limp: the sword trailing back from a slack hand
    if (kind !== 'attack') return rest;
    // the edge: forward over the top (where the cut goes), down through the cut
    const p = swingPose([[0, ...rest, null], [0.42, ...up, [0.9, 0.45, 0]], [0.58, ...cut, [-0.3, -0.95, 0]], [1, ...rest, null]], t);
    return [p.hand, p.dir, p.edge];
  }
  function riderFig(tc, eq, kind, t, gait = {}, bare = false){ // bare: no sword or shield (dropped) // rider()'s seat and kit, with gear by age and an animated sword arm
    const r = new THREE.Group(), side = eq.shield ? -1 : 1, [h, d, ed] = riderArm(kind, t);
    const jog = kind === 'gallop' ? 0.9 * Math.sin(2 * Math.PI * t) : kind === 'walk' ? 0.35 * Math.sin(4 * Math.PI * t) : 0; // the hands ride with the horse
    const hand = [h[0], h[1] + jog, side * h[2]], dir = [d[0], d[1], side * d[2]], edge = ed ? [ed[0], ed[1], side * ed[2]] : null;
    const off = eq.shield ? [1.5, -6.5 + jog * 0.6, 7.8] : [6 + 5 * (gait.nod || 0), -6.8 + jog * 0.6, -3.9]; // the rein hand follows the head                   // shield grip, or the reins (held out past the belly)
    const lean = kind === 'gallop' ? 0.12 : 0, sw = kind === 'attack' ? (t < 0.42 ? -0.2 * easeC(t / 0.42) : 0.25 * Math.sin(Math.PI * Math.min(1, (t - 0.42) / 0.3))) : 0;
    human(r, tc, { hat: eq.helmet, armor: eq.torso, metal: eq.metal, riding: true, hands: side > 0 ? [off, hand] : [hand, off], torso: { lean: lean + Math.max(0, sw), yaw: side * sw } });
    if (!bare) weaponTag(r, () => sword(r, at(...hand), eq.weapon, dir, edge));
    if (bare) {}
    else if (eq.shield === 'kite') kiteShield(r, at(1, -6.5, 9), tc).rotation.y = 0.35;
    if (eq.shield === 'round') roundShield(r, at(1, -6.5, 9), tc).rotation.y = Math.PI / 2 - 0.35;
    r.position.set(ax(-0.8), (20 - 6) * UNIT_SCALE / PX, 0);
    return r;
  }
  // The horse's bones (the bear's idiom, horse-long): a long skull on the neck
  // bones, the spine, three fat ribs, four long leg bones splayed flat.
  function horseSkeleton(){ // lying on its side (the corpse's roll): legs out to one side, ribs over the flank, the long skull on its side
    const g = new THREE.Group(), bone = '#e8e0cc', y = 0.06;
    pole(g, bone, [-0.42, y, 0], [0.3, y + 0.02, 0], 0.04);                                                // spine
    for (let i = 0; i < 3; i++) { const R = i === 1 ? 0.19 : 0.16, rib = new THREE.Mesh(own(new THREE.TorusGeometry(R, 0.035, 8, 14, Math.PI)), mat(bone));
      rib.position.set(-0.18 + i * 0.14, y, R * 0.9); rib.rotation.y = Math.PI / 2; rib.userData.hullGeo = rib.geometry; g.add(rib); }
    pole(g, bone, [0.3, y + 0.02, 0], [0.55, y + 0.04, 0.08], 0.035);                                     // neck bones
    blob(g, bone, 0.68, 0.09, 0.1, 0.16, 0.085, 0.08); blob(g, bone, 0.83, 0.07, 0.12, 0.07, 0.05, 0.05); // the long skull on its side, the muzzle
    blob(g, '#2a241c', 0.63, 0.165, 0.1, 0.04);                                                           // the upturned socket
    for (const [x, dx] of [[-0.4, -0.08], [-0.3, 0.02], [0.14, 0.06], [0.24, 0.14]]) cartoonBone(g, [x, 0.035, 0.1], [x + dx, 0.035, 0.55], 0.026); // legs out to the belly side
    return g;
  }
  function cavalryFrame(g, ut, kind, t, eq, tc){
    const [coat, mane, legC, muzzle] = HORSE_COAT[ut];
    if (kind === 'die') { // the horse stumbles (fore legs buckling, head dropping), rolls onto its side and kicks; the rider is thrown clear
      const age = t * DIE_LAB.life, { skel, life } = DIE_LAB, cl = v => Math.max(0, Math.min(1, v)), side = eq.shield ? -1 : 1;
      const h = chh(-6.2, 1.35), rideY = (20 - 6) * UNIT_SCALE / PX, land = [ax(-0.8) + 0.25, -0.72];   // barrel centre height; where the rider ends up
      const tg = new THREE.Group(); tg.userData.fade = age < skel ? 1 : cl((life - age) / 1500); g.add(tg);
      const wz = side * 6.8; // the sword hand's side
      droppedItem(tg, age, [6.5, -21, wz], it => sword(it, [0, ar(2.7), 0], eq.weapon, [0, 1, 0]), [0.2, 0, side * 0.98], 0.3);
      if (eq.shield) { const F = [0.2, 0, -0.98]; droppedItem(tg, age, [1, -20.5, 9], it => { if (eq.shield === 'kite') kiteShield(it, [0, ar(8.5), 0], tc).rotation.y = Math.atan2(-F[0], -F[2]); else roundShield(it, [0, ar(4.8), 0], tc).rotation.y = Math.atan2(F[2], -F[0]); }, [0.15, 0, 0.99], 0.35); }
      if (age < skel) {
        const st = easeC(age / 300), u = cl((age - 250) / 550);
        let rot = (Math.PI / 2.1) * u * u; if (age > 800 && age < 1100) rot *= 1 + 0.07 * Math.sin((age - 800) / 300 * Math.PI);
        const kick = age > 900 && age < 1700 ? Math.max(0, Math.sin((age - 900) / 110 * Math.PI)) * (1 - (age - 900) / 800) : 0;
        const roll = new THREE.Group(); g.add(roll); roll.rotation.set(-rot, 0, -0.2 * st * (1 - u));              // pitched nose-down in the stumble, then over onto its −z flank
        const pose = { legs: [0, 1, 2, 3].map(i => i < 2 ? [-2.2 * u, 1.4 * kick * (i ? 0.6 : 1)] : [-1.8 * st * (1 - u) + 2.2 * u, 1.8 * st * (1 - u)]), bob: -1.4 * st * (1 - u) - 0.8 * u, nod: 0.5 * st, tail: 0.4 * kick };
        horseKit(roll, coat, mane, legC, tc, muzzle || legC, pose);
        roll.position.y = 0.12 * Math.sin(Math.min(rot, Math.PI / 2));
        // The rider leaves the saddle as the horse goes down: an arc off its falling side, turning over to land on his back.
        const v = cl((age - 150) / 650), rf = riderFig(tc, eq, 'die', 0, {}, true); g.add(rf);
        let lie = (Math.PI / 2) * v ** 1.3; if (age > 800 && age < 1050) lie *= 1 - 0.06 * Math.sin((age - 800) / 250 * Math.PI);
        rf.position.set(ax(-0.8) + 0.25 * v, rideY * (1 - v) + 0.18 * Math.sin(Math.PI * v), land[1] * v); rf.rotation.x = -lie;
      } else { // the bones where the bodies came to rest: the horse's spine at its rolled barrel, the rider's along his landing line
        const f = cl((life - age) / 1500), hs = horseSkeleton(), rs = humanSkeleton();
        hs.userData.fade = f; rs.userData.fade = f; hs.position.z = -h; rs.position.set(land[0], 0, land[1]); rs.rotation.y = -Math.PI / 2; g.add(hs); g.add(rs);
      }
      return;
    }
    const sn = Math.sin(2 * Math.PI * t);
    const gait = kind === 'walk' || kind === 'gallop' ? horseGait(kind, t)
      : kind === 'attack' ? { legs: [[0, 0], [0, 0], [0.8, 1.3 * Math.max(0, sn)], [0.8, 1.3 * Math.max(0, -sn)]], bob: 0.3 * Math.abs(sn), nod: 0.14 * Math.sin(Math.PI * t), tail: 0.3 * sn } // prancing on the spot, head tossing
      : { legs: [[0.5, 0.7], [0, 0], [0, 0], [0, 0]], bob: 0, nod: 0.12 + 0.06 * Math.sin(2 * Math.PI * t), tail: 0.35 * Math.sin(3 * 2 * Math.PI * t) * Math.max(0, Math.sin(2 * Math.PI * t)) }; // at rest: a hind hoof cocked, head low, the tail swishing now and then
    horseKit(g, coat, mane, legC, tc, muzzle || legC, gait);
    const r = riderFig(tc, eq, kind, t, gait); r.position.y += gait.bob * (kind === 'gallop' ? 0.55 : 0.85) * 1.35 * UNIT_SCALE / PX; g.add(r); // the rider absorbs part of the horse's rise
  }
  // Dev check: weapons against bodies over every soldier action. Every mesh a
  // weapon or shield builder adds is sampled against the body ellipsoids (torso,
  // head, horse barrel and head — blobs, so a unit sphere in their own frame);
  // depth in art px, > 0 = through. Returns the worst per unit/action.
  const weaponTag = (g, fn) => { const n = g.children.length; const r = fn(); for (let i = n; i < g.children.length; i++) g.children[i].traverse(o => { o.userData.weapon = true; }); return r; };
  window.__povClashCheck = (units = ['militia', 'spearman', 'archer', 'scout', 'knight']) => {
    const out = [], v = new THREE.Vector3(), inv = new THREE.Matrix4();
    for (const u of units) for (const [age, label] of [[0, 'dark'], [2, 'castle']]) {
      const eq = soldierEquip(u, age, 2, 2, true);
      for (const k of window.__pov3dLab.unitKinds[u]) { if (k === 'die') continue;
        let worst = 0, at_ = 0, what = '';
        for (let i = 0; i < 24; i++) {
          const g = animFrame(k, i / 24, false, { unit: u, eq }); g.updateMatrixWorld(true);
          const bodies = [], weps = []; g.traverse(o => { if (o.isMesh && o.userData.body) bodies.push(o); else if (o.isMesh && o.userData.weapon && !HULL_MATS.has(o.material)) weps.push(o); });
          for (const w of weps) { const P = w.geometry.attributes.position; for (let j = 0; j < P.count; j += 3) {
            v.fromBufferAttribute(P, j).applyMatrix4(w.matrixWorld);
            for (const b of bodies) { inv.copy(b.matrixWorld).invert(); const l = v.clone().applyMatrix4(inv).length();
              if (l < 1) { const d = (1 - l) * Math.min(b.scale.x, b.scale.y, b.scale.z) / (UNIT_SCALE / PX); if (d > worst) { worst = d; at_ = i / 24; what = b.userData.body + ' (' + w.geometry.type + ')'; } } } } }
          window.__pov3dLab.dispose(g);
        }
        out.push((u + ' ' + label + ' ' + k).padEnd(22) + (worst > 0.05 ? worst.toFixed(2) + ' px into ' + what + ' at t=' + at_.toFixed(2) : 'clear'));
      }
    }
    return out.join('\n');
  };
  // Dev check: how deep each arm sinks into the torso over every lab action.
  // The arm is the rig's own curve (shoulder → bend → hand, in the torso's
  // frame), skipping its root inside the shoulder; the torso the body ellipsoid
  // (the dress's rough hull for her). Gap in art px, < 0 = through the body.
  window.__povArmCheck = (kinds, female, opt = {}) => {
    const out = [];
    for (const k of kinds) {
      let worst = Infinity, at_ = 0, side = 0, info = '', dmin = Infinity, dmax = 0;
      for (let i = 0; i < 40; i++) {
        armProbe = []; animFrame(k, i / 40, female, opt); const arms = armProbe; armProbe = null;
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
    const LD = opt.load || 'wood', HELD = opt.tool, UP = opt.up || {};   // options: the load carried, the tool in hand, tool upgrades (double, bright)
    const g = new THREE.Group(), body = new THREE.Group(), tc = '#2d6bd1', who = female ? { hat: 'long', dress: 'tunic' } : { hat: 'hair' }; g.add(body);
    if (opt.unit === 'tradecart') { const cl = v => Math.max(0, Math.min(1, v)); let pose = { load: opt.load !== false };
      pose.tail = 0.7 * Math.sin(2 * Math.PI * t) * Math.max(0, Math.sin(Math.PI * t * 1)) + 0.25 * Math.sin(6 * Math.PI * t); // a lazy swish, now and then a flick
      if (kind === 'walk') pose = { ...pose, roll: 2 * Math.PI * t / 6, step: t, tail: 0.35 * Math.sin(4 * Math.PI * t) }; // one ox stride = a sixth of a wheel turn (its three spokes repeat every 60°)
      if (kind === 'die') { const age = t * DIE_LAB.life; g.add(cartModel(tc, { load: opt.load !== false, wreck: { age, weathered: age >= DIE_LAB.skel } })); g.userData.fade = age < DIE_LAB.skel ? 1 : cl((DIE_LAB.life - age) / 1500); // the sack spills only if it died loaded
        addHulls(g, true); fadeTo(g, g.userData.fade); return g; }
      g.add(cartModel(tc, pose)); addHulls(g, true); return g; }
    if (opt.unit === 'ram') { const cl = v => Math.max(0, Math.min(1, v)), sn = Math.sin(2 * Math.PI * t); let pose = {};
      if (kind === 'walk') pose = { roll: 2 * Math.PI * t, shake: 0.35 * Math.abs(Math.sin(3 * Math.PI * t)), log: 0.5 * sn };    // wheels turning, bumping along
      if (kind === 'attack') { const back = t < 0.55 ? -6 * easeC(t / 0.55) : t < 0.63 ? -6 + 10 * easeC((t - 0.55) / 0.08) : 4 * (1 - easeC((t - 0.63) / 0.37)); // hauled back, slammed, recovering
        const hit = t >= 0.63 ? Math.exp(-(t - 0.63) * 18) : 0; pose = { log: back, shake: 0.5 * hit * Math.sin((t - 0.63) * 90), pitch: -0.04 * hit }; }
      if (kind === 'die') { const age = t * DIE_LAB.life; // it collapses (ramModel's wreck), weathers grey at the bones stage and fades
        g.add(ramModel(tc, { wreck: { age, weathered: age >= DIE_LAB.skel } })); g.userData.fade = age < DIE_LAB.skel ? 1 : cl((DIE_LAB.life - age) / 1500);
        addHulls(g, true); fadeTo(g, g.userData.fade); return g; }
      g.add(ramModel(tc, pose)); addHulls(g, true); g.traverse(o => { if (o.userData.fade != null) fadeTo(o, o.userData.fade); }); return g; }
    if (opt.unit && HORSE_COAT[opt.unit]) { cavalryFrame(g, opt.unit, kind, t, opt.eq || soldierEquip(opt.unit, 0, 0, 0, false), tc);
      addHulls(g, true); g.traverse(o => { if (o.userData.fade != null) fadeTo(o, o.userData.fade); }); return g; }
    if (opt.unit && SOLDIER_POSE[opt.unit]) { const eq = opt.eq || soldierEquip(opt.unit, 0, 0, 0, false); soldierFrame(g, body, opt.unit, kind, t, eq, tc, opt);
      addHulls(g, true); g.traverse(o => { if (o.userData.fade != null) fadeTo(o, o.userData.fade); }); return g; }
    const person = p => human(body, tc, { ...who, hands: p.hands, elbows: p.elbows, torso: p.torso, headYaw: p.headYaw, feet: p.feet });
    if (kind === 'walk' || kind === 'barrow' || kind === 'plow') { const p = walkPose(kind === 'plow' ? t : t); body.position.y = p.bob * UNIT_SCALE / PX;
      const push = kind !== 'walk', grips = [[6.5, -6.5, -3.9], [6.5, -6.5, 3.9]];
      // Walking with a tool: it rests on the right shoulder, held near the butt, the head behind; the other arm swings.
      const shoulder = kind === 'walk' && HELD, sh = [2.4, -9.2, 5.3];
      human(body, tc, { ...who, feet: p.feet, hands: push ? grips : shoulder ? [p.hands[0], sh] : p.hands, torso: kind === 'plow' ? { lean: 0.14 } : undefined });
      if (shoulder) tool(body, HELD, at(...sh), [-0.62, 0.76, 0.14], { out: 4.4 }, [0, 0.3, 1]);
      if (push) { const r = barrowRig(g, kind, kind === 'barrow' && opt.load !== null ? LD : null); r.position.set(ax(4.7), body.position.y * 0.5, 0); } } // its grips out in front of the belly; load null: it rolls back empty
    if (kind === 'chop') { const p = chopPose(t); person(p); tool(body, 'axe', at(...p.grip), p.dir, { out: GRIP_OUT, double: UP.double }, p.edge); }
    const work = { mine: ['pick', minePose], split: ['axe', splitPose], build: ['mallet', buildPose], farm: ['scythe', mowPose] }[kind];
    if (work) { const p = work[1](t); person(p); tool(body, work[0], at(...p.grip), p.dir, { out: GRIP_OUT, mow: kind === 'farm', bright: UP.bright, double: UP.double }, p.edge); }
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
    if (kind === 'drop') { const p = dropPose(t, LD); person(p);
      if (!(opt.noFly && t >= REL)) { const L = load(p.landed ? g : body, LD, at(p.load.x, p.load.y)); L.rotation.z = -p.load.pitch; } } // noFly: the game flies its own load to the building
    if (kind === 'idle') person(idlePose(t));
    if (kind === 'flee') { const p = runPose(t); body.position.y = p.bob * UNIT_SCALE / PX; person(p); }
    if (kind === 'die') { const age = t * DIE_LAB.life, { skel, life } = DIE_LAB;
      const pool = Math.max(0, Math.min(1, (age - DIE.land * 0.8) / 2000)), dry = Math.min(1, age / skel);
      if (pool > 0 && !opt.noBlood) { // the blood pool under the torso (the game draws its own): spreading (ease-out), drying brown
        const r = ar(8.5) * (1 - (1 - pool) ** 2), m = new THREE.Mesh(own(new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ color: new THREE.Color('#6b0f0f').lerp(new THREE.Color('#4a2a1a'), dry) }));
        m.scale.set(r * 1.3, 1, r); m.position.set(ax(-12), 0.002, 0); g.add(m);
        const fade = Math.max(0, Math.min(1, (life - age) / 1500)); if (fade < 1) { m.material.transparent = true; m.material.opacity = fade; } }
      if (HELD) { // the tool leaves the hand at the blow: falls, tumbling over to lie flat beside him, a small clatter
        const tg = new THREE.Group(); tg.userData.fade = age < skel ? 1 : Math.max(0, Math.min(1, (life - age) / 1500)); g.add(tg);
        droppedItem(tg, age, [3, -6.5, 5.8], (it, k) => tool(it, HELD, [0, ar((HELD === 'scythe' ? 17 : 13) * 0.45), 0], [0, 1, 0], {}, k)); } // its head's flat side down
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
    unitKinds: { villager: null, militia: ['idle', 'walk', 'attack', 'die'], spearman: ['idle', 'walk', 'attack', 'die'], archer: ['idle', 'walk', 'attack', 'die'], scout: ['idle', 'walk', 'gallop', 'attack', 'die'], knight: ['idle', 'walk', 'gallop', 'attack', 'die'], ram: ['idle', 'walk', 'attack', 'die'], tradecart: ['idle', 'walk', 'die'] },
    equip: soldierEquip,
    // Animals: built once, posed live by animateAnimal from a stand-in entity (their game path), one action at phase t.
    animals: { sheep: ['idle', 'walk', 'graze', 'die'], bear: ['idle', 'walk', 'attack', 'die'], dragon: ['sleep', 'idle', 'walk', 'roar', 'breathe', 'die'] },
    animal: kind => { const g = ANIMAL_MODELS[kind](VIL_TC); addHulls(g, true); return g; },
    poseAnimal: (g, kind, action, t) => {
      g.position.set(0, 0, 0); g.rotation.set(0, 0, 0);
      if (action === 'die') { if (kind === 'dragon') dragonDeath(g, t * 3000); else deathPose(g, kind, t * 3000); return; }
      const walk = action === 'walk', att = action === 'attack' || action === 'roar' || action === 'breathe';
      const e = { utype: kind, id: 1, awake: action !== 'sleep', path: walk ? [{ x: 0, y: 0 }] : [], target: att ? -1 : null, eatingGrass: action === 'graze',
        __animAttack: action === 'attack', atkCooldown: action === 'attack' ? UNITS[kind].rof * (1 - t) : 0, breathTick: action === 'breathe' ? tick - t * T30(22) : undefined };
      const a = g.userData.lab || (g.userData.lab = { phase: 0, gait: 0, graze: 0, lab: true });
      a.moved = walk ? 1e-3 : 0; a.phase = walk ? t * 2 * Math.PI : 0;
      if (kind === 'bear') { const now = performance.now(); const dt = a.lastNow ? Math.min(0.05, (now - a.lastNow) / 1000) : 1 / 60; a.lastNow = now;
        a.moved = 0; animateAnimal(g, e, a, dt); return; }                             // (real time: its breathing and eases; the phase drives the walk)
      if (kind !== 'dragon') { animateAnimal(g, e, a, 1); return; }                // dt 1: every ease snaps to the action
      // the dragon plays in real time (its springs and clocks need it): restarted on a new action, the phase driving
      // the walk, the roar and the breath (inhale over the first 40%, then the blast)
      const now = performance.now(), dt = a.lastNow ? Math.min(0.05, (now - a.lastNow) / 1000) : 1 / 60; a.lastNow = now;
      if (a.action !== action) { a.action = action; a.dr = null; a.sleep = undefined; a.gait = walk ? 1 : 0; }
      a.roarT = action === 'roar' ? t : undefined; a.noRoar = action !== 'roar';             // (the lab plays one thing at a time)
      if (action === 'breathe') { const rof = UNITS.dragon.rof;
        if (t < 0.4) { e.atkCooldown = rof * 0.35 * (1 - t / 0.4); e.breathTick = undefined; } else { e.atkCooldown = rof; e.breathTick = tick - (t - 0.4) / 0.6 * T30(26); } }
      animateAnimal(g, e, a, dt);
    },
    // A building under construction at progress p (the game's constructionSite): { obj, set(p) }.
    building: (btype, age = 0) => { teamAge = teamAge || [0, 0]; teamAge[1] = age; const b = BLDGS[btype], g = new THREE.Group(), e = { id: -1, type: 'building', btype, x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h, team: 1, complete: false, hp: 1, maxHp: 1, buildProgress: 0, buildTime: 1, gateProgress: 0 };
      if (MODELS[btype]) { MODELS[btype](g, e); addHulls(g); return { obj: g, set: constructionSite(g, e.x, e.y, b.w, b.h, !OPEN_SITE.has(btype)).set }; }
      // a wall: a short run of three pieces (linked); a gate on its own
      const run = isGateBtype(btype) ? [{ ...e, x: -1.5, y: -0.5, w: 3, h: 1 }] : [-1, 0, 1].map(i => ({ ...e, id: -2 - i, x: i - 0.5, y: -0.5 })), at = (x, y) => run.find(p => p.x === x && p.y === y);
      const sets = run.map(p => { const o = wallModel(p, wallArms(p, at, n => true)).obj; g.add(o); return constructionSite(o, p.x, p.y, p.w, p.h, false).set; });
      return { obj: g, set: v => sets.forEach(f => f(v)) }; },
    // A finished building to damage (breaking down by health) and bring down.
    damaged: (btype, age = 0) => { teamAge = teamAge || [0, 0]; teamAge[1] = age; const b = BLDGS[btype], g = new THREE.Group();
      const e = { id: -1, type: 'building', btype, x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h, team: 1, complete: true, openTop: true, hp: 1, maxHp: 1, buildProgress: 1, buildTime: 1, gateProgress: 0 };
      if (MODELS[btype]) MODELS[btype](g, e); else if (isWallBtype(btype) || isGateBtype(btype)) g.add(wallModel(isGateBtype(btype) ? { ...e, x: -1.5, y: -0.5, w: 3, h: 1 } : { ...e, x: -0.5, y: -0.5, w: 1, h: 1 }, []).obj);
      addHulls(g); const d = buildingDamage(g, e.x, e.y, b.w, b.h);
      return { obj: g, setHp: f => d.set(f), collapse: () => d.collapse(), tick: dt => d.tick(dt), get shown(){ return d.shown; } }; },
    buildingTypes: [...Object.keys(MODELS), 'WALL', 'SWALL', 'GATE', 'SGATE'],
    kinds: ['idle', 'walk', 'flee', 'carry', 'barrow', 'chop', 'saw', 'mine', 'farm', 'plow', 'forage', 'butcher', 'build', 'repair', 'drop', 'fight', 'die'],
    frame: animFrame,
    check: () => window.__povAnimCheck(),
    dispose: g => { disposeFaded(g); g.traverse(o => { if (o.geometry && o.geometry.userData.own) o.geometry.dispose(); }); },
    // A tree for the chop: the trunk pivots at its base so it can shake, the
    // crown sways on top of it (the game tree's design: a round trunk, puffs).
    tree(){
      const k = 1.05, root = new THREE.Group(), sway = new THREE.Group(); root.add(sway);
      pole(sway, TREE_BARK, [0, 0, 0], [0, TREE_H * k, 0], TRUNK_R * k, 'post');
      const crown = new THREE.Group(); crown.position.y = TREE_H * k; sway.add(crown);
      ball(crown, '#4db536', 0, 0, 0, CROWN_R * k);
      for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + i * Math.PI / 2; ball(crown, '#4db536', Math.cos(a) * CROWN_R * 0.8 * k, -0.04 * CROWN_K, Math.sin(a) * CROWN_R * 0.8 * k, 9 / PX * CROWN_K * k); }
      addHulls(root, true);
      return { root, sway, crown, trunkR: TRUNK_R * k };
    },
    // Points along a tool's working head at phase t (world, relative to the
    // character): where the axe edge, pick tip, mallet face or scythe blade is.
    toolHead(kind, t){
      const P = { chop: chopPose, mine: minePose, split: splitPose, build: buildPose, farm: mowPose }[kind](t);
      const U = UNIT_SCALE / PX, d = V3(P.dir).normalize(), e = V3(P.edge).addScaledVector(d, -V3(P.edge).dot(d)).normalize();
      const base = V3(at(...P.grip)).addScaledVector(d, GRIP_OUT * U), top = (kind === 'farm' ? 17 : 13) * 0.55, pt = (lx, ly) => base.clone().addScaledVector(d, (top + ly) * U).addScaledVector(e, lx * U);
      if (kind === 'chop') return [pt(5, -1.5), pt(2.5, -1.5)];
      if (kind === 'mine') return [pt(4.6, -1.4)];
      if (kind === 'split') return [pt(5, -1.5)];
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
    log(){ const g = new THREE.Group(); pole(g, TREE_BARK, [0, 0, 0], [0, 0.4, 0], 2.2 * UNIT_SCALE / PX, 'post'); addHulls(g, true); return g; },
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
  const ANIMAL_MODELS = { sheep: sheepModel, sheep_carcass: sheepModel, bear: () => bearModel(), dragon: () => dragonModel() };
  // Death, as drawCorpse stages it: topple over the feet accelerating (600ms)
  // with a small impact recoil — here a roll onto the side about the body's
  // own axis, coming to rest lying on the ground, legs stiff and splayed,
  // head limp. half: how far the flank sits from the ground once down.
  const DEAD_HALF = { sheep: 0.19, bear: 0.27, dragon: 0.5 };
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
  // The ox's bones, sized from the ox itself (OX_PROFILE ×1.2: barrel ±8px long,
  // 5.4 tall; legs at ±4.4–5px; the head 12px ahead), lying on its side as the
  // rolled body did: legs out toward +z, ribs over the flank, the horned skull.
  function oxSkeleton(){
    const g = new THREE.Group(), bone = '#e8e0cc', K = 1.2, X = v => ax(v, K), Z = v => ar(v, K), y = Z(1.4);
    pole(g, bone, [X(-8.5), y, 0], [X(8), y + Z(0.3), 0], Z(1));                                      // spine
    for (const x of [-4, 0, 4]) { const R = Z(x ? 4.3 : 4.8), rib = new THREE.Mesh(own(new THREE.TorusGeometry(R, Z(0.9), 8, 14, Math.PI)), mat(bone));
      rib.position.set(X(x), y, R * 0.9); rib.rotation.y = Math.PI / 2; rib.userData.hullGeo = rib.geometry; g.add(rib); }
    pole(g, bone, [X(8), y + Z(0.3), 0], [X(11), y + Z(0.5), Z(1)], Z(0.9));                          // neck bones
    blob(g, bone, X(12.6), y + Z(1.2), Z(1.2), Z(3), Z(2.3), Z(2.4)); blob(g, bone, X(15), y + Z(0.8), Z(1.4), Z(1.6), Z(1.4), Z(1.6)); // skull, muzzle
    blob(g, '#2a241c', X(12.8), y + Z(3.1), Z(1.2), Z(0.9));                                        // the upturned socket
    tube(g, '#ece4cf', [X(11.6), y + Z(1.8), Z(-0.5)], [X(11), y + Z(2), Z(-4.5)], [X(10.2), y + Z(5.5), Z(-5.5)], Z(0.75)); // the horns, still on
    tube(g, '#ece4cf', [X(11.6), y + Z(2.8), Z(2.5)], [X(11.2), y + Z(6), Z(4.5)], [X(10.4), y + Z(8.5), Z(3.5)], Z(0.75));
    for (const [x, dx] of [[-5, -1.5], [-4.4, 0.8], [4.4, 1], [5, 2.6]]) cartoonBone(g, [X(x), Z(1), Z(2.5)], [X(x + dx), Z(1), Z(11)], Z(0.8)); // four legs, out to the belly side
    return g;
  }
  // A bear's bones, lying on the ground (drawCorpse's skeleton stage): skull,
  // spine, a row of rib arches over it, and the leg bones splayed flat.
  function bearSkeleton(){ // lying on its side, as the corpse did: legs out to one side, the ribs arching over the upturned flank
    const g = new THREE.Group(), bone = '#e8e0cc', y = 0.05;
    pole(g, bone, [-0.34, y, 0], [0.24, y + 0.02, 0], 0.035);                            // spine
    for (let i = 0; i < 3; i++) { const R = i === 1 ? 0.17 : 0.14;
      const rib = new THREE.Mesh(own(new THREE.TorusGeometry(R, 0.032, 8, 14, Math.PI)), mat(bone));
      rib.position.set(-0.1 + i * 0.12, y, R * 0.9); rib.rotation.y = Math.PI / 2; rib.userData.hullGeo = rib.geometry; g.add(rib); } // from the spine up and over to the belly side
    blob(g, bone, 0.38, 0.09, 0.02, 0.15, 0.1, 0.12);                                   // big skull, on its side
    blob(g, bone, 0.52, 0.06, 0.03, 0.08, 0.05, 0.065);                                 // snout
    blob(g, '#2a241c', 0.43, 0.17, 0.03, 0.045);                                         // the upturned eye socket
    for (const [x, dx] of [[-0.3, -0.06], [-0.22, 0.02], [0.1, 0.05], [0.18, 0.12]]) cartoonBone(g, [x, 0.03, 0.08], [x + dx, 0.03, 0.42], 0.022); // four legs, out to the belly side
    return g;
  }
  // Bear corpses (the sim's cosmetic corpse list): the toppled model, a blood
  // pool spreading from under it and drying brown, then — past CORPSE_SKEL —
  // sagging flat and shrinking away by CORPSE_LIFE (sinking would show: the
  // ground hides nothing).
  const corpseModels = new Map();
  // A corpse's blood pool, as drawCorpse paints it: seeping in from `start`
  // (ease-out, over 2s), translucent, then drying from 8s to 16s — browner and
  // thinner — and fading out with the corpse over its last 3s.
  function bloodPool(m, age, start, R){
    const bp = Math.max(0, Math.min(1, (age - start) / 2000)), dry = Math.max(0, Math.min(1, (age - 8000) / 8000));
    const a = 0.7 * Math.min(1, bp * 3) * (1 - dry * 0.55) * Math.max(0, Math.min(1, (CORPSE_LIFE - age) / 3000));
    m.visible = a > 0.01; m.scale.setScalar(Math.max(0.001, R * (1 - (1 - bp) ** 2)));
    m.material.transparent = true; m.material.depthWrite = false; m.material.opacity = a;
    m.material.color.setRGB((120 - 40 * dry) / 255, 25 * dry / 255, 10 * dry / 255, THREE.SRGBColorSpace);
  }
  const dropCorpse = r => { scene.remove(r.blood); r.blood.geometry.dispose(); r.blood.material.dispose(); dropSolid(r); if (r.skel) { disposeFaded(r.skel); dropSolid({ obj: r.skel }); } };
  function updateCorpses(used){
    const now = performance.now();
    for (const c of corpses) {
      if (c.utype !== 'bear' && c.utype !== 'dragon' && c.utype !== 'villager' && !MIL3D.has(c.utype)) continue;
      const gx = Math.round(c.x), gy = Math.round(c.y), f = fog[gy] ? fog[gy][gx] : 0;
      if (f === 2) c.seen = true;                                                  // witnessed: it stays on the map in the fog (as 2D, render.js)
      if (!f || (f === 1 && !sameSide(c.team, myTeam) && !c.seen) || (c.x - camAt.x) ** 2 + (c.y - camAt.y) ** 2 > RANGE * RANGE) continue;
      const age = now - c.deathTime;
      if (age >= CORPSE_LIFE) continue;
      used.add('c' + c.id);
      if (c.utype === 'villager' || MIL3D.has(c.utype)) { villagerCorpse(c, age); continue; }
      let r = corpseModels.get(c.id);
      if (!r) {
        const g = c.utype === 'dragon' ? dragonModel() : bearModel(); addHulls(g, true); scene.add(g);
        // The pool lies on the ground on its own (the body lifts as it rolls).
        const blood = new THREE.Mesh(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#6b0f0f' }));
        scene.add(blood);
        const v = RIG_DIRV[c.dir] || [1, 0];
        corpseModels.set(c.id, r = { obj: g, blood, yaw: -Math.atan2(v[1], v[0]) });
      }
      r.obj.position.set(c.x + 0.5, 0, c.y + 0.5); r.obj.rotation.y = r.yaw;
      if (c.utype === 'dragon') dragonDeath(r.obj, age); else deathPose(r.obj, c.utype, age);
      r.blood.position.set(c.x + 0.5, -HULL * 1.5, c.y + 0.5); bloodPool(r.blood, age, 400, c.utype === 'dragon' ? 0.9 : 0.45);
      // Skeleton stage: the body gives way to its bones, which fade over the last 3s, as the 2D art does.
      const bones = age >= CORPSE_SKEL;
      r.obj.visible = !bones;
      if (bones && !r.skel) { r.skel = bearSkeleton(); if (c.utype === 'dragon') r.skel.scale.setScalar(2.2); addHulls(r.skel); scene.add(r.skel); // its spine where the rolled body lay (a roll carries the body a body-height sideways)
        const b = r.obj.getObjectByName('body'), at = new THREE.Vector3(); (b && b.children[0] || r.obj).getWorldPosition(at); r.skelAt = [at.x, at.z]; }
      if (r.skel) {
        const fade = Math.max(0, Math.min(1, (CORPSE_LIFE - age) / 3000));
        r.skel.position.set(r.skelAt[0], 0, r.skelAt[1]); r.skel.rotation.y = r.yaw; fadeTo(r.skel, fade);
      }
    }
    for (const [id, r] of corpseModels) if (!used.has('c' + id)) { dropCorpse(r); corpseModels.delete(id); }
    for (const [id, r] of vilCorpses) if (!used.has('c' + id)) { dropVillager(r); scene.remove(r.blood); r.blood.geometry.dispose(); r.blood.material.dispose(); vilCorpses.delete(id); }
  }
  // A villager's corpse: the lab's staged death (buckle, fall, lie) played on the
  // corpse's age, its own blood pool, then the bones — faded out by CORPSE_LIFE.
  const vilCorpses = new Map();
  function villagerCorpse(c, age){
    let r = vilCorpses.get(c.id);
    if (!r) {
      const blood = new THREE.Mesh(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#6b0f0f' })); scene.add(blood);
      const v = RIG_DIRV[c.dir] || [1, 0]; vilCorpses.set(c.id, r = { obj: null, key: '', blood, yaw: -Math.atan2(v[1], v[0]) });
    }
    // the lab's death on the corpse's age: the fall (≤1.8s, 50ms steps), then the bones (or the weathered wreck)
    const ut = c.utype, mil = MIL3D.has(ut), opt = mil ? { unit: ut, eq: milEquip(ut, c.team), noBlood: true } : { noBlood: true };
    if (ut === 'tradecart') opt.load = (c.carrying || 0) > 0;                  // the corpse keeps the load it died with
    const bones = age >= CORPSE_SKEL, lab = bones ? DIE_LAB.skel + 10 : Math.min(age, 1800), step = bones ? -1 : Math.floor(lab / 50);
    if (RIG_UNITS(ut)) rigPose(r, 'die', lab / DIE_LAB.life, c.female, opt, teamColor(c.team), DIE_LAB.life / 50); // 50ms steps, blended
    else { const key = vilKey('die', step, c.female, opt), fr = vilFrame(key, 'die', (bones ? lab : step * 50) / DIE_LAB.life, c.female, opt, r);
      if (fr) useVilFrame(r, key, fr, teamColor(c.team)); }
    const cx = c.x + 0.5, cz = c.y + 0.5, fw = [Math.cos(-r.yaw), Math.sin(-r.yaw)];
    if (r.obj) { r.obj.position.set(cx, 0, cz); r.obj.rotation.y = r.yaw; if (bones) fadeTo(r.obj, Math.max(0, Math.min(1, (CORPSE_LIFE - age) / 3000))); }
    // The pool spreads from under his back (he falls backward: behind the feet), drying brown.
    // the pool: under his back (he falls backward), under the fallen horse (it rolls onto its −z flank, carrying the body over), none for the ram
    const cav = ut === 'scout' || ut === 'knight', side = [Math.sin(-r.yaw), -Math.cos(-r.yaw)];               // the model's −z in world
    const back = ax(12), hz = chh(-6.2, 1.35);
    r.blood.position.set(cav ? cx + side[0] * hz : cx - fw[0] * back, -HULL * 1.5, cav ? cz + side[1] * hz : cz - fw[1] * back);
    bloodPool(r.blood, age, cav ? 900 : DIE.land * 0.8, ar(cav ? 12 : 8.5)); if (ut === 'ram' || ut === 'tradecart') r.blood.visible = false; // wrecks don't bleed
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
  // A sheaf just cut: it tips over from its stubble, falls flat, and fades.
  const farmPrev = new Map(), sheaves = [];
  function cutSheaf(x, z, away){
    const g = new THREE.Group(), px = 1 / PX, H = 6 / HPX, st = [], hd = [], up = new THREE.Vector3(0, 1, 0);
    for (const k of [-1, 0, 1]) { const hk = H * (k ? 0.78 : 1), s = k * 2.5 * px * Math.SQRT1_2, dir = new THREE.Vector3(s, hk, -s), L = dir.length(), q = new THREE.Quaternion().setFromUnitVectors(up, dir.normalize());
      st.push([s / 2, hk / 2, -s / 2, 0.028, L, 0.028, q]); hd.push([s + dir.x * 0.035, hk + dir.y * 0.035, -s + dir.z * 0.035, 0.05, 0.09, 0.05, q]); }
    g.add(new THREE.Mesh(boxBatch(st, 'rod'), mat('#c9a227').clone())); g.add(new THREE.Mesh(boxBatch(hd, 'ball'), mat('#e8c84a').clone()));
    g.position.set(x, 0.03, z); scene.add(g);
    // tips over toward `away` (world xz angle): about the horizontal axis square to it
    sheaves.push({ g, axis: new THREE.Vector3(Math.sin(away), 0, -Math.cos(away)), age: 0 });
  }
  function updateSheaves(dt){
    for (let i = sheaves.length - 1; i >= 0; i--) { const s = sheaves[i]; s.age += dt;
      const u = Math.min(1, s.age / 0.45); s.g.quaternion.setFromAxisAngle(s.axis, (Math.PI / 2 - 0.1) * u * u * (s.age > 0.45 && s.age < 0.6 ? 1 - 0.06 * Math.sin((s.age - 0.45) / 0.15 * Math.PI) : 1));
      const f = Math.max(0, Math.min(1, (2.2 - s.age) / 0.8));
      for (const m of s.g.children) { m.material.transparent = f < 1; m.material.opacity = f; }
      if (s.age > 2.2) { scene.remove(s.g); for (const m of s.g.children) { m.geometry.dispose(); m.material.dispose(); } sheaves.splice(i, 1); } }
  }
  // Wheat that gives way: stalks and heads bend away from any unit standing
  // among them (wheatPushers, set each frame) and spring back as it moves on.
  const wheatPushers = { value: null }; // WHEAT_PUSH × Vector4 [x, z, strength, radius], made in initShared
  const wheatMats = new Map(), WHEAT_PUSH = 16;
  function wheatMat(col){
    let m = wheatMats.get(col);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: col, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      m.onBeforeCompile = sh => {
        sh.uniforms.uPush = wheatPushers; sh.uniforms.uWind = wind;
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec4 uPush[' + WHEAT_PUSH + ']; uniform float uWind;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
            // the wind: each stalk's own sway plus a slow wave rolling across the field, more toward the tip
            float wave = sin(uWind * 0.05 + wp.x * 2.3 + wp.z * 1.7) * 0.35 + max(0.0, sin(uWind * 0.03 - (wp.x - wp.z) * 1.6)) * 0.9;
            transformed.x += wave * wp.y * 0.18; transformed.z -= wave * wp.y * 0.18;
            for (int i = 0; i < ${WHEAT_PUSH}; i++) {
              vec2 d = wp.xz - uPush[i].xy; float dist = length(d), R = uPush[i].w;
              if (dist < R && dist > 0.001) {
                float k = min((1.0 - dist / R) * uPush[i].z * wp.y * 3.0, wp.y * 0.55); // lean, never fold flat
                transformed.xz += d / dist * k; transformed.y -= k * 0.4;
              }
            }`);
      };
      m.customProgramCacheKey = () => 'wheat2';
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
  // Which sheaves stand, as the farmer sees it: the field's food sets HOW MANY
  // (farmStanding's count), but a cut falls on the standing sheaf nearest the
  // scythe of a farmer working this plot, as his blade sweeps through (mid-
  // stroke) — so the harvest follows him round the plot. Viewer-only state.
  const farmLive = new Map();
  const sheafPos = (e, n) => { const w = e.w || 2, h = e.h || 2, fseed = e.x * 7 + e.y * 13, px = 1 / PX, ri = Math.floor(n / FARM_CROP_COLS), i = n % FARM_CROP_COLS;
    return [e.x + w * farmSheafU(ri, i) + (((n * 5 + fseed) % 5) - 2) * 0.5 * px, e.y + h * FARM_CROP_ROWS[ri] + (((n * 11 + fseed) % 3) - 1) * px]; };
  function farmStandingLive(e){
    const base = farmStanding(e), N = base.length, want = base.filter(Boolean).length;
    let st = farmLive.get(e.id);
    if (!st || N - st.cut.size < want) farmLive.set(e.id, st = { cut: new Set(base.flatMap((b, n) => b ? [] : [n])), away: new Map() }); // first seen, or re-sown
    if (N - st.cut.size > want) {
      let cutter = null;
      for (const v of villagers.values()) if (v.farm && v.farm[0] === e.x && v.farm[1] === e.y) { cutter = v; break; }
      if (!cutter) { for (let n = 0; n < N && N - st.cut.size > want; n++) if (!base[n]) st.cut.add(n); }        // nobody to watch: the seeded order
      else if ((cutter.t > 0.12 && cutter.t < 0.4) || N - st.cut.size > want + 1) {                                  // mid-stroke (or behind): the blade takes the nearest
        const fx = cutter.x + Math.cos(-cutter.yaw) * 0.3, fz = cutter.z + Math.sin(-cutter.yaw) * 0.3;
        while (N - st.cut.size > want) {
          let best = -1, bd = Infinity;
          for (let n = 0; n < N; n++) if (!st.cut.has(n)) { const [x, z] = sheafPos(e, n), d = (x - fx) ** 2 + (z - fz) ** 2; if (d < bd) { bd = d; best = n; } }
          if (best < 0) break;
          st.cut.add(best); const [x, z] = sheafPos(e, best); st.away.set(best, Math.atan2(z - cutter.z, x - cutter.x));
        }
      }
    }
    return Array.from({ length: N }, (_, n) => !st.cut.has(n));
  }
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
    if (!e.complete || e.openTop) delete f.top;                       // (a site: open till its roof goes on; a damaged one, open under it)
    f.x1.holes.push(hole('x1', box, 0.5, SILL, s / 4, 8 / HPX));
    solid(g, wallCol, Object.values(f));
    // 'peaked' block roof: in the art's projection its apex sits roofH + bhh
    // (8 + 10px) above the wall top — a pyramid on the block's own corners.
    const rise = 18 / HPX;
    pyramid(piece(g), roofCol, ...box, wallH, rise);
    if (e.complete) pennant(g, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, wallH + rise, teamColor(e.team));
  }

  // A building is some 50 parts (and as many outline shells): 50+ draw calls each, most of a crowded view's. Its still
  // parts are merged by material (bakePose, as the cached poses) into a handful; what moves — flags, the mill's
  // sails, a stable's horses — is lifted out first and put back as it was (its outline shells ride with it: children).
  // An animal is ~50 draw calls (every blob and its outline shell), posed by its named pivots (body, legs, neck, head,
  // tail). Under each pivot, the unnamed rigid pieces (and their shells) merge by material in the pivot's own frame,
  // so they still move with it; anything named (a puff, an eye, a band) stays its own mesh for the code that finds it.
  // (The dragon keeps its parts: its wings' membranes are rebuilt live.)
  function bakeRigid(g, loose = null){ // loose: names that may merge too (a living sheep's wool puffs: only a carcass is plucked)
    const plain = o => (!o.name || (loose && loose.has(o.name))) && (o.isMesh || o.isLineSegments) && !Array.isArray(o.material) && o.children.every(plain);
    const nodes = []; g.traverse(o => { if (!o.isMesh && !o.isLineSegments) nodes.push(o); });
    for (const n of nodes) {
      const parts = n.children.filter(c => c.isMesh && plain(c));
      if (parts.length < 2) continue;
      const tmp = new THREE.Group(); for (const c of parts) { n.remove(c); tmp.add(c); }   // (tmp at identity: the parts keep their frame in n)
      const baked = bakePose(tmp);
      tmp.traverse(o => { if (o !== tmp && o.geometry && o.geometry.userData.own && !o.geometry.userData.kept) o.geometry.dispose(); });
      for (const c of baked.children.slice()) { if (c.geometry && c.geometry.userData.baked) c.geometry.userData.own = true; n.add(c); }
    }
  }
  const SHEEP_LOOSE = new Set(['puff']);
  function bakeStill(g){
    const live = []; g.traverse(o => { if (o.name === 'flag' || o.name === 'sails' || o.name === 'pennant') live.push(o); else if (o.name === 'horseNeck' && o.parent && o.parent !== g) live.push(o.parent); });
    const lift = live.filter(o => !live.some(p => p !== o && p.getObjectById(o.id)));   // (outermost only)
    g.updateMatrixWorld(true);
    const hold = new THREE.Group(); hold.updateMatrixWorld(true);
    for (const o of lift) { hold.attach(o); bakeRigid(o); }                       // (a moving part merged too, round its own pivots: a horse's neck, head, tail)
    const baked = bakePose(g);
    g.traverse(o => { if (o !== g && o.geometry && o.geometry.userData.own && !o.geometry.userData.kept) o.geometry.dispose(); });
    for (const c of g.children.slice()) g.remove(c);
    for (const c of baked.children.slice()) { if (c.geometry && c.geometry.userData.baked) c.geometry.userData.own = true; g.add(c); } // (own: dropSolid frees it)
    for (const o of lift) g.attach(o);
  }
  function refreshModel(e){
    const hurt = isHurt(e);
    const key = ageOf(e) + ':' + teamColor(e.team) + ':' + (e.w || 0) + 'x' + (e.h || 0) + ':' + (e.complete ? 1 : 0) + (hurt ? ':hurt' : '')
      + (e.btype === 'FARM' ? ':' + farmStandingLive(e).map(Number).join('') : '');
    let rec = solids.get(e.id);
    if (!rec || rec.key !== key) {
      if (rec) { if (rec.site && e.complete) siteDone(e); dropSolid(rec); }
      const g = new THREE.Group();
      MODELS[e.btype](g, hurt ? { ...e, openTop: true } : e); g.userData.bid = e.id; // (the world view's click picks it by this; a damaged one open under its roof)
      addHulls(g);
      if (e.complete && !hurt) bakeStill(g);                       // (a site, or a damaged one, stays in parts: constructionSite reads each wall's depth)
      scene.add(g);
      const flags = [], horses = [];
      g.traverse(o => {
        if (o.name === 'flag') flags.push(o);
        if (o.name === 'horseNeck') horses.push({ neck: o, head: o.getObjectByName('horseHead'), tail: o.parent.getObjectByName('horseTail'), seed: o.parent.userData.horseSeed });
      });
      const pennants = []; g.traverse(o => { if (o.name === 'pennant') pennants.push(o); });
      rec = { obj: g, key, sails: g.getObjectByName('sails'), flags, horses, pennants, trainees: (g.userData.trainees || []).map(t => ({ ...t, obj: null, key: '' })), team: e.team, age: ageOf(e) };
      if (!e.complete) { const b = BLDGS[e.btype]; rec.site = constructionSite(g, e.x, e.y, e.w || b.w, e.h || b.h, !OPEN_SITE.has(e.btype)); rec.siteOf = e.id; }
      else if (hurt) { const b = BLDGS[e.btype]; rec.dmg = buildingDamage(g, e.x, e.y, e.w || b.w, e.h || b.h); rec.dmg.jump(Math.min(DMG_FROM, e.hp / e.maxHp)); }
      solids.set(e.id, rec);
    }
  }
  const OPEN_SITE = new Set(['MARKET', 'FARM']); // open ground (a plaza, a field): no scaffold, the stalls / crops just come up
  // a finished building hurt enough to show it (a farm is worn out, not broken)
  const isHurt = e => e.complete && e.btype !== 'FARM' && e.hp < e.maxHp * DMG_FROM;
  // ---- A construction site: the finished model rising from the ground (cut at the build height, never squashed — the
  // roof, windows and door keep their shape), inside a scaffold whose work deck rides
  // the cut. g: a finished, baked model; its footprint (x0, z0, w, h). Returns { set(progress 0..1) }.
  let siteWood = null;
  const SITE_LIVE = new Set(['flag', 'flagPole', 'pennant', 'sails', 'millShaft', 'goods']); // a site's parts with their own life: never merged
  const SITE_SHADE = 0.66; // how much light reaches inside a site's walls (their inner faces, and the ground they enclose)
  // Finished: the scaffold comes down in a ring of dust round the footprint.
  function siteDone(e){
    const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h, n = Math.min(24, Math.round(2 * (w + h)));
    for (let i = 0; i < n; i++) { const u = (i + 0.5) / n * 2 * (w + h), x = u < w ? e.x + u : u < w + h ? e.x + w : u < 2 * w + h ? e.x + 2 * w + h - u : e.x,
      z = u < w ? e.y : u < w + h ? e.y + u - w : u < 2 * w + h ? e.y + h : e.y + 2 * (w + h) - u;
      puffBurst(x, 0.04, z, 2); }
  }
  // A construction site's walls as real slabs, one geometry: each wall face (near vertical) with its inner face its
  // depth D in, the rim along its outline and the tunnels round its openings joining the two. Flat faces (a floor, a flat
  // top) stay single, marked clipOnly: a site shows them once it reaches them, never squished into a lid.
  // jag: also sliced into narrow upright strips on one world grid, so a damaged wall's top can break to a jagged line.
  function thickGeo(faces, D, nMats, jag = false){
    const buckets = Array.from({ length: nMats }, () => []);
    const UP = new THREE.Vector3(0, 1, 0);
    // sd: the way the face runs up (in its own plane, rising 1 per unit): a site presses it down along itself
    const put = (b, p0, p1, p2, want, clip, nf, inside = 0, sd = UP) => {
      const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0));
      if (n.lengthSq() < 1e-14) return;
      if (n.dot(want) < 0) { n.negate(); [p1, p2] = [p2, p1]; }
      n.normalize();
      for (const q of [p0, p1, p2]) b.push(q, nf ? nf(q) : n, clip + 2 * inside, sd);        // (clipOnly, + 2 on an inner face)
    };
    const top = Math.max(...faces.flatMap(f => f.loop.map(p => p[1])));
    for (const f of faces) {
      const pts = f.loop.map(V3), n = new THREE.Vector3();
      for (let k = 0; k < pts.length; k++) { const a = pts[k], c = pts[(k + 1) % pts.length]; n.x += (a.y - c.y) * (a.z + c.z); n.y += (a.z - c.z) * (a.x + c.x); n.z += (a.x - c.x) * (a.y + c.y); }
      n.normalize(); if (n.dot(V3(f.out)) < 0) n.negate();
      if (Math.abs(n.y) >= 0.5 && pts.every(p => p.y >= top - 1e-4)) continue;   // (a flat top on the walls' tops: they close it themselves, pressed down)
      if (n.y < -0.5) continue;                                                  // (an underside: never seen from above, and two-sided it would lie on the ground)
      const up = new THREE.Vector3(0, 1, 0), v = up.clone().addScaledVector(n, -n.y);
      if (v.lengthSq() < 1e-6) v.set(1, 0, 0).addScaledVector(n, -n.x);
      v.normalize(); const u = new THREE.Vector3().crossVectors(v, n), o = pts[0];
      const to2 = p => { const d = p.clone().sub(o); return new THREE.Vector2(d.dot(u), d.dot(v)); };
      const to3 = q => o.clone().addScaledVector(u, q.x).addScaledVector(v, q.y);
      const b = buckets[f.mat || 0], wall = Math.abs(n.y) < 0.5, contour = pts.map(to2);
      const holes = wall ? (f.holes || []).map(h => { const c = to2(V3(h.at)); return [[c.x - h.w / 2, c.y], [c.x + h.w / 2, c.y], [c.x + h.w / 2, c.y + h.h], [c.x - h.w / 2, c.y + h.h]].map(q => new THREE.Vector2(...q)); }) : [];
      const all = contour.concat(...holes), tris = THREE.ShapeUtils.triangulateShape(contour, holes);
      if (!wall) { for (const [i0, i1, i2] of tris) put(b, to3(all[i0]), to3(all[i1]), to3(all[i2]), n, 1); continue; }
      // the inner face straight in (level), not along a leaning wall's tilted facing: both faces keep every height, so a
      // tapered wall's (the mill's) inner rim rises in step with its outer one
      const nh = new THREE.Vector3(n.x, 0, n.z).normalize(), inset = p => p.clone().addScaledVector(nh, -D), back = n.clone().negate();
      const sd = v.clone().divideScalar(v.y);   // (a leaning wall presses down along its lean: its cut stays on it, exact)
      const nf = f.smooth ? q => f.smooth(q).clone() : null, nb = f.smooth ? q => f.smooth(q.clone().addScaledVector(nh, D)).clone().negate() : null;
      for (const [i0, i1, i2] of tris) { const A = to3(all[i0]), B = to3(all[i1]), C = to3(all[i2]);
        put(b, A, B, C, n, 0, nf, 0, sd); put(b, inset(A), inset(B), inset(C), back, 0, nb, 1, sd); }
      // face → inset quads: along the outline (facing out, in the face's plane) and round each opening (facing into it)
      const band = (loop, want, ins = 0) => { for (let k = 0; k < loop.length; k++) { const a = loop[k], c = loop[(k + 1) % loop.length], w = want(a.clone().add(c).multiplyScalar(0.5));
        put(b, a, c, inset(c), w, 0, null, ins, sd); put(b, a, inset(c), inset(a), w, 0, null, ins, sd); } };
      const c0 = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      band(pts, m => { const d = m.clone().sub(c0); return d.addScaledVector(n, -d.dot(n)); });
      for (const h of holes) { const loop = h.map(to3), hc = loop[0].clone().add(loop[2]).multiplyScalar(0.5); band(loop, m => hc.clone().sub(m), 1); } // (an opening's sides: in the shade too)
    }
    // Sliced into thin horizontal bands: pressing a triangle's upper corners straight down is exact only for one that
    // doesn't reach far past the build height (a long diagonal one — round a window, up a gable — would open a gap).
    const geo = new THREE.BufferGeometry(), pos = [], nrm = [], clip = [], inside = [], slide = [], BAND = jag ? 0.04 : 0.015, COL = 0.1; // (a broken top needn't be as fine as a rising one)
    const cut = (poly, y, keepAbove, ax = 'y') => { const out = [];              // a convex polygon's part above / below y (along ax)
      const lo = (a, c) => a.p[ax] < c.p[ax] || (a.p[ax] === c.p[ax] && (a.p.x < c.p.x || (a.p.x === c.p.x && a.p.y < c.p.y)));
      for (let k = 0; k < poly.length; k++) { const a = poly[k], c = poly[(k + 1) % poly.length], ia = keepAbove ? a.p[ax] >= y : a.p[ax] <= y, ic = keepAbove ? c.p[ax] >= y : c.p[ax] <= y;
        if (ia) out.push(a);
        if (ia !== ic) { const [e0, e1] = lo(a, c) ? [a, c] : [c, a], f = (y - e0.p[ax]) / (e1.p[ax] - e0.p[ax]); // (from its lower end, whichever side asks: the same point)
          out.push({ p: e0.p.clone().lerp(e1.p, f), n: e0.n.clone().lerp(e1.n, f).normalize() }); } }
      return out; };
    // a polygon diced on the world grid along ax (step st): its pieces
    const dice = (polys, ax, st) => polys.flatMap(poly => { if (poly.length < 3) return [];
      const vs = poly.map(v => v.p[ax]), lo = Math.min(...vs), hi = Math.max(...vs), k0 = Math.floor(lo / st + 1e-6), k1 = Math.ceil(hi / st - 1e-6);
      if (k1 - k0 <= 1) return [poly];
      const out = []; for (let k = k0; k < k1; k++) { const q = cut(cut(poly, Math.max(lo, k * st), true, ax), Math.min(hi, (k + 1) * st), false, ax); if (q.length >= 3) out.push(q); }
      return out; });
    let start = 0;
    buckets.forEach((b, m) => {
      let count = 0;
      for (let k = 0; k < b.length; k += 12) {
        const tri = [0, 4, 8].map(d => ({ p: b[k + d], n: b[k + d + 1] })), cl = b[k + 2] & 1, ins = b[k + 2] >> 1, sd = b[k + 3];
        const ys = tri.map(v => v.p.y), lo = Math.min(...ys), hi = Math.max(...ys);
        // (on one grid for the whole building: neighbours split a shared edge at the same heights, so no crack opens along it)
        const k0 = Math.floor(lo / BAND + 1e-6), k1 = Math.max(k0 + 1, Math.ceil(hi / BAND - 1e-6));
        // (a flat one: nothing to slice — kept whole)
        const bands = cl || hi - lo < 1e-6 ? [[lo, hi]] : Array.from({ length: k1 - k0 }, (_, i) => [Math.max(lo, (k0 + i) * BAND), Math.min(hi, (k0 + i + 1) * BAND)]).filter(([y0, y1]) => y1 - y0 > 1e-7);
        for (const [y0, y1] of bands) {
          const band = bands.length > 1 ? cut(cut(tri, y0, true), y1, false) : tri;
          for (const poly of jag && !cl ? dice(dice([band], 'x', COL), 'z', COL) : [band])
          for (let q = 1; q + 1 < poly.length; q++) for (const v of [poly[0], poly[q], poly[q + 1]]) { pos.push(v.p.x, v.p.y, v.p.z); nrm.push(v.n.x, v.n.y, v.n.z); clip.push(cl); inside.push(ins); slide.push(sd.x, sd.y, sd.z); count++; }
        }
      }
      geo.addGroup(start, count, m); start += count;
    });
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('clipOnly', new THREE.Float32BufferAttribute(clip, 1));
    geo.setAttribute('inside', new THREE.Float32BufferAttribute(inside, 1));
    geo.setAttribute('slide', new THREE.Float32BufferAttribute(slide, 3));
    return geo;
  }
  // The ground a site's walls enclose, in their shade: the walls' inner feet (convex hull), a dark film just above the grass.
  let _floorMat = null;
  function floorShade(o){
    o.updateMatrixWorld(true);
    const P = o.geometry.attributes.position, In = o.geometry.attributes.inside, v = new THREE.Vector3(), pts = [];
    for (let i = 0; i < P.count; i++) if (In.getX(i) > 0.5) { v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld); if (v.y < 1e-3) pts.push([v.x, v.z]); }
    if (pts.length < 3) return null;
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], hi = [];
    for (const p of pts) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of pts.slice().reverse()) { while (hi.length > 1 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    const hull = lo.slice(0, -1).concat(hi.slice(0, -1)); if (hull.length < 3) return null;
    const pos = []; for (let k = 1; k + 1 < hull.length; k++) for (const q of [hull[0], hull[k + 1], hull[k]]) pos.push(q[0], 0.004, q[1]);
    const geo = own(new THREE.BufferGeometry()); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    _floorMat = _floorMat || new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 1 - SITE_SHADE, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }); // (single pass: a see-through two-sided material is otherwise drawn twice, recompiled each time)
    return new THREE.Mesh(geo, _floorMat);
  }
  // jag: a damaged building (buildingDamage) — walls broken to a jagged top, pieces crumbling; no scaffold.
  const SITE_NOISE = `float siteH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float siteN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(siteH(i), siteH(i + vec2(1.0, 0.0)), f.x), mix(siteH(i + vec2(0.0, 1.0)), siteH(i + vec2(1.0, 1.0)), f.x), f.y); }`;
  function constructionSite(g, x0, z0, w, h, scaffold = true, jag = false){
    g.updateMatrixWorld(true);
    // Pieces (piece(): roofs, caps, awnings) are set in place whole once the walls reach them; the rest rises by the cut.
    const pieces = [], isPiece = o => o.userData.piece;
    for (const c of g.children) if (isPiece(c)) pieces.push(c);
    const walk = (o, f) => { if (isPiece(o)) return; f(o); for (const c of o.children) walk(c, f); };
    const box = new THREE.Box3(), all = new THREE.Box3().setFromObject(g), base = new THREE.Box3(), mb = new THREE.Box3();
    for (const c of g.children) walk(c, o => { if (o.isMesh) box.expandByObject(o); });
    // the base: what stands on the ground and carries the building (its walls — not a fence, post or prop)
    for (const c of g.children) walk(c, o => { if (!o.isMesh || HULL_MATS.has(o.material)) return; mb.setFromObject(o, true);
      if (mb.min.y < 0.05 && mb.max.y >= 0.5 * box.max.y) base.union(mb); });
    const H = Math.max(0.2, box.isEmpty() ? all.max.y : box.max.y);
    // The walls grow by squishing, never cutting: whatever stands above the build height is pressed down onto it, so a
    // wall's own top comes down with it (its depth showing, openings above closed over). Flat faces (clipOnly) and the ink
    // lines are cut there instead; a box's team-coloured top waits for the finished building.
    const below = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), siteY = { value: 0 }, siteJag = { value: 0 };
    const built = new Map();
    const cutMat = m => { let c = built.get(m); if (c) return c;
      c = m.clone(); c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey;
      if (m.isLineBasicMaterial) c.clippingPlanes = [below];                           // (ink: cut at the top, not pressed onto it)
      else { const ob = m.onBeforeCompile, key = m.customProgramCacheKey.call(m), lit = !!m.isMeshLambertMaterial && !m.flatShading;
        c.onBeforeCompile = (sh, r) => { if (ob) ob.call(c, sh, r); sh.uniforms.siteY = siteY; sh.uniforms.siteJag = siteJag;
          // the top: level while building; broken (siteJag: how far it dips, by a smooth noise along the walls) when damaged
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float clipOnly; attribute float inside; attribute vec3 slide; uniform float siteY; uniform float siteJag; varying float vSiteY; varying float vClip; varying vec3 vSiteW; varying float vInside; varying float vSiteTop;\n' + SITE_NOISE)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
              {
                #ifdef USE_INSTANCING
                  mat4 siteM = modelMatrix * instanceMatrix;
                #else
                  mat4 siteM = modelMatrix;
                #endif
                vec4 sw = siteM * vec4(transformed, 1.0); vSiteY = sw.y; vClip = clipOnly;
                float sy = siteJag > 0.0 ? max(0.0, siteY - siteJag * siteN(sw.xz * 3.2)) : siteY; vSiteTop = sy;
                if (clipOnly < 0.5 && sw.y > sy) { sw.xyz -= slide * (sw.y - sy); transformed = (inverse(siteM) * sw).xyz; }
                vSiteW = sw.xyz; vInside = inside; }`);
          // a surface pressed flat onto the top (found per pixel, so a wall's side is never touched) is lit and patterned as a top
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float siteY; uniform float siteJag; varying float vSiteY; varying float vClip; varying vec3 vSiteW; varying float vInside; varying float vSiteTop;')
            .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
              if (vClip > 0.5 && vSiteY > vSiteTop + 1e-4) discard;
              bool sitePressed = vSiteW.y >= vSiteTop - 1e-4 && (siteJag > 0.0 || abs(normalize(cross(dFdx(vSiteW), dFdy(vSiteW))).y) > 0.98);`)
            .replace('abs(normalize(vWNrm))', 'abs(sitePressed ? vec3(0.0, 1.0, 0.0) : normalize(vWNrm))')
            // the inside of the walls (and of its openings) in the walls' shade
            .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  if (vInside > 0.5 && !sitePressed) gl_FragColor.rgb *= SITE_SHADE;');
          if (lit) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  if (sitePressed) normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);'); };
        c.onBeforeCompile.fow = !!(ob && ob.fow);                        // (a source already fog-patched: not patched again — a double patch won't compile)
        c.customProgramCacheKey = () => key + (jag ? ':siteJ' : ':site');
        c.defines = { ...(c.defines || {}), SITE_SHADE: SITE_SHADE.toFixed(3) };
        // a lintel pressed down faces down: from above it must still close its opening's slot
        if (!HULL_MATS.has(m)) c.side = THREE.DoubleSide; }
      if (INTERIOR_MATS.has(m) || HULL_MATS.has(m)) c.visible = false;     // (no bold outline on an open, half-built shell: the finished building gets it)
      built.set(m, c); return c; };
    // every mesh of a site says what it is (the site shader reads these; an unset attribute reads garbage)
    const mark = geo => { const n = geo.attributes.position.count;
      for (const k of ['clipOnly', 'inside']) if (!geo.attributes[k]) geo.setAttribute(k, new THREE.Float32BufferAttribute(new Float32Array(n), 1));
      if (!geo.attributes.slide) geo.setAttribute('slide', new THREE.Float32BufferAttribute(new Float32Array(n * 3).map((_, i) => i % 3 === 1 ? 1 : 0), 3)); }; // (straight down)
    const swap = (o, f) => { if (!o.material) return;
      if (o.isMesh) mark(o.geometry);
      if (Array.isArray(o.material) && o.material.length === 6) o.material = o.material.map((m, i) => i === 2 ? o.material[0] : m); // (a box: its body on top)
      o.material = Array.isArray(o.material) ? o.material.map(f) : f(o.material); o.userData.siteOwn = true; };
    const set0 = [];
    for (const c of g.children) if (isPiece(c)) { const b = new THREE.Box3().setFromObject(c); set0.push({ obj: c, y0: c.position.y, base: b.min.y, top: b.max.y, at: null }); }
    const floors = [];
    for (const c of g.children) walk(c, o => { if (!o.isMesh || !o.userData.slab) return; o.geometry = own(o.userData.slab(jag));
      const rl = o.children.find(k => k.userData.rims); if (rl) rl.geometry = own(new THREE.BufferGeometry().setFromPoints(o.userData.slabRims()));
      floors.push(floorShade(o)); });
    for (const f of floors) if (f) g.add(f);
    for (const c of g.children.slice()) walk(c, o => swap(o, cutMat));
    // a part that starts above the build height isn't there yet (a cap on the walls, a beam higher up) — pressing it down
    // would lay it over the open top
    const later = []; g.updateMatrixWorld(true);
    for (const c of g.children) walk(c, o => { if (o.isMesh && !HULL_MATS.has([].concat(o.material)[0]) && o.parent && !o.parent.isMesh) { const y0 = mb.setFromObject(o, true).min.y; if (y0 > 0.02) later.push([o, y0]); } });
    const setRing = y => { siteY.value = y; for (const [o, y0] of later) o.visible = y > y0 + 0.005; };
    // the rest, merged by material (as a finished building): what comes and goes on its own (pieces, parts above the
    // build line, flags, goods, a horse, the floor shade) is lifted out first and put back as it was
    { const keep = new Set([...set0.map(q => q.obj), ...later.map(([o]) => o), ...floors.filter(Boolean)]);
      g.traverse(o => { if (SITE_LIVE.has(o.name)) keep.add(o); else if (o.name === 'horseNeck' && o.parent && o.parent !== g) keep.add(o.parent); });
      const lift = [...keep].filter(o => ![...keep].some(p => p !== o && p.getObjectById(o.id)));
      g.updateMatrixWorld(true); const hold = new THREE.Group(); hold.updateMatrixWorld(true);
      for (const o of lift) hold.attach(o);
      const siteMats = new Set(built.values()), baked = bakePose(g);
      g.traverse(o => { if (o !== g && o.geometry && o.geometry.userData.own && !o.geometry.userData.kept) o.geometry.dispose(); });
      for (const c of g.children.slice()) g.remove(c);
      for (const c of baked.children.slice()) { if (c.geometry && c.geometry.userData.baked) c.geometry.userData.own = true; if (siteMats.has(c.material)) c.userData.siteOwn = true; g.add(c); }
      for (const o of lift) g.attach(o);
      // the parts above the build line, merged per height band (0.05): a band shows as one once the walls reach it
      const bands = new Map(), keepL = new Set(set0.map(q => q.obj));
      const inLive = o => { for (let p = o; p && p !== g; p = p.parent) if (SITE_LIVE.has(p.name) || keepL.has(p) || p.name === 'horseNeck') return true; return false; }; // (part of something with its own life)
      for (const [o, y0] of later) { if (!o.parent || inLive(o)) continue; const k = Math.floor(y0 / 0.05); let b = bands.get(k); if (!b) bands.set(k, b = { y0, objs: [] }); b.y0 = Math.min(b.y0, y0); b.objs.push(o); }
      const merged = new Set();
      for (const b of bands.values()) { if (b.objs.length < 2) continue;
        const tmp = new THREE.Group(); for (const o of b.objs) { tmp.attach(o); merged.add(o); }
        const bg = bakePose(tmp); tmp.traverse(o => { if (o !== tmp && o.geometry && o.geometry.userData.own && !o.geometry.userData.kept) o.geometry.dispose(); });
        bg.traverse(c => { if (c.geometry && c.geometry.userData.baked) c.geometry.userData.own = true; if (siteMats.has(c.material)) c.userData.siteOwn = true; });
        g.add(bg); later.push([bg, b.y0]); }
      for (let i = later.length - 1; i >= 0; i--) if (merged.has(later[i][0])) later.splice(i, 1); }
    // Each piece is set once the walls holding it are up (the cut past its top: a lean-to when the keep reaches its
    // high edge), dropping the last bit into place; the walls rise over the first 85%, the pieces crowning them (roof,
    // cap, then a chimney) follow one by one.
    const tops = set0.filter(q => q.top >= H * 0.98).sort((a, b) => a.base - b.base);
    for (const q of set0) { const i = tops.indexOf(q); q.when = i < 0 ? q.top / H * 0.85 : 0.85 + 0.12 * (i + 1) / tops.length; }
    const setPieces = p => { const now = performance.now();
      for (const q of set0) { const on = p >= q.when - 1e-6;
        if (on && q.at == null) q.at = now; else if (!on) q.at = null;
        const k = on ? Math.min(1, (now - q.at) / 260) : 0;
        q.obj.visible = on; q.obj.position.y = q.y0 + (1 - k) * (1 - k) * 0.22; } };
    const rise = p => Math.min(1, Math.max(0, p) / (set0.length ? 0.85 : 1));
    if (jag) { // damaged, health f: the pieces crumble away (95% → 55%, or none), then the walls break down to nothing
      const crumble = { value: 0 }, own2 = new Map();
      const crumbleMat = m => { let c = own2.get(m); if (c) return c; c = m.clone(); const ob = m.onBeforeCompile, key = m.customProgramCacheKey.call(m);
        c.onBeforeCompile = (sh, r) => { if (ob) ob.call(c, sh, r); sh.uniforms.crumble = crumble;
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCrW;').replace('#include <project_vertex>', '#include <project_vertex>\nvCrW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float crumble; varying vec3 vCrW;\n' + SITE_NOISE)
            .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (siteN(vCrW.xz * 4.5 + vCrW.y * 3.1) * 0.8 + siteN(vCrW.xz * 13.0 - vCrW.y * 7.0) * 0.2 < crumble) discard;'); };  // (ragged holes that spread)
        c.onBeforeCompile.fow = !!(ob && ob.fow); c.customProgramCacheKey = () => key + ':crumble'; c.side = HULL_MATS.has(m) ? m.side : THREE.DoubleSide;
        own2.set(m, c); return c; };
      for (const q of set0) q.obj.traverse(o => { if (o.material) { o.material = Array.isArray(o.material) ? o.material.map(crumbleMat) : crumbleMat(o.material); o.userData.siteOwn = true; } });
      const flags = [], goods = []; g.traverse(o => { if (o.name === 'flag' || o.name === 'flagPole' || o.name === 'pennant' || o.name === 'sails' || o.name === 'millShaft') flags.push(o); else if (o.name === 'goods') goods.push(o); });
      const R0 = 0.95, R1 = set0.length ? 0.55 : R0;                                        // the pieces' stretch, then the walls'
      const damage = f => {
        const k = Math.min(1, Math.max(0, (R0 - f) / (R0 - R1 || 1)));
        // (the noise sits mostly within 0.2–0.9)
        crumble.value = set0.length && k > 0 ? 0.2 + 0.72 * k : 0; for (const q of set0) { q.obj.visible = k < 1; q.obj.position.y = q.y0; }
        const wv = Math.min(1, Math.max(0, f / R1)), y = H * wv;
        siteY.value = f >= R1 ? H + 1 : y; siteJag.value = f >= R1 ? 0 : Math.min(y, 0.06 + 0.4 * H * (1 - wv));
        below.constant = f >= R1 ? H + 1 : Math.max(0, y - siteJag.value);           // (ink only below the lowest break)
        for (const [o, y0] of later) o.visible = f >= R1 || y - siteJag.value > y0 + 0.005;
        for (const fl of floors) if (fl) fl.visible = f >= R1 || wv > 0.08;                // (its shade goes with the walls)
        for (const o of flags) o.visible = k < 0.4;                                      // (last: over the parts-above rule)
        for (const o of goods) o.visible = k < 1;
        return { roof: k, wall: 1 - wv, top: f >= R1 ? H : y };
      };
      damage(1); return { damage, H };
    }
    if (!scaffold) { const set = p => { const y = H * rise(p); below.constant = y; setRing(y); setPieces(p); }; set(0); return { set }; } // (a wall piece: too small for one)
    // Scaffold: timber poles round the footprint, a tile apart, rails every ~0.3 up, a brace on each face; full height
    siteWood = siteWood || '#9c7448';
    // round the base (its walls), a plank's width out; up to the wall tops (the roof goes on from it)
    const [p0, q0, p1, q1] = base.isEmpty() ? [x0, z0, x0 + w, z0 + h] : [base.min.x, base.min.z, base.max.x, base.max.z];
    const sc = new THREE.Group(), o = 0.12, X0 = p0 - o, Z0 = q0 - o, X1 = p1 + o, Z1 = q1 + o, top = H + 0.04, r = 0.014;
    const along = (a, b) => { const n = Math.max(1, Math.round(b - a)); return Array.from({ length: n + 1 }, (_, i) => a + (b - a) * i / n); };
    const xs = along(X0, X1), zs = along(Z0, Z1), posts = [];
    for (const x of xs) posts.push([x, Z0], [x, Z1]);
    for (const z of zs.slice(1, -1)) posts.push([X0, z], [X1, z]);
    for (const [x, z] of posts) pole(sc, siteWood, [x, 0, z], [x, top, z], r, 'bare');
    const rails = Math.max(1, Math.round(top / 0.5));
    for (let i = 1; i <= rails; i++) { const y = top * i / (rails + 0.3);
      for (const [a, b] of [[[X0, y, Z0], [X1, y, Z0]], [[X0, y, Z1], [X1, y, Z1]], [[X0, y, Z0], [X0, y, Z1]], [[X1, y, Z0], [X1, y, Z1]]]) pole(sc, siteWood, a, b, r * 0.7, 'bare'); }
    bakeStill(sc); g.add(sc);
    // it goes up with the walls, a lift ahead of them
    const lift = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0), scMats = new Map();
    sc.traverse(o => { if (!o.material || Array.isArray(o.material)) return;
      let c = scMats.get(o.material); if (!c) { c = o.material.clone(); c.onBeforeCompile = o.material.onBeforeCompile; c.customProgramCacheKey = o.material.customProgramCacheKey; c.clippingPlanes = [lift]; scMats.set(o.material, c); }
      o.material = c; o.userData.siteOwn = true; });
    // the work deck: planks round the walls at the cut, climbing with it
    const deck = new THREE.Group(), d = 0.08; // (clear of the outline shell, HULL out from the walls)
    for (const [a0, b0, a1, b1] of [[X0, Z0, X1, Z0 + d], [X0, Z1 - d, X1, Z1], [X0, Z0 + d, X0 + d, Z1 - d], [X1 - d, Z0 + d, X1, Z1 - d]]) boxAt(deck, '#b88a52', a0, b0, a1, b1, 0, 0.018);
    bakeStill(deck); g.add(deck);                                                 // (one piece: it only ever moves whole)
    // the scaffold comes down as the roof goes on (the first piece crowning the walls), never through it
    const down = tops.length ? tops[0].when : 1;
    const set = p => { const y = H * rise(p); below.constant = y; lift.constant = Math.min(top + 0.01, y + 0.35); setRing(y); setPieces(p);
      if (sc.visible && p >= down && scene && p < 1) for (const [x, z] of posts) puffBurst(x, 0.04, z, 2); // (in the game: dust as it comes down)
      sc.visible = p < down; deck.position.y = Math.max(0, y - 0.03); deck.visible = y > 0.12 && p < Math.min(0.9, down); };
    set(0);
    return { set };
  }
  // ---- A damaged building: construction run backward. As its health drops the roof (and cap, chimney, awnings) crumbles
  // away, then the walls break down to a jagged top, lower and lower; destroyed, the last of it drops into dust. Chunks
  // fall off as it goes. Viewer-only: it reads hp, nothing more. g: a fresh (unbaked) finished model; (x0, z0, w, h) its
  // footprint; its falling bits go into g. Returns { set(hpFrac), collapse(), tick(dt) → true once gone, shown }.
  const structure = (g, f) => { const walk = o => { if (o.name === 'sails' || o.name === 'flag') return; if (o.isMesh && !o.isInstancedMesh && !HULL_MATS.has(o.material)) f(o); for (const c of o.children) walk(c); }; walk(g); };
  function buildingDamage(g, x0, z0, w, h){
    g.updateMatrixWorld(true);
    // the chunks' colours: the pieces' (roof) and the walls' (the most-used face)
    const inPiece = o => { for (let p = o; p && p !== g; p = p.parent) if (p.userData.piece) return true; return false; };
    let roofCol = null; const wallN = new Map(), bb = new THREE.Box3(), box = new THREE.Box3();
    structure(g, o => { box.union(bb.setFromObject(o, true)); for (const m of [].concat(o.material)) { if (!m.color || INTERIOR_MATS.has(m)) continue;
      if (inPiece(o)) roofCol = roofCol || '#' + m.color.getHexString(); else wallN.set(m, (wallN.get(m) || 0) + 1); } });
    const wallCol = '#' + (([...wallN.entries()].sort((a, b) => b[1] - a[1])[0] || [{ color: new THREE.Color('#9a8a74') }])[0].color.getHexString());
    const site = constructionSite(g, x0, z0, w, h, false, true);
    let shown = 1, target = 1, rate = 0.5, last = 1, st = site.damage(1);
    const bits = [], puffs2 = [];
    const burst = (n, y, col) => { for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(unitBox, mat(col)), s0 = 0.03 + Math.random() * 0.04;
      m.scale.set(s0 * 1.4, s0, s0); m.position.set(box.min.x + Math.random() * (box.max.x - box.min.x), y, box.min.z + Math.random() * (box.max.z - box.min.z));
      g.add(m); bits.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 0.7, 0.3 + Math.random() * 0.4, (Math.random() - 0.5) * 0.7), age: 0, r: (Math.random() - 0.5) * 14 }); } };
    const dust = (x, y, z, sc = 1) => { const m = new THREE.Mesh(unitSphere(), new THREE.MeshBasicMaterial({ color: '#b9a88c', transparent: true, opacity: 0.5, depthWrite: false }));
      m.position.set(x, y, z); m.scale.setScalar(0.05 * sc); g.add(m); puffs2.push({ m, age: 0, s: 0.05 * sc }); };
    const tick = dt => {
      if (shown !== target) {
        shown = target < shown ? Math.max(target, shown - rate * dt) : Math.min(target, shown + rate * dt);
        st = site.damage(shown);
        if (shown < last - 0.03) {                                                      // a bit more of it gone: bits off it
          const onRoof = roofCol && st.roof > 0 && st.roof < 1;
          burst(onRoof ? 3 : 2, onRoof ? site.H : st.top, onRoof ? roofCol : wallCol);
          for (let i = 0; i < 2; i++) dust(box.min.x + Math.random() * (box.max.x - box.min.x), onRoof ? site.H : st.top, box.min.z + Math.random() * (box.max.z - box.min.z));
          last = shown;
        } else if (shown > last) last = shown;
      }
      for (let i = bits.length - 1; i >= 0; i--) { const b = bits[i]; b.age += dt;
        if (b.m.position.y > 0.02) { b.v.y -= 3.2 * dt; b.m.position.addScaledVector(b.v, dt); b.m.rotation.x += b.r * dt; b.m.rotation.z += b.r * 0.7 * dt;
          if (b.m.position.y <= 0.02) { b.m.position.y = 0.02; dust(b.m.position.x, 0.03, b.m.position.z, 0.8); } }
        if (b.age > 2.2) { g.remove(b.m); bits.splice(i, 1); } else if (b.age > 1.6) b.m.scale.multiplyScalar(Math.exp(-dt * 6)); }
      for (let i = puffs2.length - 1; i >= 0; i--) { const p = puffs2[i]; p.age += dt; p.m.position.y += dt * 0.1; p.m.scale.setScalar(p.s * (1 + p.age * 2.5));
        p.m.material.opacity = 0.5 * Math.max(0, 1 - p.age / 1.2); if (p.age > 1.2) { g.remove(p.m); p.m.material.dispose(); puffs2.splice(i, 1); } }
      return shown <= 0 && !bits.length && !puffs2.length;
    };
    return { set: f => { target = Math.max(0, Math.min(1, f)); }, jump: f => { shown = last = target = f; st = site.damage(f); },
      collapse: () => { target = 0; rate = 1.4; for (let i = 0; i < 8; i++) dust(box.min.x + Math.random() * (box.max.x - box.min.x), 0.05, box.min.z + Math.random() * (box.max.z - box.min.z), 1.6); },
      tick, get shown(){ return shown; } };
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
  // Viewer-only motion (aTick, never the sim): sails, gate doors, flags, horses.
  const ease = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // Destroyed buildings (logic.js calls onBuildingFell): one seen falling comes down to nothing (buildingDamage's collapse)
  // — its damaged model carries on from where it stood, else a fresh one.
  const falls = [];
  const DMG_FROM = 0.95; // below this share of its health a building shows its damage (buildingDamage)
  window.onBuildingFell = e => {
    if (!scene || !raf) return;                                                      // (the 3D view is running)
    const rec = solids.get(e.id);
    if (buildingFogLevel(e) !== 2) return;                                          // (fell unseen: nothing to show)
    const c = centerOf(e), b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h;
    if (Math.abs(c.x - camAt.x) > RANGE || Math.abs(c.y - camAt.y) > RANGE) return;
    let g, d;
    if (rec && rec.dmg) { solids.delete(e.id); g = rec.obj; d = rec.dmg; g.userData.bid = null; }   // (taken over: refreshBuildings won't drop it)
    else { g = new THREE.Group(); const snap = { ...e, hp: 1, complete: true, openTop: true };
      try { if (isWallBtype(e.btype) || isGateBtype(e.btype)) g.add(wallModel(snap, []).obj); else if (MODELS[e.btype]) MODELS[e.btype](g, snap); else return; } catch (err) { return; }
      addHulls(g); scene.add(g); d = buildingDamage(g, e.x, e.y, w, h); }
    d.collapse(); falls.push({ g, d });
    shakeFrom(c.x, c.y, Math.min(0.06, 0.012 * Math.sqrt(w * h)));
  };
  function dropFalls(){ for (const f of falls) dropSolid({ obj: f.g }); falls.length = 0; }
  function animateFalls(dt){
    for (let i = falls.length - 1; i >= 0; i--) if (falls[i].d.tick(dt)) { dropSolid({ obj: falls[i].g }); falls.splice(i, 1); }
  }
  function animateModels(dt){
    animateFalls(dt);
    const t = aTick * 0.13;
    for (const rec of solids.values()) {
      if (rec.sails) rec.sails.rotation.z += dt * 0.9;
      if (rec.pennants) for (const p of rec.pennants) p.rotation.y = 0.35 * Math.sin(t * 0.9 + p.userData.phase) + 0.12 * Math.sin(t * 2.3 + p.userData.phase * 2); // (swinging in the wind)
      if (rec.site) { const be = entitiesById.get(rec.siteOf); if (be) rec.site.set((be.buildProgress || 0) / be.buildTime); }
      if (rec.dmg && rec.obj.visible) { const fe = entitiesById.get(rec.obj.userData.bid); if (fe) rec.dmg.set(fe.hp / fe.maxHp); rec.dmg.tick(dt); } // (its damage by its health)
      if (rec.door) { // gates slide their door up as they open (read-only)
        const ge = entitiesById.get(rec.doorOf);
        rec.door.position.y = ge ? (ge.gateProgress || 0) * 26 / HPX : 0;
      }
      if (rec.flags) for (const f of rec.flags) { // the art's travelling wave
        const pos = f.geometry.attributes.position, rest = f.geometry.userData.rest, L = f.userData.len, fs = f.userData.s || 1;
        for (let i = 0; i < pos.count; i++) {
          const u = rest[3 * i] / L;
          pos.setZ(i, (Math.sin(t - u * 4.2) * 0.07 + Math.sin(t * 0.63 - u * 7) * 0.02) * u * fs);
          pos.setY(i, rest[3 * i + 1] - 0.05 * u * u * fs);
        }
        pos.needsUpdate = true;
      }
      if (rec.trainees) for (const tr of rec.trainees) { // the spearman's thrust on the pose cache (villagerPose's idiom), facing the dummy
        const opt = { unit: 'spearman', eq: soldierEquip('spearman', rec.age, 0, 0, false) }, ph = ((aTick * 0.026 + tr.seed) % 1 + 1) % 1, step = Math.floor(ph * VIL_STEPS);
        rigPose(tr, 'attack', ph, false, opt, teamColor(rec.team));
        if (tr.obj) { tr.obj.position.set(tr.x, 0, tr.z); tr.obj.rotation.y = tr.yaw; }
      }
      if (rec.horses) for (const h of rec.horses) {
        // Each horse on its own ~11s cycle: head up (a slow bob), then down to
        // graze a few seconds, nibbling; the tail swishes throughout.
        const sec = aTick / 30 + h.seed * 11, ph = (sec / 11) % 1;
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
      const rec = solids.get(e.id); if (rec && rec.obj) rec.obj.visible = true;
    }
    // Out of range: hidden, not dropped — the model is ready when the view comes back. Gone or unseen: dropped.
    for (const [id, w] of solids) if (!seen.has(id)) { const e = entitiesById.get(id);
      if (e && e.type === 'building' && e.hp > 0 && bldgVisible(e)) { if (w.obj) w.obj.visible = false; } else { dropSolid(w); solids.delete(id); } }
  }
  // Where a unit faces: along its path, else toward its target, else the last way it faced. It shares the 2D
  // renderer's facing (e.dir, 8 sectors of 45° in map angle — cosmetic, never read by the sim): a unit starts from
  // it, 3D writes its turns back (both views agree after a switch), and a 2D turn since overrides the finer memory.
  const heading = new Map(); // id → { h, dir }
  function setHeading(e, h){
    const dir = ((Math.round(h / (Math.PI / 4)) % 8) + 8) % 8;
    heading.set(e.id, { h, dir });
    if (world && e.dir !== dir) { e.dir = dir; if (typeof setFacingFromDir === 'function') setFacingFromDir(e, dir); }
  }
  function worldFacing(e){
    if (e.faceAng !== undefined) return e.faceAng;                                        // the dragon's own slow heading (its fire goes where it faces)
    let tx, ty;
    if (e.path && e.path.length) { const a = e.path[Math.min(3, e.path.length - 1)]; tx = a.x; ty = a.y; }
    else if (e.target && entitiesById.get(e.target)) { const t = entitiesById.get(e.target); tx = t.x; ty = t.y; }
    if (tx !== undefined && (tx !== e.x || ty !== e.y)) { const h = Math.atan2(ty - e.y, tx - e.x); setHeading(e, h); return h; }
    const r = heading.get(e.id);
    if (r && (e.dir === undefined || r.dir === e.dir)) return r.h;
    return (e.dir !== undefined ? e.dir : 1) * Math.PI / 4;
  }

  function unitVisible(e){
    if (e.garrisonedIn || e.hp <= 0) return false;
    const f = (fog[Math.round(e.y)] && fog[Math.round(e.y)][Math.round(e.x)]) || 0;
    return f === 2 || (f === 1 && sameSide(e.team, myTeam));
  }

  // ---- Villagers in 3D: the lab's own poses (animFrame), cached ----
  // A posed villager costs ~3ms to build, so each distinct pose — action,
  // phase step, female, load, tool — is built once at game resolution, merged
  // to one mesh per material (≈10 draws, not ≈100), and cloned per villager
  // (clones share geometry). Team colour is swapped per clone, so poses are
  // shared across teams. Viewer-only: reads sim state, never writes it.
  const VIL_TC = '#2d6bd1', VIL_STEPS = 16; // pose steps per cycle (timing is smooth — aTick — and more steps multiply the cache)
  // Work cycles in cycles per authored tick (aTick, 30/s): the 3D swings
  // run slower and fuller than the 2D jab.
  const VIL_RATE = { split: 0.021, chop: 0.022, saw: 0.034, mine: 0.021, build: 0.03, repair: 0.034, farm: 0.019, plow: 0.03, forage: 0.019, butcher: 0.036, fight: 0.042, idle: 0.0085 };
  const workPhase = (e, k) => { const r = aTick * VIL_RATE[k] + e.id * 0.37; return ((r % 1) + 1) % 1; };
  const WALK_TILES = { walk: 0.62, carry: 0.62, barrow: 0.66, plow: 0.5, flee: 1.0 }; // ground covered per stride cycle
  const WALK_IN = 0.9; // tiles per game-second a villager steps to its work spot at (a walk)
  const vilCache = new Map(), vilRefs = new Map(), bladePush = [], VIL_CACHE_VERTS = 1.5e6;
  let cacheVerts = 0;
  let bakesLeft = 0;
  // Merge a posed group into one mesh per (material, draw order); multi-material
  // boxes and ink lines are kept as they are.
  const BAKE_STD = new Set(['position', 'normal', 'uv']), BAKE_DEF = { slide: [0, 1, 0] };
  function bakePose(g){
    g.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), groups = new Map(), lineGroups = new Map(), root = new THREE.Group();
    g.traverseVisible(o => {
      if (o === g || !(o.isMesh || o.isLineSegments)) return;
      const M = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      const put = (m, range) => { const k = m.uuid + '|' + o.renderOrder;
        if (!groups.has(k)) groups.set(k, { mat: m, ro: o.renderOrder, parts: [] }); groups.get(k).parts.push({ geo: o.geometry, M, range }); };
      if (o.isMesh && !Array.isArray(o.material)) { put(o.material); return; }
      // a multi-material mesh (a box with its own top): each material's triangles into that material's merge
      if (o.isMesh && o.geometry.groups.length && o.geometry.groups.every(gr => o.material[gr.materialIndex])) { for (const gr of o.geometry.groups) put(o.material[gr.materialIndex], gr); return; }
      if (o.isLineSegments && !o.geometry.index) { const k = 'L' + o.material.uuid + '|' + o.renderOrder;   // ink: merged the same way, as lines
        if (!lineGroups.has(k)) lineGroups.set(k, { mat: o.material, ro: o.renderOrder, parts: [] }); lineGroups.get(k).parts.push({ geo: o.geometry, M }); return; }
      const c = o.isMesh ? new THREE.Mesh(o.geometry, o.material) : new THREE.LineSegments(o.geometry, o.material);
      c.renderOrder = o.renderOrder; M.decompose(c.position, c.quaternion, c.scale); root.add(c); o.geometry.userData.kept = true; // referenced, not copied: survives the source's cleanup
    });
    const nm = new THREE.Matrix3(), v = new THREE.Vector3();
    for (const { mat: m, ro, parts } of groups.values()) {
      let nv = 0, ni = 0; const uv = parts.every(p => p.geo.attributes.uv);
      for (const p of parts) { nv += p.geo.attributes.position.count; ni += p.range ? p.range.count : p.geo.index ? p.geo.index.count : p.geo.attributes.position.count; }
      const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uvs = uv ? new Float32Array(nv * 2) : null, idx = new Uint32Array(ni);
      let ov = 0, oi = 0;
      for (const { geo, M, range } of parts) {
        const P = geo.attributes.position, N = geo.attributes.normal, n = P.count; nm.getNormalMatrix(M);
        for (let i = 0; i < n; i++) {
          v.fromBufferAttribute(P, i).applyMatrix4(M); pos.set([v.x, v.y, v.z], (ov + i) * 3);
          if (N) { v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize(); nrm.set([v.x, v.y, v.z], (ov + i) * 3); }
          if (uv) uvs.set([geo.attributes.uv.getX(i), geo.attributes.uv.getY(i)], (ov + i) * 2);
        }
        const r0 = range ? range.start : 0, r1 = range ? range.start + range.count : geo.index ? geo.index.count : n;
        if (geo.index) for (let i = r0; i < r1; i++) idx[oi++] = geo.index.getX(i) + ov; else for (let i = r0; i < r1; i++) idx[oi++] = i + ov;
        ov += n;
      }
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); bg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      if (uv) bg.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      // any other per-vertex data (a site's clipOnly / inside / slide) carried as is — a part without it takes its default
      const extra = new Set(); for (const p of parts) for (const k in p.geo.attributes) if (!BAKE_STD.has(k)) extra.add(k);
      for (const k of extra) { const size = parts.find(p => p.geo.attributes[k]).geo.attributes[k].itemSize, arr = new Float32Array(nv * size), def = BAKE_DEF[k] || [];
        let o = 0; for (const { geo } of parts) { const A = geo.attributes[k], n = geo.attributes.position.count;
          for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) arr[(o + i) * size + c] = A ? A.array[i * A.itemSize + c] : (def[c] || 0);
          o += n; }
        bg.setAttribute(k, new THREE.BufferAttribute(arr, size)); }
      bg.setIndex(new THREE.BufferAttribute(idx, 1)); bg.computeBoundingSphere();
      bg.userData.baked = true; const mesh = new THREE.Mesh(bg, m); mesh.renderOrder = ro; root.add(mesh);
    }
    for (const { mat: m, ro, parts } of lineGroups.values()) {
      let n = 0; for (const p of parts) n += p.geo.attributes.position.count;
      const pos = new Float32Array(n * 3); let o = 0;
      for (const { geo, M } of parts) { const P = geo.attributes.position; for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(M); pos[o++] = v.x; pos[o++] = v.y; pos[o++] = v.z; } }
      const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); bg.computeBoundingSphere(); bg.userData.baked = true;
      const ls = new THREE.LineSegments(bg, m); ls.renderOrder = ro; root.add(ls);
    }
    return root;
  }
  // A cached pose (built now if the frame's build budget allows; else null).
  // rec (optional): whoever will wear the pose — one with nothing to show yet, or starved 6+ frames, is built past the budget (a fixed visit order would otherwise starve whoever comes last).
  function vilFrame(key, kind, t, female, opt, rec){
    let f = vilCache.get(key);
    if (f) { vilCache.delete(key); vilCache.set(key, f); return f; }                     // most recently used last
    if (bakesLeft <= 0 && !(rec && (!rec.obj || (rec.starved = (rec.starved || 0) + 1) > 6))) return null;
    bakesLeft--; if (rec) rec.starved = 0; POLY = 0.6;
    try { const g = animFrame(kind, t, female, opt); f = bakePose(g); g.traverse(o => { if (o.geometry && o.geometry.userData.own && !o.geometry.userData.kept) o.geometry.dispose(); }); } finally { POLY = 1; }
    f.userData.verts = 0; f.traverse(o => { if (o.geometry && o.geometry.userData.baked) f.userData.verts += o.geometry.attributes.position.count; });
    vilCache.set(key, f); cacheVerts += f.userData.verts;
    // held to a vertex budget (≈50MB), least recently used first; poses still worn are kept
    if (cacheVerts > VIL_CACHE_VERTS) for (const [k, old] of vilCache) { if (cacheVerts <= VIL_CACHE_VERTS * 0.8) break;
      if (!vilRefs.get(k)) { old.traverse(o => { if (o.geometry && (o.geometry.userData.baked || o.geometry.userData.own)) o.geometry.dispose(); }); cacheVerts -= old.userData.verts; vilCache.delete(k); } }
    return f;
  }
  const VIL_TOOL = { chop: 'axe', mine_gold: 'pick', mine_stone: 'pick', build: 'mallet', farm: 'scythe' };
  function carriedLoad(e){
    if (e.carryType !== 'food') return e.carryType;
    return e.foodSrc === 'wheat' ? 'food' : e.foodSrc === 'meat' ? 'wool' : 'berries';
  }
  // What a villager is doing, as a lab action (the 2D rig's reading of the same state).
  function villagerPose(e, v){
    const moving = isUnitMoving(e), up = hasUpgrade.bind(null, e.team), opt = {};
    if (moving) {
      const farmWalk = e.task === 'farm' && e.gatherX >= 0 && Math.max(Math.abs(e.x - e.gatherX), Math.abs(e.y - e.gatherY)) < 1.8;
      let kind = 'walk';
      // the load shows only while HAULING along a path (as 2D's carryShow) — not in the last press into contact, where
      // the first bite already lands
      // (a hauler on its way to drop it — task 'return' — keeps it in hand right up to the throw, the last step too)
      if (e.carrying > 0 && !farmWalk && (e.path.length > 0 || e.task === 'return')) { kind = up('wheelbarrow') ? 'barrow' : 'carry'; opt.load = carriedLoad(e); }
      else if (farmWalk && up('heavy_plow')) kind = 'plow';
      else if (isRetreatingUnit(e)) kind = 'flee';
      else if (VIL_TOOL[e.task]) opt.tool = VIL_TOOL[e.task];
      if (kind === 'barrow' && !(e.carrying > 0)) opt.load = null;
      return { kind, t: ((v.stride / WALK_TILES[kind]) % 1 + 1) % 1, opt };
    }
    let atSite = true, bt = null;
    if (e.task === 'chop' || e.task === 'mine_gold' || e.task === 'mine_stone') atSite = e.gatherX >= 0 && atGatherTile(e, e.gatherX, e.gatherY);
    else if (e.task === 'build' && e.buildTarget) { bt = entitiesById.get(e.buildTarget); atSite = !!bt && atBuildSite(e, bt); }
    else if (e.target) atSite = inActionRange(e);
    let kind = 'idle';
    if (e.task === 'return' && e.carrying > 0) { opt.load = carriedLoad(e); return { kind: 'carry', t: 0.25, opt }; } // at the drop, the load still in hand till the throw
    if ((e.task || e.target) && atSite) {
      if (e.task === 'chop') { const felled = e.gatherX >= 0 && map[e.gatherY] && map[e.gatherY][e.gatherX].res <= 60; // a cut tree lies felled: split the trunk on the ground
        kind = felled ? 'split' : up('bow_saw') ? 'saw' : 'chop'; opt.up = { double: up('double_bit_axe') }; }
      else if (e.task === 'mine_gold' || e.task === 'mine_stone') { kind = 'mine'; opt.up = { bright: e.task === 'mine_gold' && up('gold_mining') }; }
      else if (e.task === 'build') kind = bt && bt.complete ? 'repair' : 'build';
      else if (e.task === 'farm') { kind = up('heavy_plow') ? 'plow' : 'farm'; opt.up = { bright: up('horse_collar') }; }
      else if (e.task === 'forage') kind = 'forage';
      else if (!e.task && e.target) { const tg = entitiesById.get(e.target); kind = tg && tg.utype === 'sheep_carcass' ? 'butcher' : 'fight'; }
    } else if (e.carrying > 0) { opt.load = carriedLoad(e); return { kind: 'carry', t: 0.25, opt }; } // waiting with a load
    return { kind, t: workPhase(e, kind), opt };
  }
  // Soldiers (the lab's military frames): march / gallop / roll while moving, the
  // attack while in weapon range, else at rest. The attack rides the REAL reload
  // clock (atkCooldown resets to rof ON the hit — render-units' convention), each
  // swing placed so its blow lands on that reset. Gear: the team's age and forge
  // lines, by unitEquipment's rules.
  const RIG_UNITS = ut => ut !== 'ram' && ut !== 'tradecart'; // vehicles keep the pose cache (their building-style parts carry ink lines)
  const VIL_SOUND = { chop: 'chop', split: 'chop', mine: 'mine', build: 'build', repair: 'build' }; // the 2D work sounds, by 3D action
  const MIL3D = new Set(['militia', 'spearman', 'archer', 'scout', 'knight', 'ram', 'tradecart']);
  const MIL_IMPACT = { militia: 0.6, spearman: 0.5, archer: 0.75, scout: 0.58, knight: 0.58, ram: 0.63 };
  const MIL_STRIDE = { walk: 0.62, gallop: 1.3, roll: 0.76, cart: 0.2825 }; // cart: one ox stride = 1/6 of a wheel turn (r ≈ 0.27, circumference 1.695)                 // ground per cycle (the ram: one wheel turn)
  const milEquip = (ut, team) => ut === 'ram' || ut === 'tradecart' ? null : soldierEquip(ut, ageBonus(team), upgradeAtkBonus(team), upgradeArmorBonus(team), hasUpgrade(team, 'fletching'));
  function soldierPose(e, v){
    const ut = e.utype, opt = { unit: ut, eq: milEquip(ut, e.team) }, cav = ut === 'scout' || ut === 'knight';
    if (ut === 'tradecart') { opt.load = e.carrying > 0; const mv = isUnitMoving(e); return { kind: mv ? 'walk' : 'idle', t: mv ? ((v.stride / MIL_STRIDE.cart) % 1 + 1) % 1 : workPhase(e, 'idle'), opt }; } // the sack while it carries gold
    // The swing follows the HITS: one struck this reload cycle plays its cut (landing on the hit) — on the move too, the
    // legs (or the horse) running on underneath. Gated on being in range alone, a hit on the run showed no blow at all,
    // and a chase flipping in and out of range restarted the swing over and over.
    const rof = (UNITS[ut] && UNITS[ut].rof) || T30(60), cd = e.atkCooldown || 0;
    const swing = e.target && MIL_IMPACT[ut] != null && (cd > 0 || inActionRange(e)) ? ((1 - cd / rof + MIL_IMPACT[ut]) % 1 + 1) % 1 : null;
    if (isUnitMoving(e)) { const kind = cav ? 'gallop' : 'walk', per = ut === 'ram' ? MIL_STRIDE.roll : MIL_STRIDE[kind], lt = ((v.stride / per) % 1 + 1) % 1;
      return swing != null && cd > 0 ? { kind: 'attack', t: swing, opt, target: true, legs: { kind, t: lt } } : { kind, t: lt, opt }; }
    if (swing != null) return { kind: 'attack', t: swing, opt, target: true };
    return { kind: 'idle', t: workPhase(e, 'idle'), opt };
  }
  const vilKey = (kind, step, female, opt) => (opt.unit ? opt.unit + JSON.stringify(opt.eq) + (opt.load === false ? '|e' : '') + '|' : '') + kind + '|' + step + '|' + (female ? 'f' : 'm') + '|' + (opt.load || '') + '|' + (opt.tool || '') + '|' + (opt.up ? (opt.up.double ? 'd' : '') + (opt.up.bright ? 'b' : '') : '') + (opt.noBlood ? '|nb' : '') + (opt.noFly ? '|nf' : '');
  function useVilFrame(rec, key, f, tc){
    if (rec.key === key) return;
    if (rec.obj) { scene.remove(rec.obj); disposeFaded(rec.obj); vilRefs.set(rec.key, (vilRefs.get(rec.key) || 1) - 1); }
    const o = f.clone(), sw = m => tcSwaps.has(m) ? tcSwaps.get(m)(tc) : m;
    if (tc !== VIL_TC) o.traverse(m => { if (m.isMesh) m.material = Array.isArray(m.material) ? m.material.map(sw) : sw(m.material); });
    scene.add(o); rec.obj = o; rec.key = key; vilRefs.set(key, (vilRefs.get(key) || 0) + 1);
  }
  const villagers = new Map();
  // Where each action's target sits in the villager's own frame (world units,
  // +x ahead) — the lab's placements: the model steps in so the tool meets it.
  let WORK_AT = null;
  function workAt(){
    if (WORK_AT) return WORK_AT;
    const L = window.__pov3dLab, h = k => L.toolHead(k, 0.9999)[0], d = new THREE.Vector3(-0.34, 0, -0.94).normalize();
    const chop = h('chop').addScaledVector(d, TRUNK_R * 1.05), mine = h('mine'), saw = L.sawBlade(0);
    return WORK_AT = { chop: [chop.x, chop.z], saw: [saw.x + TRUNK_R * 0.9, saw.z], mine: [mine.x + 0.17, mine.z],
      split: [h('split').x, h('split').z], forage: [ax(FORAGE_REACH[1][0]) + 0.16, 0], butcher: [ax(10) + 0.44, 0], build: [h('build').x, h('build').z], repair: [ax(WALL_X), 0] };
  }
  // The point the villager works on: a resource tile's centre, a carcass, or the
  // nearest point of the building's footprint (building / repairing).
  function workTarget(e, kind){
    if ((kind === 'chop' || kind === 'saw' || kind === 'mine') && e.gatherX >= 0) return [e.gatherX + 0.5, e.gatherY + 0.5];
    if (kind === 'split' && e.gatherX >= 0) { // the nearest point along the fallen trunk (it falls toward +x −z, animateFeatures)
      const sx = e.gatherX + 0.5, sz = e.gatherY + 0.5, L = TREE_H * 0.7, dx = Math.SQRT1_2, dz = -Math.SQRT1_2;
      const u = Math.max(0.15, Math.min(1, ((e.x + 0.5 - sx) * dx + (e.y + 0.5 - sz) * dz) / L)); return [sx + dx * L * u, sz + dz * L * u]; }
    if (kind === 'forage' && e.gatherX >= 0) return [e.gatherX + 0.5, e.gatherY + 0.5];
    if (kind === 'butcher' || kind === 'fight') { const t = entitiesById.get(e.target); if (t) { // a unit where it's drawn; a building at the nearest point of its footprint (not its corner tile)
      if (t.type === 'building') return [Math.max(t.x, Math.min(t.x + (t.w || 1), e.x + 0.5)), Math.max(t.y, Math.min(t.y + (t.h || 1), e.y + 0.5))];
      return animals.has(t.id) || villagers.has(t.id) ? drawnAt(t) : [t.x + 0.5, t.y + 0.5]; } }
    if ((kind === 'build' || kind === 'repair') && e.buildTarget) { const b = entitiesById.get(e.buildTarget); if (b) {
      const px = Math.max(b.x, Math.min(b.x + (b.w || 1), e.x + 0.5)), pz = Math.max(b.y, Math.min(b.y + (b.h || 1), e.y + 0.5)); return [px, pz]; } }
    return null;
  }
  // Cosmetic dust puffs and flying loads (game-side, like the chips).
  const puffs = [], flying = [], loadCache = new Map();
  function puffBurst(x, y, z, n = 4, col = '#cbb892'){
    for (let i = 0; i < n; i++) { const m = new THREE.Mesh(unitSphere(), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, depthWrite: false }));
      m.position.set(x + (Math.random() - 0.5) * 0.12, y, z + (Math.random() - 0.5) * 0.12); m.scale.setScalar(0.03); scene.add(m); puffs.push({ m, age: 0 }); }
  }
  let _usph = null; const unitSphere = () => _usph || (_usph = new THREE.SphereGeometry(1, 8, 6));
  function oreChips(x, y, z, ang, cols){
    for (let i = 0; i < 5; i++) { const m = new THREE.Mesh(unitBox, mat(cols[i % cols.length])); m.scale.set(0.02, 0.016, 0.022); m.position.set(x, y, z); scene.add(m);
      const sp = 0.5 + Math.random() * 0.4, a2 = ang + Math.PI + (Math.random() - 0.5) * 1.8;
      chips.push({ m, v: new THREE.Vector3(Math.cos(a2) * sp, 0.7 + Math.random() * 0.5, Math.sin(a2) * sp), age: 0 }); }
  }
  function loadModel(kind){
    let f = loadCache.get(kind);
    if (!f) { POLY = 0.6; try { const g = new THREE.Group(); load(g, kind, [0, 0, 0]); addHulls(g, true); f = bakePose(g); } finally { POLY = 1; } loadCache.set(kind, f); }
    return f.clone();
  }
  function updateFlyers(dt){
    for (let i = puffs.length - 1; i >= 0; i--) { const p = puffs[i]; p.age += dt; p.m.scale.setScalar(0.03 * (1 + p.age * 3)); p.m.position.y += dt * 0.08; p.m.material.opacity = Math.max(0, 0.7 - p.age);
      if (p.age > 0.8) { scene.remove(p.m); p.m.material.dispose(); puffs.splice(i, 1); } }
    for (let i = flying.length - 1; i >= 0; i--) { // a thrown load: an arc from the hands into the drop-off, a puff where it lands
      const f = flying[i]; f.age += dt; const u = Math.min(1, f.age / f.dur);
      f.obj.position.set(f.a[0] + (f.b[0] - f.a[0]) * u, f.a[1] + (f.b[1] - f.a[1]) * u + f.h * 4 * u * (1 - u), f.a[2] + (f.b[2] - f.a[2]) * u);
      f.obj.rotation.set(0, f.yaw, -0.6 * u);
      if (u >= 1) { puffBurst(f.b[0], f.b[1], f.b[2], 5); scene.remove(f.obj); flying.splice(i, 1); }
    }
  }
  const THROW_MS = 560; // the drop pose played from its knee dip (0.12) through the follow-through (0.5)
  // Place and pose one villager; false when it has no 3D pose yet (it shows as art this frame).
  function updateVillager3D(e, dt){
    const now = performance.now();
    let [tx, tz] = posOf(e), ty = -worldFacing(e);
    let v = villagers.get(e.id);
    if (!v) villagers.set(e.id, v = { obj: null, key: '', x: tx, z: tz, yaw: ty, stride: 0, carry: e.carrying, lastT: 0 });
    // A load gone at a drop-off: throw it in (the sim banked it already; this is the show).
    if (v.carry > 0 && !(e.carrying > 0) && v.ctype) {
      let best = null, bd = 1.6;                                                    // measured to the footprint's edge, as the sim's drop-off contact (a TC corner is 3.5 tiles from its centre)
      for (const b of entities) if (b.type === 'building' && b.team === e.team && b.complete !== false && dropAccepts(b, v.ctype)) {
        const d = edgeDistToBuilding(e.x, e.y, b); if (d < bd) { bd = d; best = b; } }
      if (best) v.throw = { at: now, load: v.cload, b: best, flew: false };
    }
    v.carry = e.carrying; if (e.carrying > 0) { v.ctype = e.carryType; v.cload = carriedLoad(e); }
    let p = e.utype === 'villager' ? villagerPose(e, v) : soldierPose(e, v);
    // A swing the player asked for (first person: click / Space / ACT): played at once, while the command it sent takes effect.
    if (e.id === followId && swingAt && now - swingAt < SWING_MS && p.kind !== 'attack') {
      const u = (now - swingAt) / SWING_MS, sol = e.utype !== 'villager';
      const tk = { chop: 'chop', mine_gold: 'mine', mine_stone: 'mine', build: 'build', farm: 'farm' }[e.task];
      const legs = isUnitMoving(e) && /^(walk|gallop|flee|carry)$/.test(p.kind) ? { kind: p.kind, t: p.t } : null; // swinging on the run: the legs keep walking
      p = { kind: sol ? 'attack' : (tk || 'fight'), t: sol ? u * 0.95 : tk ? (u + 0.3) % 1 : u, opt: p.opt, target: p.target, legs };
    }
    // First person, a melee strike is the FPS kind: the arm holds its ready pose and the viewmodel itself slashes
    // across the view (a spear jabs), phased off the same clock as the attack pose — the cut lands on the hit.
    // (foot soldiers only — the ones drawn as a viewmodel; a rider keeps its own swing, seen from the saddle)
    v.fpStrike = null;
    const vmUnit = e.id === followId && mode === 'eye' && RIG_UNITS(e.utype) && !isMountedUnit(e.utype);
    if (vmUnit && p.kind === 'attack' && e.utype !== 'villager' && !(e.range > 0) && MIL_IMPACT[e.utype] != null) {
      v.fpStrike = ((p.t - MIL_IMPACT[e.utype]) % 1 + 1) % 1;                        // 0 at the hit
      p = p.legs ? { kind: p.legs.kind, t: p.legs.t, opt: p.opt } : { kind: 'idle', t: workPhase(e, 'idle'), opt: p.opt };
    }
    if (vmUnit && VM.force != null) { v.fpStrike = VM.force; if (p.kind === 'attack') p = { kind: 'idle', t: 0, opt: p.opt }; } // dev: a pinned strike phase
    v.lastPose = p.kind; v.lastLoad = p.opt && p.opt.load; // (dev: __povVM, __povPose)
    if (v.throw) { const el = now - v.throw.at, b = v.throw.b, bx = b.x + (b.w || 1) / 2, bz = b.y + (b.h || 1) / 2;
      if (el > THROW_MS) v.throw = null;
      else { const t = 0.12 + 0.38 * el / THROW_MS;
        // It throws standing at the drop, turned to the building — though the sim sends it off the tick it drops: the
        // drawn villager holds its spot for the throw (below) and catches up after, at a walk
        p = { kind: 'drop', t, opt: { load: v.throw.load, noFly: true } };
        ty = -Math.atan2(bz - v.z, bx - v.x);
        if (!v.throw.flew && t >= REL) { v.throw.flew = true; const o = loadModel(v.throw.load); scene.add(o);
          const fw = [Math.cos(-ty), Math.sin(-ty)];
          flying.push({ obj: o, age: 0, dur: 0.5, h: 0.35, yaw: ty, a: [v.x + fw[0] * ax(6.7), chh(-19.3 - LOAD_SIT[v.throw.load]), v.z + fw[1] * ax(6.7)], b: [bx, 0.22, bz] }); } } }
    // Working: face the target and step in so the tool meets it — as far as the sim lets a worker stand off (a sheep
    // from its 1.5-tile ring, a tree from a diagonal neighbour), ≤ 1.6 tiles off the sim spot; it walks there (below).
    const W = workAt()[p.kind], T = W && workTarget(e, p.kind);
    if (T) { const ph = Math.atan2(T[1] - (e.y + 0.5), T[0] - (e.x + 0.5)), c = Math.cos(ph), sn = Math.sin(ph);
      const px = T[0] - (W[0] * c - W[1] * sn), pz = T[1] - (W[0] * sn + W[1] * c);
      if ((px - tx) ** 2 + (pz - tz) ** 2 < 1.6 * 1.6) { tx = px; tz = pz; }
      if (!isUnitMoving(e)) { ty = -ph; setHeading(e, ph); }                   // at work: turned to what it works on
      // A blow lands as the swing wraps: the target reacts.
      if (p.t < v.lastT - 0.5 && (p.kind === 'mine' || p.kind === 'split' || p.kind === 'build' || p.kind === 'repair' || p.kind === 'butcher')) {
        const hitX = T[0] - c * 0.08, hitZ = T[1] - sn * 0.08;
        if (p.kind === 'mine') oreChips(hitX, 0.22, hitZ, ph, e.task === 'mine_gold' ? ['#e8b90f', '#f5d44a', '#9d9d9d'] : ['#9d9d9d', '#bdbdbd', '#7c7c7c']);
        else if (p.kind === 'butcher') oreChips(hitX, 0.15, hitZ, ph, ['#f2eddd', '#b33']);
        else if (p.kind === 'split') chipBurst(T[0], 0.08, T[1], ph);
        else { puffBurst(hitX, 0.3, hitZ, 3); if (p.kind === 'build') chipBurst(hitX, 0.25, hitZ, ph); }
      }
    } else if (p.kind === 'fight' || p.target) { const t2 = workTarget(e, 'fight'); if (t2) { const h = Math.atan2(t2[1] - (e.y + 0.5), t2[0] - (e.x + 0.5)); ty = -h; setHeading(e, h); } } // face whom (or what) it strikes
    // Sounds: the 2D draw plays work swings and the ram's thud/creak, but only for
    // units on the 2D screen — one the 3D view shows beyond it sounds from here,
    // at its 3D blow (never both). Viewer-only, like the 2D's.
    if (window.playSound) {
      const off2D = () => { if (world) return true; const sc = mapToScreen(e.x, e.y); return isOffscreen(sc.sx, sc.sy + HALF_TH, 50); }; // the 3D world view: no 2D draw at all
      const snd = VIL_SOUND[p.kind];
      if (e.utype === 'villager' && snd && p.t < v.lastT - 0.5 && off2D()) { v.snd = (v.snd || 0) + 1; if (GAME_SPEED < 4 || v.snd % 2 === 0) playSound(snd, e.x, e.y); } // every other blow at 4x, as the 2D
      if (e.utype === 'ram' && p.kind === 'attack' && e.target && (v.lastT < MIL_IMPACT.ram) !== (p.t < MIL_IMPACT.ram) && p.t >= MIL_IMPACT.ram && off2D()) playSound('ram_hit', e.x, e.y);
      if (e.utype === 'ram' && p.kind === 'walk') { const ck = Math.floor((aTick + e.id * 7) / 90);
        if (v.creak !== undefined && v.creak !== ck && (GAME_SPEED < 4 || ck % 2 === 0) && off2D()) playSound('ram_creak', e.x, e.y); v.creak = ck; }
    }
    v.lastT = p.t; v.t = p.t; v.farm = p.kind === 'farm' || p.kind === 'plow' ? [e.gatherX, e.gatherY] : null;
    if (p.kind === 'farm') { const pts = window.__pov3dLab.toolHead('farm', Math.floor(p.t * VIL_STEPS) / VIL_STEPS), c = Math.cos(-v.yaw), sn = Math.sin(-v.yaw);
      for (const i of [2, 4, 6]) { const q = pts[i]; if (q.y < 0.2) bladePush.push([v.x + q.x * c - q.z * sn, v.z + q.x * sn + q.z * c]); } } // the blade skimming the crop
    // The sim walks straight legs (smoothPath, js/pathfinding.js): a mover is drawn at its TRUE spot, facing its leg —
    // no smoothing overlay of its own to drift off it and catch up when it stops. Work spots ease in; standing units sit.
    // (the drawn spot runs a tick behind the sim: still gliding into the final spot after the sim has stopped, it is moving)
    const mv = isUnitMoving(e), gliding = (tx - (e.x + 0.5)) ** 2 + (tz - (e.y + 0.5)) ** 2 > 1e-6, far = (tx - v.x) ** 2 + (tz - v.z) ** 2 > 4;
    let nx, nz;
    if (far || ((mv || gliding) && !T)) { nx = tx; nz = tz;
      if (mv && !T && e.path.length) ty = -Math.atan2(e.path[0].y - e.y, e.path[0].x - e.x);
    } else if (!mv && !v.throw && e.utype === 'villager' && (tx - v.x) ** 2 + (tz - v.z) ** 2 > 0.03 * 0.03) {
      // A villager off its spot (into a work spot, back out of one) walks there, at a walk, legs and all — a load in
      // hand stays in hand (the carrying walk); never over a throw (it stands for that: held below)
      const dx = tx - v.x, dz = tz - v.z, d = Math.hypot(dx, dz), step = Math.min(d, WALK_IN * GAME_SPEED * dt), wk = p.opt && p.opt.load ? 'carry' : 'walk';
      nx = v.x + dx / d * step; nz = v.z + dz / d * step; v.stride += step;
      ty = -Math.atan2(dz, dx); p = { kind: wk, t: ((v.stride / WALK_TILES[wk]) % 1 + 1) % 1, opt: p.opt };
    } else { const f = T ? Math.min(1, dt * 10) : Math.min(1, dt * 14); nx = v.x + (tx - v.x) * f; nz = v.z + (tz - v.z) * f; }
    v.ptx = tx; v.ptz = tz;
    if (steerActive() && e.id === followId && (mv || (!e.target && !T && !e.task)) || (!T && steeredFacing(e))) { ty = -yaw; setHeading(e, yaw); } // the steered character faces where it's steered, and keeps it
    if (v.throw) { nx = v.x; nz = v.z; }                                            // (held at the drop while it throws)
    if (!T) v.stride += Math.hypot(nx - v.x, nz - v.z);
    v.x = nx; v.z = nz;
    v.yaw += Math.atan2(Math.sin(ty - v.yaw), Math.cos(ty - v.yaw)) * Math.min(1, dt * 8);
    const fpv = e.id === followId && mode === 'eye' && RIG_UNITS(e.utype) && !isMountedUnit(e.utype);   // seen through its own eyes: arms as a viewmodel
    if (RIG_UNITS(e.utype)) { if (!rigPose(v, p.kind, p.t, e.female, p.opt, teamColor(e.team), VIL_STEPS, e.id === followId && mode === 'eye', p.legs)) return false; }
    else { const step = Math.floor(p.t * VIL_STEPS) % VIL_STEPS, key = vilKey(p.kind, step, e.female, p.opt);
      const fr = vilFrame(key, p.kind, step / VIL_STEPS, e.female, p.opt, v);
      if (fr) useVilFrame(v, key, fr, teamColor(e.team));
      if (!v.obj) return false; }
    if (fpv) viewmodel(v, e);
    else { if (v.obj.userData.vm) { v.obj.matrixAutoUpdate = true; v.obj.userData.vm = false; } v.obj.position.set(v.x, 0, v.z); v.obj.rotation.y = v.yaw; }
    return true;
  }
  // First person, as games do it: forearms, hands and what they hold ride with the camera (a viewmodel), so they're
  // always in view looking up or down. Framed on the hands: the arm turns forward about the shoulder line to lift
  // hands that hang low (at the hips at rest), and the whole slides so the hands' average spot sits at VM.at on screen
  // (a little below and right of centre) whether the pose holds them high, low or off to a side — both eased slowly,
  // so a swing still sweeps across the view rather than being held still. Upper arms and shoulders never show.
  const VM = { aim: 0.12, down: 0.12, back: -0.3, ease: 1.5, at: [0.12, -0.22], near: 0.24 };  // lift: hands' angle below level (rad); the shoulders' spot below / behind (− ahead of) the lens (tiles); easing (1/s); the hands' screen spot (tan right, tan up); the hands' nearest distance ahead (tiles)
  let _vm = null;
  // The strike's swing at phase u (0 = the hit): [pitch up, roll (+ top to the left), push ahead] about the shoulders.
  // A slash winds up high and right, cuts down-left through the middle at the hit, then settles; a spear is lowered
  // level, drawn back, and thrust.
  function strikeSwing(u, spear){
    const sm = x => x * x * (3 - 2 * x), W = u >= 0.7 ? sm((u - 0.7) / 0.3) : 0, H = u < 0.12 ? sm(u / 0.12) : 0, R = u >= 0.12 && u < 0.5 ? 1 - sm((u - 0.12) / 0.38) : 0;
    if (spear) { // lowered level (the point ahead) through the wind-up, drawn back, then thrust out at the hit and eased home
      const lv = u >= 0.7 ? W : u < 0.12 ? 1 : R;
      return [-1.15 * lv, 0.15 * lv, u >= 0.7 ? -0.1 * W : u < 0.12 ? -0.1 + 0.32 * H : 0.22 * R]; }
    const up = [0.55, -0.55, 0], cut = [-0.45, 0.6, 0.04];                           // wound up (high, top leaning right) → cut through (low, leaning left)
    const k = u >= 0.7 ? W : u < 0.12 ? 1 - H : 0, c = u < 0.12 ? H : R;
    return up.map((a, i) => a * k + cut[i] * c);
  }
  function viewmodel(v, who){
    const root = v.obj;
    if (!_vm) _vm = { m: new THREE.Matrix4(), r: new THREE.Matrix4(), t: new THREE.Matrix4() };
    const S = chh(-8);                                                              // the shoulder line's height (model)
    const h = v.fpHands || [0.03, S - 0.17, 0], want = Math.max(0, Math.min(2.2, Math.atan2(S - h[1], Math.max(0.01, h[0])) - VM.aim));
    const first = v.vmTilt == null || !root.userData.vm, e = first ? 1 : Math.min(1, camDt * VM.ease);
    v.vmTilt = first ? want : v.vmTilt + (want - v.vmTilt) * e;
    // where the hands land in camera space at this tilt (x right, y up, −z ahead), and the slide that puts them at VM.at
    const c = Math.cos(v.vmTilt), sn = Math.sin(v.vmTilt), hx = h[0], hy = h[1] - S;
    const px = h[2], py = -VM.down + hx * sn + hy * c, pz = VM.back - (hx * c - hy * sn), d = Math.max(0.12, -pz);
    const sx = VM.at[0] * d - px, sy = VM.at[1] * d - py;
    v.vmSlide = first || !v.vmSlide ? [sx, sy] : [v.vmSlide[0] + (sx - v.vmSlide[0]) * e, v.vmSlide[1] + (sy - v.vmSlide[1]) * e];
    const push = Math.max(0, VM.near + pz);                                          // a wind-up swings the hands back at the lens: held off at VM.near

    camera.updateMatrixWorld();
    // model (x forward, y up, z right) → camera (−z forward, y up, x right), turned forward by the tilt about the shoulders
    _vm.r.set(0, 0, 1, 0,  0, 1, 0, 0,  -1, 0, 0, 0,  0, 0, 0, 1).multiply(_vm.t.makeRotationZ(v.vmTilt));
    _vm.m.copy(camera.matrixWorld).multiply(_vm.t.makeTranslation(v.vmSlide[0], -VM.down + v.vmSlide[1], VM.back - push));
    if (v.fpStrike != null) { const [pu, ro, fw] = strikeSwing(v.fpStrike, who.utype === 'spearman');
      _vm.m.multiply(_vm.t.makeTranslation(0, 0, -fw)).multiply(_vm.t.makeRotationX(pu)).multiply(_vm.t.makeRotationZ(ro)); }
    _vm.m.multiply(_vm.r).multiply(_vm.t.makeTranslation(0, -S, 0));
    root.matrixAutoUpdate = false; root.userData.vm = true;
    root.matrix.copy(_vm.m); root.matrixWorldNeedsUpdate = true;
  }
  // ---- Rigs: units posed on the GPU, never rebuilt ----
  // A TEMPLATE per (unit, gear, action, part layout) is built once from the
  // same builders the lab uses: every rigid part (blob, pole, blade, shield…)
  // becomes one bone, every bendy tube a bone per ring; parts and their
  // outline hulls are merged by material into skinned meshes (≈ the baked
  // pose's draw calls). A POSE SAMPLE is a light build (no geometry for tubes,
  // no hulls, no merge) read back as bone matrices — a few KB, cached per
  // step, shared by every unit in that state. Each frame a unit blends two
  // samples into its own bone array. Viewer-only (never read by the sim).
  let RIG_LIGHT = false, RIG_NOHULL = false;
  const FP_ARM = 0.6;                                         // first person: how far the forearm runs on back past the elbow (tiles)
  let _fpA = null;
  const RIG_SEG = 8, RIG_RAD = 7;                             // rings along a tube, sides round it
  const rigTemplates = new Map(), rigSamples = new Map();
  let rigSampleUntil = 0, rigTemplateBudget = 0, warmFrames = 0;
  // The parts of a built frame, in build order: [{ o, tube }] (tube: its ring record).
  function rigParts(g){
    const parts = [];
    g.traverse(o => { if (o.userData.tubeRec) parts.push({ o, tube: o.userData.tubeRec }); else if (o.isMesh && !o.userData.hullOf) parts.push({ o }); });
    return parts;
  }
  const rigSig = parts => parts.map(p => p.tube ? 't' : (p.o.geometry && p.o.geometry.type || 'm')[0]).join('');
  // Ring frames along a tube's curve (the TubeGeometry's own Frenet frames): RIG_SEG+1 matrices.
  let _rm = null; // made lazily: THREE loads on demand
  // M: the tube's own world matrix — its curve is in its parent group's frame (a torso pivot, a tumbling dropped bow…)
  function tubeFrames(rec, out, at, M){
    _rm = _rm || new THREE.Matrix4();
    const path = new THREE.CatmullRomCurve3(rec.pts), fr = path.computeFrenetFrames(RIG_SEG, false);
    for (let i = 0; i <= RIG_SEG; i++) {
      const P = path.getPointAt(i / RIG_SEG);
      _rm.makeBasis(fr.tangents[i], fr.normals[i], fr.binormals[i]).setPosition(P).premultiply(M);
      _rm.toArray(out, at + i * 16);
    }
  }
  // Bone matrices of a built frame (hidden parts → zero: they vanish).
  function rigRead(g, parts){
    g.updateMatrixWorld(true);
    const vis = new Set(); g.traverseVisible(o => vis.add(o));
    let n = 0; for (const p of parts) n += p.tube ? RIG_SEG + 1 : 1;
    const out = new Float32Array(n * 16); let at = 0;
    for (const p of parts) {
      if (p.tube) { if (vis.has(p.o)) tubeFrames(p.tube, out, at, p.o.matrixWorld); at += (RIG_SEG + 1) * 16; }
      else { if (vis.has(p.o)) p.o.matrixWorld.toArray(out, at); at += 16; }
    }
    return out;
  }
  // Merge buckets: material → { mat, order, pos[], nrm[], uv[], bone[], idx[] }.
  const rigPlainMats = new Map();
  const rigPlainMat = side => { let m = rigPlainMats.get(side);
    if (!m) rigPlainMats.set(side, m = new THREE.MeshLambertMaterial({ vertexColors: true, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })); return m; };
  function rigAdd(B, mat, order, geo, bone, M){
    const k = mat.uuid + '|' + order; let b = B.get(k);
    if (!b) B.set(k, b = { mat, order, pos: [], nrm: [], uv: [], bone: [], idx: [] });
    const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv, base = b.pos.length / 3, v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i); if (M) v.applyMatrix4(M); b.pos.push(v.x, v.y, v.z);
      if (N) b.nrm.push(N.getX(i), N.getY(i), N.getZ(i)); else b.nrm.push(0, 1, 0);
      if (U) b.uv.push(U.getX(i), U.getY(i)); else b.uv.push(0, 0);
      b.bone.push(bone);
    }
    return { b, base };
  }
  function rigIndex(b, base, geo, start = 0, count){ // triangles of geo (or a group's range) into bucket b
    const I = geo.index, n = count != null ? count : (I ? I.count : geo.attributes.position.count);
    for (let i = start; i < start + n; i++) b.idx.push((I ? I.getX(i) : i) + base);
  }
  // A tube's rings as template geometry (ring-local: x along the tube, the circle in y/z).
  function ringGeo(r){
    const pos = [], nrm = [], ring = [], idx = [];
    for (let i = 0; i <= RIG_SEG; i++) for (let j = 0; j <= RIG_RAD; j++) { const a = j / RIG_RAD * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pos.push(0, c * r, s * r); nrm.push(0, c, s); ring.push(i); }
    for (let i = 0; i < RIG_SEG; i++) for (let j = 0; j < RIG_RAD; j++) { const a = i * (RIG_RAD + 1) + j, b = a + RIG_RAD + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1); }                            // wound outward (frame T, N, B right-handed)
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setIndex(idx);
    return { g, ring };
  }
  // Build a template from a full (non-light) frame.
  function rigTemplate(kind, t, female, opt){
    POLY = 0.6; RIG_NOHULL = true; let g;
    try { g = animFrame(kind, t, female, opt); } finally { POLY = 1; RIG_NOHULL = false; }
    g.updateMatrixWorld(true);
    const parts = rigParts(g), B = new Map(), s = new THREE.Vector3(), inv = new THREE.Matrix4();
    let bone = 0; const fpBones = [], fpFold = [];
    for (const p of parts) {
      if (p.o.userData.fpHide) for (let i = 0; i < (p.tube ? RIG_SEG + 1 : 1); i++) fpBones.push(bone + i); // (a tube: all its ring bones)
      if (p.tube && p.o.userData.fpForearm) fpFold.push(bone);
      if (p.tube) { // rings: surface and a fatter outline ring, both on the ring bones
        for (const [r, m, ord] of [[p.tube.r, p.o.material || mat(p.tube.col), 2], [p.tube.r, hullUnionMat, 1]]) { // (the outline ring: pushed out on screen)
          const { g: rg, ring } = ringGeo(r), { b, base } = rigAdd(B, m, ord, rg, 0, null);
          for (let i = 0; i < ring.length; i++) b.bone[base + i] = bone + ring[i];
          rigIndex(b, base, rg); rg.dispose();
        }
        bone += RIG_SEG + 1; continue;
      }
      const o = p.o, geo = o.geometry, mats = [].concat(o.material);
      if (Array.isArray(o.material) && geo.groups.length) for (const gr of geo.groups) { const { b, base } = rigAdd(B, mats[gr.materialIndex], 2, geo, bone, null); rigIndex(b, base, geo, gr.start, gr.count); }
      else { const { b, base } = rigAdd(B, mats[0], 2, geo, bone, null); rigIndex(b, base, geo); }
      // Its outline, made at the part's size in THIS pose: a part that stretches between samples (a pole, a
      // squashed blob) keeps the outline width of the template pose — fine for these small ranges.
      if (o.userData.hullGeo) { o.getWorldScale(s).set(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
        const hg = hullGeometry(o.userData.hullGeo, s, o.userData.hullW || HULL, null, true);
        if (hg) { const { b, base } = rigAdd(B, hullUnionMat, 1, hg, bone, null); rigIndex(b, base, hg); hg.dispose(); } }
      for (const c of o.children) if (c.isLineSegments) { const { b, base } = rigAdd(B, c.material, 3, c.geometry, bone, null); b.lines = true; rigIndex(b, base, c.geometry); } // edge ink (posts), on the part's bone
      bone++;
    }
    // Plain-coloured parts (skin, cloth, leather, wood: no texture, no team colour, opaque) go in ONE mesh per side,
    // coloured per vertex — a unit is a handful of draws, not one per colour
    const plain = m => m.isMeshLambertMaterial && !m.map && !m.userData.detail && !m.transparent && !tcSwaps.has(m) && !HULL_MATS.has(m) && m.userData.plain; // (a mat() colour: fog is patched on at draw, on the merged one too)
    for (const side of [THREE.FrontSide, THREE.DoubleSide]) {
      const group = [...B.entries()].filter(([, b]) => !b.lines && b.order === 2 && plain(b.mat) && b.mat.side === side);
      if (group.length < 2) continue;
      const m = { mat: rigPlainMat(side), order: 2, pos: [], nrm: [], uv: [], bone: [], idx: [], col: [] };
      for (const [k, b] of group) { const base = m.pos.length / 3, c = b.mat.color;
        m.pos.push(...b.pos); m.nrm.push(...b.nrm); m.uv.push(...b.uv); m.bone.push(...b.bone);
        for (let i = 0; i < b.pos.length / 3; i++) m.col.push(c.r, c.g, c.b);
        for (const i of b.idx) m.idx.push(i + base); B.delete(k); }
      B.set('plain|' + side, m);
    }
    const meshes = [];
    for (const b of B.values()) {
      const geo = new THREE.BufferGeometry(), n = b.pos.length / 3, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      if (b.col) geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      for (let i = 0; i < n; i++) { si[i * 4] = b.bone[i]; sw[i * 4] = 1; }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2)); geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      geo.setIndex(b.idx); geo.userData.rig = true;
      meshes.push({ geo, mat: b.mat, order: b.order, lines: !!b.lines });
    }
    window.__pov3dLab.dispose(g);
    return { meshes, bones: bone, fpBones, fpFold, sig: rigSig(parts), verts: meshes.reduce((a, m) => a + m.geo.attributes.position.count, 0) };
  }
  // A pose sample: bone matrices at step `step` (light build; cached).
  function rigSample(tkey, kind, t, female, opt){
    let s = rigSamples.get(tkey);
    if (s) return s;
    if (performance.now() > rigSampleUntil) return null;                      // ≤1.5ms of sampling a frame (the rest wait: a unit keeps its last pose)
    frameParts.samp++;
   
    RIG_LIGHT = true; RIG_NOHULL = true; POLY = 0.6; let g;
    try { g = animFrame(kind, t, female, opt); } finally { RIG_LIGHT = false; RIG_NOHULL = false; POLY = 1; }
    const parts = rigParts(g); s = { sig: rigSig(parts), m: rigRead(g, parts) };
    window.__pov3dLab.dispose(g);
    rigSamples.set(tkey, s);
    if (rigSamples.size > 6000) { const it = rigSamples.keys(); for (let i = 0; i < 1000; i++) rigSamples.delete(it.next().value); } // tiny, but bounded
    return s;
  }
  function rigTemplateFor(base, sig, kind, t, female, opt){
    const k = base + '#' + sig; let T = rigTemplates.get(k);
    if (!T) { if (rigTemplateBudget <= 0) return null; rigTemplateBudget--; const tb = performance.now(); T = rigTemplate(kind, t, female, opt); frameParts.tpl = (frameParts.tpl || 0) + performance.now() - tb; if (T.sig !== sig) console.warn('rig: layout moved', k, T.sig.length, sig.length); rigTemplates.set(k, T); }
    return T;
  }
  // A unit's skinned instance of a template (shared geometry/materials, its own bones; team colour swapped).
  // bindMode 'detached': the default 'attached' re-inverts each mesh's own world matrix every frame, which cancels the unit's placement
  function rigInstance(T, tc){
    // the bones are never moved (rigPose writes the bone matrices directly): every instance of a template shares one
    // set, and its inverses — a unit is then its meshes and a bone texture, not ~60 scene objects of its own
    if (!T.skBones) { T.skBones = Array.from({ length: T.bones }, () => new THREE.Bone()); T.skInv = T.skBones.map(() => new THREE.Matrix4()); }
    const sk = new THREE.Skeleton(T.skBones, T.skInv);
    sk.update = function(){ if (this.boneTexture) this.boneTexture.needsUpdate = true; }; // the bone array is written directly (rigPose)
    const root = new THREE.Group(), sw = m => tcSwaps.has(m) ? tcSwaps.get(m)(tc) : m, id = new THREE.Matrix4();
    for (const m of T.meshes) { if (m.lines) continue; const sm = new THREE.SkinnedMesh(m.geo, tc !== VIL_TC ? sw(m.mat) : m.mat); sm.bindMode = 'detached'; sm.bind(sk, id); sm.renderOrder = m.order; sm.frustumCulled = false; root.add(sm); }
    return { root, sk, T };
  }
  // Pose a unit record v (its rig lives in v.rig): kind at phase t (0..1), blended between samples.
  // The lower body (legs, feet, a mount) of a walk laid under another pose: the two part lists are aligned by type
  // (a hand or tool can sit elsewhere in one), and a matched part low in BOTH poses copies over — pairs of
  // [from bone, to bone, count], read once per pose pair.
  const legMaps = new Map();
  function legMap(key, ws, as, w, a, cav){
    let m = legMaps.get(key); if (m) return m;
    const off = sig => { const o = []; let b = 0; for (const c of sig) { o.push(b); b += c === 't' ? RIG_SEG + 1 : 1; } return o; };
    const wo = off(ws), ao = off(as), L = Array.from({ length: ws.length + 1 }, () => new Uint16Array(as.length + 1));
    for (let x = ws.length - 1; x >= 0; x--) for (let y = as.length - 1; y >= 0; y--) L[x][y] = ws[x] === as[y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
    let H = 0; for (let k = 13; k < w.length; k += 16) H = Math.max(H, w[k]);
    const thr = H * (cav ? 0.6 : 0.46), top = (arr, b, n) => { let t = -Infinity; for (let k = 0; k < n; k++) t = Math.max(t, arr[(b + k) * 16 + 13]); return t; };
    m = [];
    for (let x = 0, y = 0; x < ws.length && y < as.length;) {
      if (ws[x] === as[y]) { const n = ws[x] === 't' ? RIG_SEG + 1 : 1; if (top(w, wo[x], n) < thr && top(a, ao[y], n) < thr) m.push(wo[x], ao[y], n); x++; y++; }
      else if (L[x + 1][y] >= L[x][y + 1]) x++; else y++;
    }
    legMaps.set(key, m); return m;
  }
  function rigPose(v, kind, t, female, opt, tc, steps = VIL_STEPS, fp = false, legs = null){ // fp: seen through its own eyes — the head parts collapse; legs: {kind, t} the lower body plays instead
    const base = vilKey(kind, 'x', female, opt), u = ((t % 1) + 1) % 1 * steps, s0 = Math.floor(u) % steps, s1 = (s0 + 1) % steps, f = u - Math.floor(u);
    const A = rigSample(base + '@' + s0, kind, s0 / steps, female, opt), Bs = A && (rigSample(base + '@' + s1, kind, s1 / steps, female, opt) || A);
    if (!A) return !!v.rig;                                                     // keep the last pose until the sample's built
    const T = rigTemplateFor(base, A.sig, kind, s0 / steps, female, opt);
    if (!T) return !!v.rig;
    if (!v.rig || v.rig.T !== T || v.rig.tc !== tc) {
      // an action whose parts come and go (an arrow drawn, a tool fetched) flips between templates: each unit keeps the
      // few it has used and swaps, never rebuilding (a rebuild is new meshes, bones and x-ray twins — a crowd's worth a frame)
      const rigs = v.rigs || (v.rigs = new Map());
      if (v.rig) scene.remove(v.rig.root);
      let r = rigs.get(T); if (r && r.tc !== tc) { freeRig(r); rigs.delete(T); r = null; }
      if (!r) { const ti = performance.now(); r = rigInstance(T, tc); frameParts.inst = (frameParts.inst || 0) + performance.now() - ti; r.tc = tc; rigs.set(T, r);
        if (rigs.size > RIG_KEEP) for (const [k, o] of rigs) if (o !== r) { freeRig(o); rigs.delete(k); break; } }   // (the oldest goes)
      else { rigs.delete(T); rigs.set(T, r); }                                              // (most recent last)
      v.rig = r; scene.add(r.root);
    }
    const out = v.rig.sk.boneMatrices, a = A.m, b = Bs.sig === A.sig ? Bs.m : a;
    if (out.length >= a.length) for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * f; // (three pads the array to its bone-texture size)
    if (legs) { // the walk's lower body under this pose's upper body (legMap)
      const lb = vilKey(legs.kind, 'x', female, opt), lu = ((legs.t % 1) + 1) % 1 * steps, l0 = Math.floor(lu) % steps, l1 = (l0 + 1) % steps, lf = lu - Math.floor(lu);
      const LA = rigSample(lb + '@' + l0, legs.kind, l0 / steps, female, opt), LB = LA && (rigSample(lb + '@' + l1, legs.kind, l1 / steps, female, opt) || LA);
      if (LA && out.length >= a.length) {
        const w = LA.m, w2 = LB.sig === LA.sig ? LB.m : w, m = legMap(base + '|' + lb, LA.sig, A.sig, w, a, legs.kind === 'gallop');
        for (let q = 0; q < m.length; q += 3) for (let k = 0; k < m[q + 2] * 16; k++) out[m[q + 1] * 16 + k] = w[m[q] * 16 + k] + (w2[m[q] * 16 + k] - w[m[q] * 16 + k]) * lf;
      }
    }
    if (fp) { for (const bi of T.fpBones) out.fill(0, bi * 16, bi * 16 + 16);
      // the upper arm: from the elbow it curves on toward where the shoulder really sits (below and beside the lens), and
      // past it out of view — a real arm's bend, not a stump or a straight pipe. Each ring turns to follow the curve.
      const mid = RIG_SEG >> 1; // the elbow: the arm's curve passes through it halfway
      _fpA = _fpA || { m: new THREE.Matrix4(), q: new THREE.Quaternion(), f: new THREE.Vector3(), t: new THREE.Vector3(), p: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Vector3(), e: new THREE.Vector3() };
      const A = _fpA;
      for (const b0 of T.fpFold) { const E = (b0 + mid) * 16, Hd = (b0 + RIG_SEG) * 16;
        A.e.set(out[E + 12], out[E + 13], out[E + 14]);
        A.f.set(out[E + 12] - out[Hd + 12], out[E + 13] - out[Hd + 13], out[E + 14] - out[Hd + 14]).normalize();   // the forearm's line, hand → elbow
        // the shoulder (model: x ahead, y up, z right): the arm's own root, carried on down and back out of view
        A.s.set(out[b0 * 16 + 12] - FP_ARM * 0.35, out[b0 * 16 + 13] - FP_ARM * 0.6, out[b0 * 16 + 14] * 0.8);
        A.c.copy(A.e).addScaledVector(A.f, FP_ARM * 0.3);                                    // the bend: on along the forearm a little first
        for (let i = 0; i < mid; i++) { const o = (b0 + i) * 16, u = i / mid;                    // u: 0 at the far end, 1 at the elbow
          A.p.copy(A.s).multiplyScalar((1 - u) * (1 - u)).addScaledVector(A.c, 2 * u * (1 - u)).addScaledVector(A.e, u * u);
          A.t.copy(A.c).sub(A.s).multiplyScalar(1 - u).addScaledVector(A.e.clone().sub(A.c), u).normalize().negate(); // the curve's heading, toward the far end
          A.m.fromArray(out, E); A.q.setFromUnitVectors(A.f, A.t);
          A.m.premultiply(new THREE.Matrix4().makeRotationFromQuaternion(A.q)).setPosition(A.p); A.m.toArray(out, o); } }
      if (T.fpFold.length) { const hs = [0, 0, 0]; for (const b0 of T.fpFold) for (let k = 0; k < 3; k++) hs[k] += out[(b0 + RIG_SEG) * 16 + 12 + k]; // the hands (the arms' ends)
        v.fpHands = hs.map(x => x / T.fpFold.length); } }
    v.obj = v.rig.root;
    return true;
  }
  window.__povRigLab = (kind, t, opt, tc = VIL_TC, female = false, legs = null) => { rigSampleUntil = Infinity; rigTemplateBudget = 9; const v = {}; const sc0 = scene; scene = { add(){}, remove(){} };
    try { rigPose(v, kind, t, female, opt || {}, tc, VIL_STEPS, false, legs); } finally { scene = sc0; } return v.rig && v.rig.root; };
  const RIG_KEEP = 6; // rigs a unit keeps to swap between (rigPose)
  function freeRig(r){ scene.remove(r.root); disposeFaded(r.root); if (r.sk.boneTexture) r.sk.boneTexture.dispose(); }
  function dropRig(v){ if (!v.rig) return; if (v.rigs) { for (const r of v.rigs.values()) freeRig(r); v.rigs = null; } else freeRig(v.rig); v.rig = null; v.obj = null; }
  const dropVillager = v => { if (v.rig) { dropRig(v); return; } if (v.obj) { scene.remove(v.obj); disposeFaded(v.obj); vilRefs.set(v.key, (vilRefs.get(v.key) || 1) - 1); } };
  // Frame interpolation (viewer-only). The sim ticks inside the frame loop, so
  // ticks land in bursts on frame boundaries (at 40 ticks/s on a 60Hz screen:
  // gaps of 34, 16, 34, 16ms…). A render clock (rTick, in ticks) runs steadily
  // at the measured average tick rate, about a tick behind the sim, eased back
  // if it drifts; every unit keeps its last few tick positions and is drawn at
  // rTick between them. aTick is the animation clock on the same footing.
  // Paused or stalled, the clock stops at the sim's last tick.
  let aTick = 0, rTick = -1, tickRate = TPS * 2 / 1000, rateTick = -1, rateAt = 0, lastClock = 0;
  const tickPos = new Map();
  function clockFrame(now){
    if (rateTick < 0 || tick < rateTick || tick - rateTick > 200) { rateTick = tick; rateAt = now; rTick = tick - 1; }
    else if (now - rateAt > 250) { const r = (tick - rateTick) / (now - rateAt); tickRate = tickRate * 0.6 + r * 0.4; rateTick = tick; rateAt = now; } // ticks per ms, over ¼s windows
    const dt = lastClock ? Math.min(100, now - lastClock) : 0; lastClock = now;
    rTick += dt * tickRate;
    const target = tick - 1;                                                  // a tick behind: the next position is always known
    rTick += (target - rTick) * Math.min(1, dt / 400);                         // eased back toward it (no pops)
    rTick = Math.max(tick - 2.5, Math.min(tick, rTick));
    aTick = rTick * (30 / TPS);
  }
  function posOf(e){ // [x, z] world (tile centre) at the render clock
    let h = tickPos.get(e.id);
    if (!h) tickPos.set(e.id, h = []);
    const last = h[h.length - 1];
    if (!last || last[0] !== tick) {
      if (last && (e.x - last[1]) ** 2 + (e.y - last[2]) ** 2 > 4) h.length = 0;   // a real teleport: no blend across it
      h.push([tick, e.x, e.y]); if (h.length > 6) h.shift();
    }
    let x = h[0][1], y = h[0][2];
    for (let i = h.length - 1; i > 0; i--) { const a = h[i - 1], b = h[i];
      if (rTick >= a[0]) { const f = Math.min(1, (rTick - a[0]) / Math.max(1, b[0] - a[0])); x = a[1] + (b[1] - a[1]) * f; y = a[2] + (b[2] - a[2]) * f; break; } }
    if (rTick >= h[h.length - 1][0]) { x = h[h.length - 1][1]; y = h[h.length - 1][2]; }
    return [x + 0.5, y + 0.5];
  }
  let lastUnitsAt = 0;
  // Rigs can't be frustum-culled by three (their bones move the mesh off its bind-pose bounds: frustumCulled is off),
  // so every one in range was drawn, even behind the camera — about half a crowd behind a unit or in first person.
  // A sphere round each (a rider or a ram with room to spare) against the view, just before drawing; the
  // first-person viewmodel always stays.
  let _fr = null, _pm = null, _sp = null;
  function cullRigs(){
    if (!_fr) { _fr = new THREE.Frustum(); _pm = new THREE.Matrix4(); _sp = new THREE.Sphere(new THREE.Vector3(), 1.6); }
    camera.updateMatrixWorld(); _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); _fr.setFromProjectionMatrix(_pm);
    for (const v of villagers.values()) { if (!v.rig) continue; const r = v.rig.root;
      if (r.userData.vm) { r.visible = true; continue; }
      _sp.center.set(v.x, 0.6, v.z); r.visible = _fr.intersectsSphere(_sp); }
  }
  function updateUnits(){
    const now = performance.now(), dt = lastUnitsAt ? Math.min(0.1, (now - lastUnitsAt) / 1000) : 0;
    lastUnitsAt = now;
    const near = [];
    for (const e of entities) {
      if (e.type !== 'unit') continue;
      if (e.id === followId && mode === 'eye' && !(RIG_UNITS(e.utype) && (e.utype === 'villager' || MIL3D.has(e.utype)))) { // seen through its eyes: a rigged person shows its arms and tool (fp); anything else (an animal too) nothing
        const a = animals.get(e.id), rs = unitSprites.get(e.id);              // (HIDDEN, not just left un-updated: a sheep's own body sat
        if (a) a.obj.visible = false; if (rs) rs.sprite.visible = false;      // over the camera, bobbing with every step)
        continue;
      }
      const dx = e.x + 0.5 - camAt.x, dy = e.y + 0.5 - camAt.y, d2 = dx * dx + dy * dy;
      if (d2 > RANGE * RANGE || !unitVisible(e)) continue; // (nothing near the camera is hidden: a tree or unit in the way blocks the view, as it would)
      near.push({ e, d2, k: world ? (e.x + 0.5 - camera.position.x) ** 2 + (e.y + 0.5 - camera.position.z) ** 2 : d2 }); // the world view keeps those nearest the camera
    }
    near.sort((a, b) => a.k - b.k || a.e.id - b.e.id);
    const used = new Set();
    const SU = feat.shadowU; SU.n = 0;
    const WP = wheatPushers.value; let wn = 0;
    for (const { e } of near) { if (wn >= 8) break; const a = animals.get(e.id) || villagers.get(e.id); WP[wn++].set(a ? a.x : e.x + 0.5, a ? a.z : e.y + 0.5, 1, 0.32); }
    for (const b of bladePush) { if (wn >= WHEAT_PUSH) break; WP[wn++].set(b[0], b[1], 0.7, 0.14); }       // scythe blades (last frame's): the stalks part ahead of the edge
    for (; wn < WHEAT_PUSH; wn++) WP[wn].set(1e6, 1e6, 0, 0.32);
    bladePush.length = 0;
    for (const { e, d2 } of near.slice(0, world ? MAX_UNITS_WORLD : MAX_UNITS)) {
      used.add(e.id);
      if (e.utype !== 'sheep_carcass') { // a soft contact shadow under every standing unit
        const r = e.utype === 'bear' ? 0.42 : e.utype === 'sheep' ? 0.3 : isMountedUnit(e.utype) || e.utype === 'ram' || e.utype === 'tradecart' ? 0.4 : 0.2;
        const a = animals.get(e.id) || villagers.get(e.id);
        if (e.utype === 'dragon') put('shadowU', a ? a.x : e.x + 0.5, 0.007, a ? a.z : e.y + 0.5, 2 * UNIT_SHADOW.dragon.len, 1, 2 * UNIT_SHADOW.dragon.wid, -worldFacing(e)); // (2D's oval, along its heading)
        else put('shadowU', a ? a.x : e.x + 0.5, 0.007, a ? a.z : e.y + 0.5, 2 * r, 1, 2 * r);
      }
      if (ANIMAL_MODELS[e.utype]) { // 3D, posed live from its state
        const dead = e.utype === 'sheep_carcass', kind = dead ? 'sheep' : e.utype; // a carcass keeps its sheep, toppled
        const key = kind + teamColor(e.team), [tx, tz] = posOf(e);
        let a = animals.get(e.id);
        const ty = dead && a ? a.yaw : -worldFacing(e); // the fallen keep the heading they died with
        if (a && a.key !== key) { dropSolid(a); a = null; }
        if (!a) { const g = ANIMAL_MODELS[e.utype](teamColor(e.team)); addHulls(g, true); if (e.utype !== 'dragon') bakeRigid(g, e.utype === 'sheep' ? SHEEP_LOOSE : null); scene.add(g); animals.set(e.id, a = { obj: g, key, x: tx, z: tz, yaw: ty, phase: 0, gait: 0, graze: 0 }); }
        // Glide between sim steps and ease into turns (a jump of 2+ tiles snaps).
        const nx = tx, nz = tz; // interpolated (posOf): no chase lag
        const mvx = nx - a.x, mvz = nz - a.z; a.moved = Math.hypot(mvx, mvz); a.x = nx; a.z = nz;
        // a walking bear or sheep faces its smoothed course, turning at an animal's pace: facing its path's look-ahead
        // point (which jumps as the zigzag path shortens or re-plans) swung its head side to side every few steps
        let want = ty;
        if (isUnitMoving(e)) a.walkT = now;                                             // (held across a chaser's re-plans, unless at its prey)
        if (!dead && e.utype !== 'dragon' && now - (a.walkT || -1e9) < 400 && !inActionRange(e)) { if (a.moved > 1e-5) { const c = Math.min(1, a.moved / 1.5), ux = mvx / a.moved, uz = mvz / a.moved; a.vx = (a.vx ?? ux) + (ux - (a.vx ?? ux)) * c; a.vz = (a.vz ?? uz) + (uz - (a.vz ?? uz)) * c; } // (over ~1.5 tiles walked: any game speed)
          if (a.vx !== undefined) want = -Math.atan2(a.vz, a.vx); }
        // Steered (character mode): it faces where it's steered and turns with the controls, as a villager does
        const steered = !dead && e.id === followId && (steerActive() && (isUnitMoving(e) || (!e.target && !e.task)) || steeredFacing(e));
        if (steered) { want = -yaw; setHeading(e, yaw); }
        a.yaw += Math.atan2(Math.sin(want - a.yaw), Math.cos(want - a.yaw)) * Math.min(1, dt * (steered ? 14 : e.utype === 'dragon' ? 8 : 4));
        a.obj.visible = true; a.obj.position.set(a.x, 0, a.z); a.obj.rotation.y = a.yaw;
        if (dead) { // seen already dead: lying; then eaten down as it is harvested
          a.deadAt = a.deadAt || (a.alive ? now : now - 2000);
          deathPose(a.obj, 'sheep', now - a.deadAt);
          a.bones = a.bones || sheepBones(a.obj);
          harvestPose(a.obj, a.bones, Math.max(0, Math.min(1, e.hp / (e.maxHp || 100))));
        }
        else { a.alive = true; animateAnimal(a.obj, e, a, dt); }
        continue;
      }
      if ((e.utype === 'villager' || MIL3D.has(e.utype)) && updateVillager3D(e, dt)) { const rs = unitSprites.get(e.id); if (rs) rs.sprite.visible = false; continue; }
      let rec = unitSprites.get(e.id);
      if (rec) rec.sprite.visible = true;
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
      const [sx_, sz_] = posOf(e); rec.sprite.position.set(sx_, 0, sz_);
      if (rec.fresh || (frame + e.id) % 2 === 0) { paintUnit(rec, e); rec.fresh = false; } // ~30fps art refresh
    }
    for (const [id, rec] of unitSprites) if (!used.has(id)) {
      scene.remove(rec.sprite); rec.tex.dispose(); rec.sprite.material.dispose(); unitSprites.delete(id);
    }
    SU.mesh.count = SU.n; SU.mesh.instanceMatrix.needsUpdate = true;
    for (const [id, a] of animals) if (!used.has(id)) { dropSolid(a); animals.delete(id); }
    for (const [id, v] of villagers) if (!used.has(id)) { dropVillager(v); villagers.delete(id); }
    if (frame % 120 === 0) for (const id of tickPos.keys()) if (!entitiesById.has(id)) tickPos.delete(id);
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

  let camDt = 1 / 60, fpDimmed = false;
  function follow(e){
    if (steering && followId !== e.id) { possess(e.id, true); steerId = e.id; }
    followId = e.id;
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
  // Space / ACT held: the act again at the unit's own attack rhythm — on the move a melee character keeps swinging;
  // standing, the order isn't resent while its job lasts, and once it ends (prey dead, tree felled) the next thing in
  // front is taken on. A press acts at once.
  let actHeld = false, heldActAt = 0;
  function actNow(e){ heldActAt = performance.now(); if (act(e) !== false) swingAt = heldActAt; }
  function actHeldTick(e, now){
    if (!actHeld || !e) return;
    const period = Math.max(SWING_MS, (UNITS[e.utype] ? UNITS[e.utype].rof : T30(60)) / (TPS * GAME_SPEED) * 1000);
    if (now - heldActAt >= period && (isUnitMoving(e) || (!e.target && !e.task))) actNow(e);
  }
  function possess(id, on){ submitCommand({ kind: 'possess', unitId: id, on }); lastPossessAt = performance.now(); }

  let steerId = null; // the unit being driven (released by id: the follow may already have moved on)
  // The player is at the controls right now (keys, joystick, or a steering step just sent) — not merely in control.
  // Only then does the character face the steering direction; else it faces its way, and the steering turns with it.
  const steerActive = () => steering && (held.size > 0 || Math.abs(joy.x) > 0.25 || Math.abs(joy.y) > 0.25 || (lastMove != null && performance.now() - lastMoveAt < 700));
  // Driven and free (no job, no target): it keeps facing the steering heading — stopped, or taking its last step
  // after the keys let go — not the way the tile path happened to zigzag (a diagonal walk steps off-axis)
  const steeredFacing = e => steering && e.id === followId && !e.target && !e.task && (!isUnitMoving(e) || steerActive() || !e.path || e.path.length <= 2);
  function setSteering(on){
    if (on === steering) return;
    steering = on;
    const id = on ? followId : steerId; steerId = on ? followId : null;
    if (id != null) possess(id, on);
    held.clear(); joy.x = joy.y = 0; lastMove = null; actHeld = false;
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
      // A straight line off the grid, exactly along the view, when it's clear ('steer'); else the farthest open tile
      for (const r of [2.5, 1.5, 1]) {
        const px = +(e.x + cx * r).toFixed(3), py = +(e.y + cy * r).toFixed(3);
        if (!straightWalkClear(e, px, py)) continue;
        if (!lastMove || Math.hypot(lastMove.x - px, lastMove.y - py) > 0.35 || now - lastMoveAt > 600) {
          submitCommand({ kind: 'steer', unitId: e.id, x: px, y: py });
          lastMove = { x: px, y: py }; lastMoveAt = now;
        }
        return;
      }
      for (const r of [2.5, 1.5, 1]) { // the farthest open tile ahead
        const tx = Math.round(e.x + cx * r), ty = Math.round(e.y + cy * r);
        const blk = unitBlock && tx >= 0 && ty >= 0 && tx < MAP && ty < MAP ? entitiesById.get(unitBlock[tx + ty * MAP]) : null;   // other units are passed through; the dragon's body isn't
        if ((tx === ux && ty === uy) || !walkable(tx, ty, e.id, true) || (blk && blk.utype === 'dragon')) continue;
        if (!lastMove || lastMove.x !== tx || lastMove.y !== ty || now - lastMoveAt > 600) {
          submitCommand({ kind: 'command', unitIds: [e.id], tileX: tx, tileY: ty });
          lastMove = { x: tx, y: ty }; lastMoveAt = now;
        }
        return;
      }
    } else if (lastMove) { // let go: stop where it is ('halt') — not at a tile centre, which on a zigzag walk lies off the
      // line it was looking along (it stepped sideways: a jump in first person)
      submitCommand({ kind: 'halt', unitId: e.id });
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
    // Loaded and against a drop-off that takes the load: bank it (moving or not).
    if (vil && e.carrying > 0) for (const b of entities) {
      if (b.type !== 'building' || b.team !== e.team || !b.complete || b.hp <= 0 || !dropAccepts(b, e.carryType)) continue;
      if (edgeDistToBuilding(e.x, e.y, b) <= 1.2) { submitCommand({ kind: 'deposit', unitId: e.id, bldgId: b.id }); return false; } // the throw plays, not a swing
    }
    // On the move a melee character swings as it goes: a 'strike' lands on the nearest enemy in reach ahead
    // (commands.js) and the walk carries on; standing still, the act below is an ordinary order.
    if (!(e.range > 0) && (isUnitMoving(e) || held.has('fwd') || held.has('back') || Math.abs(joy.y) > 0.25)) {
      let tgt = null, td = Infinity;
      for (const t of entities) {
        if (t.hp <= 0 || t.garrisonedIn || sameSide(t.team, e.team) || (t.type === 'unit' ? isHarmlessAnimal(t) || !unitVisible(t) || e.utype === 'ram' : !bldgVisible(t))) continue;
        let px = t.x, py = t.y;
        if (t.type === 'building') { px = Math.max(t.x - 0.5, Math.min(e.x, t.x + t.w - 0.5)); py = Math.max(t.y - 0.5, Math.min(e.y, t.y + t.h - 0.5)); } else if (t.type !== 'unit') continue;
        const dx = px - e.x, dy = py - e.y, d = Math.hypot(dx, dy);
        if (d < td && d <= 1.8 && (d < 0.8 || (dx * fx + dy * fy) / d > cone)) { td = d; tgt = t; }
      }
      if (tgt) submitCommand({ kind: 'strike', unitId: e.id, targetId: tgt.id });
      return;
    }
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

  // ---- The camera ----
  // orbit (the 3D world view's RTS camera): around the anchor — the anchored
  // unit, else the 2D map camera's centre (so the minimap, Home, Idle and the
  // 2D follow all steer it); chase: behind the anchored unit; eye: through its
  // eyes, its own arms and tool in view (the rig with its head collapsed).
  // The world view's camera, AoE III-style: the 2D view's side (looking toward −x −z), a fixed downward angle
  // and a narrow lens, so the map fills the screen and the horizon never shows; no tilt, zoom by distance.
  const ORBIT_PITCH = 0.66, ORBIT_FOV = 36, ORBIT_MIN = 12, ORBIT_MAX = 34;
  let chaseK = 1, lookUntil = 0; // the chase camera's distance (scroll zooms it); a drag-look holds its view a while
  const FP_PITCH_MIN = -1.1;
  let oYaw = Math.PI / 4, oPitch = ORBIT_PITCH, oDist = 21, zoomBy = 1, zoomAt = null, fpPitch = -0.3, anchorEase = 0, camH = 14, clearH = 0;
  const mapCenter = () => fromIso(camX, camY);                          // map coords of the 2D camera, unrounded (screenToMap rounds to whole pixels: a fine swipe would step)
  function panTo(x, y){ // map coords
    const iso = toIso(Math.max(0, Math.min(MAP - 1, x)), Math.max(0, Math.min(MAP - 1, y)));
    camX = iso.ix; camY = iso.iy; window.targetCamX = camX; window.targetCamY = camY; window.cameraFollowId = null;
  }
  function panBy(dx, dy){ if (followId != null) unfollow(); const c = mapCenter(); panTo(c.x + dx, c.y + dy); }
  // The tallest thing within reach of (x, z): standing trees and buildings (towers highest) — the camera stays above it.
  function obstacleTop(x, z){
    let top = 0;
    for (let ty = Math.floor(z - 1.3); ty <= Math.floor(z + 1.3); ty++) for (let tx = Math.floor(x - 1.3); tx <= Math.floor(x + 1.3); tx++) {
      const t = map[ty] && map[ty][tx]; if (!t || !(fog[ty] && fog[ty][tx])) continue;
      if (t.t === TERRAIN.FOREST && t.res > 60) top = Math.max(top, 2.3);
      else if (t.occupied != null) { const b = entitiesById.get(t.occupied); if (b && b.type === 'building') top = Math.max(top, isTowerBtype(b.btype) ? 3.4 : 2.4); }
    }
    return top;
  }
  // The frame's wheel steps, at once and about the cursor (as 2D): the camera slides along its sight line, so the
  // ground scales about the view centre by the same factor — the centre shifts to hold the point under the cursor.
  // Measured on the camera last drawn, so a burst of events can't mix states.
  // Behind a unit (the eye buttons), zooming in past the nearest glides into its eyes; out of them, back behind it
  // (the map camera never zooms into a unit). The push must be
  // deliberate — ZOOM_PUSH steps past the limit — so a zoom that just hits the stop stays put.
  const CHASE_MIN = 0.55, CHASE_MAX = 2.2, ZOOM_PUSH = 5;
  let zoomPush = 0;
  function zoomIn(now = false){ // pushed in past the chase view's nearest: into the unit's eyes
    if (zoomPush > 0) zoomPush = 0;
    if (!now && --zoomPush > -ZOOM_PUSH) return;
    zoomPush = 0; blendMs = 1000; mode = 'eye'; refreshButtons();
  }
  function zoomOut(now = false){ // pushed out of the eyes: back behind the unit, at its nearest
    if (zoomPush < 0) zoomPush = 0;
    if (!now && ++zoomPush < ZOOM_PUSH) return;
    zoomPush = 0; blendMs = 1000; mode = 'chase'; chaseK = CHASE_MIN;
    if (document.pointerLockElement) document.exitPointerLock();
    refreshButtons();
  }
  // Released (Esc): the map camera centred on the character — not where the 2D map was left — gliding up to its angle.
  function leaveToMap(){
    const e = followId != null ? entitiesById.get(followId) : null, at = e && posOf(e);
    if (document.pointerLockElement) document.exitPointerLock();
    blendMs = 1000; unfollow(); oDist = ORBIT_MIN;
    if (at) { panTo(at[0] - 0.5, at[1] - 0.5); eye = { x: at[0], y: at[1] }; }
  }
  function applyZoom(){
    const f = Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, oDist * zoomBy)) / oDist; zoomBy = 1;
    if (f !== 1 && followId == null && eye && zoomAt) { const g = pick(zoomAt.x, zoomAt.y).map, cx = eye.x - 0.5, cy = eye.y - 0.5;
      const nx = cx + (1 - f) * (g.x - cx), ny = cy + (1 - f) * (g.y - cy); panTo(nx, ny); const c = mapCenter(); eye.x = c.x + 0.5; eye.y = c.y + 0.5; }
    oDist *= f;
  }
  // A mode or character switch glides the camera from where it was to the new view (position, the shortest turn, lens)
  // rather than cutting; each frame blends toward the live target, so the view it lands on is the one it keeps.
  const BLEND_MS = 600; let camFrom = null, camKey = null, camLast = null, _bq = null, blendMs = BLEND_MS;
  function blendCamera(){
    const key = mode + '|' + followId;
    if (key !== camKey) { if (camLast) camFrom = { pos: camLast.pos.clone(), quat: camLast.quat.clone(), fov: camLast.fov, t0: performance.now(), ms: blendMs }; camKey = key; blendMs = BLEND_MS; } // from the last DRAWN view
    if (camFrom) {
      const t = (performance.now() - camFrom.t0) / camFrom.ms;
      if (t >= 1) camFrom = null;
      else { const k = t * t * (3 - 2 * t); _bq = _bq || new THREE.Quaternion();
        camera.position.lerpVectors(camFrom.pos, camera.position, k);
        camera.quaternion.slerpQuaternions(camFrom.quat, _bq.copy(camera.quaternion), k);
        camera.fov = camFrom.fov + (camera.fov - camFrom.fov) * k; camera.updateProjectionMatrix(); }
    }
    if (!camLast) camLast = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), fov: 0 };
    camLast.pos.copy(camera.position); camLast.quat.copy(camera.quaternion); camLast.fov = camera.fov;
  }
  // The ground shakes under something huge (the dragon's footfalls and slams): an offset on the drawn camera that dies
  // away fast, strongest near the camera's focus. Viewer-only.
  let camShake = 0;
  function shakeFrom(x, z, amp){ if (!camAt) return; const d = Math.hypot(x - camAt.x, z - camAt.y); camShake = Math.max(camShake, amp * Math.max(0, 1 - d / 18)); }
  // Mouse / drag look arrives as pointer events, at their own uneven rate (not the frame's): each is banked here and
  // paid out over a few frames (LOOK_EASE s), so the view turns evenly instead of in steps.
  const lookPend = { yaw: 0, pitch: 0 }, LOOK_EASE = 0.03;
  function updateCamera(e){
    if (zoomBy !== 1) applyZoom();
    if (lookPend.yaw || lookPend.pitch) { const f = 1 - Math.exp(-camDt / LOOK_EASE), dy = lookPend.yaw * f, dp = lookPend.pitch * f;
      yaw += dy; fpPitch = Math.max(FP_PITCH_MIN, Math.min(0.6, fpPitch + dp)); lookPend.yaw -= dy; lookPend.pitch -= dp;
      if (Math.abs(lookPend.yaw) < 1e-5 && Math.abs(lookPend.pitch) < 1e-5) lookPend.yaw = lookPend.pitch = 0; }
    const k = 1 - Math.exp(-camDt / (performance.now() < anchorEase ? 0.25 : e ? 0.05 : 0.08)); // a new anchor eases in; a unit is followed tight; the free map camera a touch softer (pan input arrives in bursts)
    let tx, ty;
    if (e) { const v = villagers.get(e.id), [px, py] = posOf(e); tx = v ? v.x : px; ty = v ? v.z : py; }
    else { const c = mapCenter(); tx = c.x + 0.5; ty = c.y + 0.5; }
    if (!eye) { eye = { x: tx, y: ty }; yaw = e ? worldFacing(e) : 0; }
    eye.x += (tx - eye.x) * k; eye.y += (ty - eye.y) * k;
    if (e && !steerActive() && !steeredFacing(e) && performance.now() > lookUntil) { let dy = worldFacing(e) - yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); yaw += dy * 0.12; } // riding along: turn with the unit
    const cx = Math.cos(yaw), cy = Math.sin(yaw);
    let far = RANGE + 6;
    if (mode === 'orbit' || !e) {
      const cp = Math.cos(oPitch), h = e ? 0.3 : 0;
      const px = eye.x + Math.cos(oYaw) * cp * oDist, pz = eye.y + Math.sin(oYaw) * cp * oDist;
      clearH += (obstacleTop(px, pz) + 0.3 - clearH) * Math.min(1, camDt * 8);
      camH = Math.max(h + Math.sin(oPitch) * oDist, clearH); // never inside a crown or a roof (you'd see its black outline shell from inside); eased, no jolts
      camera.position.set(px, camH, pz);
      camera.lookAt(eye.x, h, eye.y);
      camAt = { x: eye.x, y: eye.y };                                          // culling and the tree cut-away centre on the anchor
      far = RANGE + oDist + 6;
    } else if (mode === 'chase') {
      camAt = { x: eye.x - cx * 4.2 * chaseK, y: eye.y - cy * 4.2 * chaseK };                      // above and behind the character, looking down past it
      camH += (Math.max(4.6 * chaseK, obstacleTop(camAt.x, camAt.y) + 0.3) - camH) * Math.min(1, camDt * 8);
      camera.position.set(camAt.x, camH, camAt.y);
      camera.lookAt(eye.x + cx * 1.5, 0.3, eye.y + cy * 1.5);
    } else { // through the eyes: at the head (a rider's up in the saddle), looking where it faces, pitched by mouse-look
      const h = isMountedUnit(e.utype) ? 0.97 : e.utype === 'ram' ? 0.8 : 0.58, fwd = RIG_UNITS(e.utype) ? -0.12 : 0; // just behind the (hidden) head: the arms and tool fall in view
      camAt = { x: eye.x, y: eye.y };
      camera.position.set(eye.x + cx * fwd, h, eye.y + cy * fwd);
      const pc = Math.cos(fpPitch);
      camera.lookAt(eye.x + cx * pc * 10, h + Math.sin(fpPitch) * 10, eye.y + cy * pc * 10);
    }
    const orbit = mode === 'orbit' || !e, fov = orbit ? ORBIT_FOV : mode === 'chase' ? 55 : 70;
    if (camera.far !== far || camera.fov !== fov) { camera.far = far; camera.fov = fov; camera.updateProjectionMatrix();
      scene.fog.near = orbit ? far * 0.8 : far * 0.45; scene.fog.far = orbit ? far + 20 : far - 6; } // the world view: only a light haze
    if (scene.background !== VOID) { scene.background = VOID; scene.fog.color = VOID; } // no sky or clouds, in every mode: beyond the map is black, as 2D
    clouds.visible = false;
    blendCamera();
    if (camShake > 1e-3) { const t = performance.now() * 0.001;
      camera.position.x += Math.sin(t * 71) * camShake; camera.position.y += Math.sin(t * 93 + 1) * camShake * 0.7; camera.position.z += Math.sin(t * 57 + 2) * camShake;
      camShake *= Math.exp(-camDt * 7); }
  }

  function loop(now){
    raf = requestAnimationFrame(loop);
    if (!gameStarted) { povClose(); return; }
    let e = followId != null ? entitiesById.get(followId) : null;
    if (followId != null && (!e || e.type !== 'unit' || e.hp <= 0 || e.garrisonedIn)) {
      // fallen (or gone): the view lets go — no handover to another unit; the world view back to its map camera
      if (world) { unfollow(); e = null; }
      else { povClose(); return; }
    }
    frame++;
    if (world) { // the 2D map camera and the 3D anchor are one: either can move it
      const cf = window.cameraFollowId;
      // a follow started from the HUD (double-click the portrait) takes the unit: behind it, in control; its end lets go
      if (cf != null && cf !== followId) { const u = entitiesById.get(cf); if (u && u.type === 'unit' && u.hp > 0) { follow(u); e = u; if (mode === 'orbit') mode = 'chase'; anchorEase = performance.now() + 500; refreshButtons(); } else if (followId != null) { unfollow(); e = null; } }
      else if (cf == null && followId != null) { unfollow(); e = null; }
      if (followId != null) window.cameraFollowId = followId;
    }
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
    lastNow = now; clockFrame(now);
    // this frame's build budgets (set before anything poses — trainees pose in animateModels): a pose-cache build, 1.5ms of rig sampling, one rig template
    bakesLeft = 1; rigSampleUntil = performance.now() + 1.5; rigTemplateBudget = 1; frameParts.tpl = 0; frameParts.inst = 0; frameParts.samp = 0; frameParts.pose = 0;
    if (warmFrames > 0) { warmFrames--; bakesLeft = rigTemplateBudget = Infinity; rigSampleUntil = Infinity; } // a match's first frames: every unit in its real rig at once (no stand-ins turning into place)
    if (steering && e) { steer(e, dt); actHeldTick(e, performance.now()); }
    const t0 = performance.now();
    if (groundFor !== map || groundData.length !== MAP * MAP * 4) { buildGround(); lastStatic = 0; }
    camDt = dt || 1 / 60; updateCamera(e);
    { const fp = world && mode === 'eye' && e != null; if (fp !== fpDimmed) { fpDimmed = fp; const mw = document.getElementById('minimap-wrap'); if (mw) mw.classList.toggle('fp-active', fp); } } // first person: the minimap steps back (styles.css)
    // on the cadence, or at once when the view has moved a few tiles (a jump: the new place mustn't wait for it)
    const P = frameParts, mark = k => { const n = performance.now(); P[k] = n - P._t; P._t = n; }; P._t = performance.now(); // (the last frame's time by part: __povFrame)
    if (now - lastStatic > STATIC_MS || !staticAt || (eye.x - staticAt.x) ** 2 + (eye.y - staticAt.y) ** 2 > 9) {
      refreshGround(); refreshFeatures(); refreshBuildings(); refreshButtons(); lastStatic = now; staticAt = { x: eye.x, y: eye.y }; }
    mark('static');
    animateFeatures(dt);
    updateArrows(now);
    clouds.position.set(camera.position.x, 0, camera.position.z); clouds.rotation.y = aTick * 0.00004;
    animateModels(dt); mark('models');
    updateUnits(); mark('units');
    updateXray(); updateSelection();
    if (world) updateGhost(); mark('fx');
    const t1 = performance.now();
    cullRigs();
    renderer.render(scene, camera); mark('render');
    if (unrevealed) { unrevealed = false; pip.style.visibility = ''; window.world3D = world;
      if (fadeIn) { fadeIn = false;                                               // a match opening: its first frame (and the minimap) fade up from black
        for (const el of [renderer.domElement, document.getElementById('minimap-wrap')]) { if (!el) continue;
          el.style.transition = 'none'; el.style.opacity = '0'; void el.offsetWidth; el.style.transition = 'opacity 200ms ease-out'; el.style.opacity = '1'; } } }
    if (world) drawOverlay(); else if (ov) ovx.clearRect(0, 0, ov.width, ov.height); mark('overlay');
    // Running averages (ms/frame): our JS (art repaints, uploads, layout) vs the
    // WebGL submit — for profiling from the console.
    stats.js += ((t1 - t0) - stats.js) * 0.05;
    stats.gl += ((performance.now() - t1) - stats.gl) * 0.05;
  }
  const stats = { js: 0, gl: 0 }, frameParts = { _t: 0 };
  window.__povFrame = () => frameParts; // dev: the last frame's time by part (ms)

  function refreshButtons(){
    if (!pip) return;
    const e = followId != null ? entitiesById.get(followId) : null, own = !!e && e.team === myTeam;
    if (steering !== own) { setSteering(own); return; }                         // following your own unit = driving it, in every mode
    btnFull.textContent = '⛶ 3D'; btnFull.style.display = world ? 'none' : '';     // in the world view the top bar's switch does it
    btnClose.style.display = world ? 'none' : '';
    titleEl.textContent = e ? ((UNITS[e.utype] && UNITS[e.utype].name) || e.utype) : '';
    const touch = typeof isMobile !== 'undefined' && isMobile;
    hintEl.textContent = mode === 'eye' ? 'W/S walk · A/D turn · click / Space swing · Esc release' : 'W/S walk · A/D turn · Space act · Esc release';
    hintEl.style.display = steering && !touch ? '' : 'none';
    joyEl.style.display = actEl.style.display = steering && touch ? '' : 'none';
  }
  // The 3D world view: the map area under the full HUD (top bar, selection
  // panel, actions, minimap); the 2D map is not drawn under it (render.js).
  function setWorld(on){
    if (!on) { setSteering(false); if (document.pointerLockElement) document.exitPointerLock(); }
    world = on; window.world3D = on && !unrevealed;
    { const vb = document.querySelector('#view-btn .btn-emoji'); if (vb) vb.textContent = on ? '2D' : '3D'; } // the top bar's switch offers the other view
    pip.classList.toggle('world', on);
    pip.style.top = on ? topH + 'px' : '';
    pip.style.bottom = on ? '0' : (bottomH + 10) + 'px';
    const pw = document.getElementById('pop-wrap'), lift = pw ? Math.min(pw.offsetHeight, 70) + 8 : 0;   // above the corner buttons (idle/bell/eye/home)
    for (const el of [joyEl, actEl, hintEl]) el.style.bottom = on ? (bottomH + 24 + lift) + 'px' : '';
    if (on && followId == null) mode = 'orbit';
    if (!on && mode === 'orbit') mode = 'chase';
    if (!on) hideSelectionFx();
    refreshButtons();
    if (renderer) resize();
  }
  function unfollow(){
    followId = null; if (world) { mode = 'orbit'; window.cameraFollowId = null; }
    if (steering) setSteering(false);
    refreshButtons();
  }

  // ---- The 3D world view's input: click/tap resolved in 3D, then handed to
  // the ordinary input functions through window.__pick3D (iso.js / input.js),
  // so selection, commands, placement, rally/guard/garrison stay one set of rules.
  let _ray = null, _ndc = null, _v3 = null;
  const PICK_H = { villager: 0.32, militia: 0.32, spearman: 0.32, archer: 0.32, scout: 0.55, knight: 0.55, sheep: 0.2, sheep_carcass: 0.2, bear: 0.35, ram: 0.35, tradecart: 0.35, dragon: 1.0 }; // (half the drawn height: the HP bar sits over the head)
  function project(x, y, z){ _v3.set(x, y, z).project(camera); const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + (_v3.x + 1) / 2 * r.width, y: r.top + (1 - _v3.y) / 2 * r.height, z: _v3.z }; }
  // A solid model (animal, carcass, vehicle) is boxed as drawn: a carcass lies rolled off its spot, the cart's ox walks
  // ahead of it. The rigs pose on the GPU, so a person keeps the box over its spot.
  let _bb = null, _bc = null;
  function solidModel(u){ const a = animals.get(u.id) || (!RIG_UNITS(u.utype) && villagers.get(u.id)); return a && a.obj && a.obj.visible ? a.obj : null; }
  function visibleMeshes(o, fn){ if (!o.visible) return; if (o.isMesh) fn(o); for (const c of o.children) visibleMeshes(c, fn); }
  function modelBox(obj){ _bb = _bb || new THREE.Box3(); _bc = _bc || new THREE.Vector3(); _bb.makeEmpty(); obj.updateMatrixWorld(true);
    visibleMeshes(obj, m => _bb.expandByObject(m, false)); return _bb; }
  // Where a unit is drawn (its model / billboard), else its interpolated spot.
  function drawnAt(u){ const m = solidModel(u); if (m) { modelBox(m).getCenter(_bc); return [_bc.x, _bc.z]; }
    const a = villagers.get(u.id) || animals.get(u.id); if (a) return [a.x, a.z]; const s = unitSprites.get(u.id); return s ? [s.sprite.position.x, s.sprite.position.z] : posOf(u); }
  // Its box on screen {x0, x1, y0, y1} (null: behind the camera).
  function screenRect(u, x, z){
    const m = solidModel(u);
    if (m) { const r = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }; let behind = false; m.updateMatrixWorld(true);
      // each part's own box on screen (one box round the whole posed model swells on the diagonal camera)
      visibleMeshes(m, o => { const g = o.geometry; if (!g.boundingBox) g.computeBoundingBox(); const B = g.boundingBox;
        for (let i = 0; i < 8; i++) { _v3.set(i & 1 ? B.max.x : B.min.x, i & 2 ? B.max.y : B.min.y, i & 4 ? B.max.z : B.min.z).applyMatrix4(o.matrixWorld);
          const p = project(_v3.x, _v3.y, _v3.z); if (p.z > 1) behind = true;
          r.x0 = Math.min(r.x0, p.x); r.x1 = Math.max(r.x1, p.x); r.y0 = Math.min(r.y0, p.y); r.y1 = Math.max(r.y1, p.y); } });
      return behind || r.x0 > r.x1 ? null : r; }
    const h = PICK_H[u.utype] || 0.32, b = project(x, 0, z), t = project(x, h * 2, z);
    if (b.z > 1 || t.z > 1) return null;
    const w = Math.max(8, b.y - t.y) * (u.utype === 'scout' || u.utype === 'knight' ? 0.9 : 0.55);
    return { x0: Math.min(b.x, t.x) - w, x1: Math.max(b.x, t.x) + w, y0: t.y, y1: b.y };
  }
  function pickUnits(test){
    const out = [];
    for (const u of entities) {
      if (u.type !== 'unit' || u.garrisonedIn || u.hp <= 0 || !unitVisible(u)) continue;
      if (u.id === followId && mode === 'eye') continue;
      const [x, z] = drawnAt(u); if ((x - camAt.x) ** 2 + (z - camAt.y) ** 2 > RANGE * RANGE) continue;
      const rect = screenRect(u, x, z); if (!rect) continue;
      const r = test(u, rect, x, z);
      if (r != null) out.push({ u, d: r });
    }
    return out;
  }
  const RES_PARTS = ['trunk', 'crown0', 'crown1', 'crown2', 'stump', 'gold', 'stone', 'puff', 'berry'];
  function pick(cx, cy){
    _ray = _ray || new THREE.Raycaster(); _ndc = _ndc || new THREE.Vector2(); _v3 = _v3 || new THREE.Vector3();
    const r = renderer.domElement.getBoundingClientRect();
    _ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height * 2 - 1));
    _ray.setFromCamera(_ndc, camera);
    const o = _ray.ray.origin, d = _ray.ray.direction;
    const tg = d.y < -1e-4 ? -o.y / d.y : 200, gx = o.x + d.x * tg, gz = o.z + d.z * tg;
    const slack = (typeof isMobile !== 'undefined' && isMobile) ? 14 : 5;
    // units: their drawn box on screen (the rigs pose on the GPU, so no mesh raycast)
    let unit = null, ud = Infinity;
    for (const { u, d: dd } of pickUnits((u, R, x, z) => {
      if (cx < R.x0 - slack || cx > R.x1 + slack || cy < R.y0 - slack || cy > R.y1 + slack) return null;
      return camera.position.distanceTo(_v3.set(x, PICK_H[u.utype] || 0.32, z)); // its body, not its feet
    })) if (dd < ud) { ud = dd; unit = u; }
    // buildings: a real raycast on their models
    let building = null, bd = Infinity;
    const objs = []; for (const rec of solids.values()) if (rec.obj && rec.obj.visible) objs.push(rec.obj); // (the raycaster ignores visibility)
    // solid faces only: not the ink lines (the raycaster takes a line anywhere within a tile of it) or the outline shells
    for (const h of _ray.intersectObjects(objs, true)) { if (!h.object.isMesh || h.object.material.side === THREE.BackSide) continue; let o2 = h.object; while (o2 && o2.userData.bid == null) o2 = o2.parent;
      const b = o2 && entitiesById.get(o2.userData.bid); if (b && h.distance < bd) { bd = h.distance; building = b; break; } }
    // resources: a raycast on the tree / rock / bush instances, each tagged with its tile
    let resource = null, rd = Infinity;
    for (const h of _ray.intersectObjects(RES_PARTS.map(n => feat[n] && feat[n].mesh).filter(Boolean), false)) {
      const ti = feat[h.object.userData.feat].tiles[h.instanceId], tl = ti >= 0 && map[Math.floor(ti / MAP)][ti % MAP];
      if (tl && tl.res > 0 && RES_TILE.has(tl.t)) { resource = { x: ti % MAP, y: Math.floor(ti / MAP), type: tl.t }; rd = h.distance; break; }
    }
    if (!resource) { const ix = Math.floor(gx), iz = Math.floor(gz), tl = map[iz] && map[iz][ix]; // the ground at its foot (2D's click box is as forgiving)
      if (tl && tl.res > 0 && RES_TILE.has(tl.t) && fog[iz][ix]) { resource = { x: ix, y: iz, type: tl.t }; rd = tg; } }
    // a unit comes first (as 2D): one hidden behind a building or tree shows its outline (updateXray) and a click there
    // takes it; only through the eyes (no outlines) does something clearly in front of it stand in the way
    const outlined = world && mode !== 'eye';
    if (unit && (outlined || (bd > ud - 0.6 && rd > ud - 0.6))) { building = null; resource = null; }
    else { unit = null; if (bd <= rd) resource = null; else building = null; }
    const mx = gx - 0.5, my = gz - 0.5;
    return { unit, building, resource, map: { x: mx, y: my }, tile: { x: Math.round(mx), y: Math.round(my) } };
  }
  function withPick(p, fn){ window.__pick3D = p; try { return fn(); } finally { window.__pick3D = null; } }
  let lastTap = null;
  function tapAt(cx, cy, shift){
    const p = pick(cx, cy), now = performance.now(), same = lastTap && now - lastTap.t < 380 && ((p.unit && p.unit === lastTap.unit) || (p.building && p.building === lastTap.building));
    lastTap = same ? null : { t: now, unit: p.unit, building: p.building };
    if (same) { withPick(p, () => doubleSelectAt(cx, cy)); return; }      // double-click / double-tap: every one of that type on screen (as 2D)
    withPick(p, () => {
      if (typeof isClassicUI !== 'undefined' && isClassicUI) {
        if (window.settingRally) commitRallyAt(cx, cy); else if (window.settingGuard) dropGuardFlagAt(cx, cy);
        else if (window.settingGarrison) garrisonLoadTap(cx, cy); else doSelect(cx, cy, shift);
      } else handleTap(cx, cy, shift);
    });
  }
  function commandAt(cx, cy){
    const p = pick(cx, cy);
    withPick(p, () => {
      window.settingRally = false; window.settingGuard = false; window.settingGarrison = null;
      const classic = typeof isClassicUI !== 'undefined' && isClassicUI;
      if (!classic && tryRightClickGuard(cx, cy)) return;
      doCommand(cx, cy);
      if (!classic && selected.some(s => s.type === 'unit' && s.team === myTeam)) finishMobileUnitCommand();
    });
  }
  function anchorTo(u){ if (followId === u.id) return; follow(u); window.cameraFollowId = u.id; anchorEase = performance.now() + 500; refreshButtons(); }
  function boxSelect(x0, y0, x1, y1){
    const lx = Math.min(x0, x1), hx = Math.max(x0, x1), ly = Math.min(y0, y1), hy = Math.max(y0, y1);
    const box = pickUnits((u, R) => u.team === myTeam && Math.max(lx, (R.x0 + R.x1) / 2 - 6) <= Math.min(hx, (R.x0 + R.x1) / 2 + 6) && Math.max(ly, R.y0) <= Math.min(hy, R.y1) ? 0 : null).map(o => o.u);
    withPick({ box, map: { x: 0, y: 0 }, tile: { x: 0, y: 0 } }, () => { if (window.settingGarrison) garrisonBoxLoad(x0, y0, x1, y1); else doBoxSelect(x0, y0, x1, y1); });
  }
  // Pointer, as the 2D map: mouse — left click = tap (select/command), left-drag = box select, double-click = all of
  // that type, right click = command, middle-drag = pan, wheel = zoom (trackpad swipe pans). Touch — tap, double-tap,
  // one finger = pan, long-press then drag = box select, two fingers = pinch-zoom. The arrows pan the map camera (input.js).
  // Placing: click places, drag lays walls; in first person while steering, click swings (and locks the mouse for mouse-look).
  const ptrs = new Map(); let drag = null, hoverXY = null;
  function onDown(ev){
    if (!world) return;
    const cv = renderer.domElement; cv.setPointerCapture(ev.pointerId);
    ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const x = ev.clientX, y = ev.clientY, touch = ev.pointerType !== 'mouse';
    if (ptrs.size === 2) { if (drag && drag.kind === 'wall') abortWallDrag(); const [a, b] = [...ptrs.values()]; drag = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), dist: oDist, k: chaseK }; return; }
    if (!touch && ev.button === 2) { drag = { kind: 'cmd', x, y }; return; }          // right button: a command on release (as 2D)
    if (!touch && ev.button === 1) { drag = { kind: 'pan', x, y, moved: false }; return; }
    if (ev.button !== 0 && !touch) return;
    if (!placing && isPointOnMinimap(x, y)) { minimapJump(x, y); minimapDragging = true; drag = { kind: 'minimap' }; return; }
    if (placing) { if (isWallBtype(placing)) { withPick(pick(x, y), () => startWallDrag(x, y)); drag = { kind: 'wall' }; } else drag = { kind: 'place', x, y }; return; }
    if (mode === 'eye' && steering) { // clicking another of your units takes you into its eyes; else a swing
      const locked = document.pointerLockElement === cv, r = cv.getBoundingClientRect(), p = locked ? pick(r.left + r.width / 2, r.top + r.height / 2) : pick(x, y);
      if (p.unit && p.unit.team === myTeam && p.unit.id !== followId) { anchorTo(p.unit); selected = [p.unit]; updateUI(); drag = null; return; }
      const e = entitiesById.get(followId); if (e && act(e) !== false) swingAt = performance.now();
      if (!touch && !document.pointerLockElement) cv.requestPointerLock(); drag = null; return; }
    drag = touch ? { kind: 'pan', x, y, moved: false, tap: true } : { kind: 'box', x0: x, y0: y, x, y, moved: false };
    if (touch) { const p = pick(x, y), d0 = drag; // long-press on empty ground, then drag: box select (as 2D)
      if (!p.unit && !p.building) d0.timer = setTimeout(() => { if (drag === d0 && !d0.moved) Object.assign(d0, { kind: 'box', x0: x, y0: y }); }, 380); }
  }
  function onMove(ev){
    if (!world) return;
    if (document.pointerLockElement === renderer.domElement) { // mouse-look through the eyes
      lookPend.yaw += ev.movementX * 0.0028; lookPend.pitch -= ev.movementY * 0.0022; return; }
    const x = ev.clientX, y = ev.clientY, pp = ptrs.get(ev.pointerId);
    hoverXY = { x, y };
    if (pp) { pp.x = x; pp.y = y; }
    if (!drag) return;
    if (drag.kind === 'pinch' && ptrs.size >= 2) { const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
      const r = drag.d / Math.max(20, d);                                                                // pinch: zoom (no rotation, as 2D)
      if (followId != null && mode === 'eye') { if (r > 1.3) { zoomOut(true); drag = null; } return; }
      if (followId != null && mode !== 'orbit') { if (drag.k * r < CHASE_MIN * 0.75) { zoomIn(true); drag = null; return; } chaseK = Math.max(CHASE_MIN, Math.min(CHASE_MAX, drag.k * r)); return; }
      oDist = Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, drag.dist * r)); return; }
    const dx = x - drag.x, dy = y - drag.y;
    if (drag.kind === 'wall') { withPick(pick(x, y), () => updateWallDrag(x, y)); return; }
    if (drag.kind === 'cmd') return;
    if (drag.kind === 'minimap') { minimapJump(x, y); return; }                // dragging on the minimap slides the view live (as 2D)
    if (drag.kind === 'place') return;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 8) drag.moved = true;
    if (!drag.moved) return;
    if (drag.kind === 'pan' && followId != null && mode !== 'orbit') {  // riding a character: a drag turns the view, never pans off it
      lookPend.yaw += (x - drag.x) * 0.006; if (mode === 'eye') lookPend.pitch -= (y - drag.y) * 0.004;
      drag.x = x; drag.y = y; lookUntil = performance.now() + 2500; return; }
    if (drag.kind === 'pan') { const k = oDist / (renderer.domElement.clientHeight * 0.9), fx = -Math.cos(oYaw), fz = -Math.sin(oYaw); // grab the ground: the map follows the finger
      panBy((-fz * -dx + fx * dy) * k, (fx * -dx + fz * dy) * k); }
    if (drag.kind !== 'box') { drag.x = x; drag.y = y; } else { drag.x = x; drag.y = y; showBox(drag); }
  }
  function onUp(ev){
    if (!world) return;
    const had = ptrs.delete(ev.pointerId); if (!had) return;
    const x = ev.clientX, y = ev.clientY, d = drag;
    if (ptrs.size) { if (d && d.kind === 'pinch') drag = null; return; }
    drag = null; showBox(null);
    if (!d) return;
    if (d.kind === 'minimap') { minimapDragging = false; return; }
    if (d.kind === 'wall') { finalizeWallDrag(); return; }
    if (d.kind === 'place') { withPick(pick(x, y), () => doPlace(x, y)); return; }
    if (d.kind === 'box') { if (d.moved) boxSelect(d.x0, d.y0, x, y); else tapAt(x, y, ev.shiftKey); return; }
    if (d.timer) clearTimeout(d.timer);
    if (d.kind === 'cmd') { commandAt(x, y); return; }
    if (d.kind === 'pan' && d.tap && !d.moved) tapAt(x, y, false);
  }
  let boxEl = null;
  function showBox(d){
    if (!boxEl) { boxEl = document.createElement('div'); boxEl.style.cssText = 'position:fixed;border:1px dashed #0f0;pointer-events:none;z-index:7;display:none'; document.body.appendChild(boxEl); }
    if (!d || !d.moved) { boxEl.style.display = 'none'; return; }
    Object.assign(boxEl.style, { display: 'block', left: Math.min(d.x0, d.x) + 'px', top: Math.min(d.y0, d.y) + 'px', width: Math.abs(d.x - d.x0) + 'px', height: Math.abs(d.y - d.y0) + 'px' });
  }

  // ---- The world view's 2D overlay: the map's own UI marks, drawn over the 3D ----
  // A transparent canvas over the 3D one. Each frame: the 2D map's order overlays
  // and particles (render.js drawOrderOverlays / drawParticles — the SAME code, its
  // mapToScreen projecting through the 3D camera for the call), then the unit and
  // building marks the 2D painters carry (HP bars when damaged, cyan while building;
  // train/research progress; garrison counts; the idle villager's "?"), at the 2D sizes.
  let ov = null, ovx = null, _hb = null;
  function ensureOverlay(){
    if (ov) return;
    ov = document.createElement('canvas'); ov.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    pip.insertBefore(ov, renderer.domElement.nextSibling); ovx = ov.getContext('2d');
  }
  const ovProj = (x, h, z) => { _v3.set(x, h, z).project(camera); return { sx: (_v3.x + 1) / 2 * ov.clientWidth, sy: (1 - _v3.y) / 2 * ov.clientHeight, behind: _v3.z > 1 }; };
  function drawOverlay(){
    ensureOverlay(); _v3 = _v3 || new THREE.Vector3();
    const w = ov.clientWidth, h = ov.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (ov.width !== Math.round(w * dpr) || ov.height !== Math.round(h * dpr)) { ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr); }
    ovx.setTransform(dpr, 0, 0, dpr, 0, 0); ovx.clearRect(0, 0, w, h);
    const sv = { X, W, H, topH, ZOOM, m2s: mapToScreen };
    try {
      X = ovx; W = w; H = h; topH = 0; ZOOM = 1;
      mapToScreen = (x, y) => { const p = ovProj(x, 0, y); return p.behind ? { sx: -9999, sy: -9999 } : p; };
      window.__pick3D = hoverXY && (window.settingGuard || window.settingRally) ? pick(hoverXY.x, hoverXY.y) : null;          // the flag ghost reads the hovered tile (screenToTile)
      drawParticles();
      drawOrderOverlays();
      // a loaded ram flies its team flag + rider count (own team), as the 2D painter
      for (const u of entities) {
        if (u.utype !== 'ram' || u.team !== myTeam || !(u.garrison && u.garrison.length) || u.hp <= 0) continue;
        const [x, z] = drawnAt(u), p = ovProj(x, 0.55, z); if (p.behind) continue;
        const bh = 14, poleLen = 28, fy = p.sy - bh - 2 - poleLen, label = String(u.garrison.length);
        drawWavingFlag(p.sx, p.sy, bh, teamColor(u.team), teamColorDark(u.team), poleLen);
        ovx.font = 'bold 12px sans-serif'; ovx.textAlign = 'left'; const tw = ovx.measureText(label).width + 9;
        ovx.fillStyle = 'rgba(0,0,0,0.6)'; ovx.fillRect(p.sx + 3, fy - 2, tw, 15); ovx.fillStyle = '#ffd700'; ovx.fillText(label, p.sx + 7, fy + 9);
      }
    } finally { window.__pick3D = null; X = sv.X; W = sv.W; H = sv.H; topH = sv.topH; ZOOM = sv.ZOOM; mapToScreen = sv.m2s; }
    // units: HP bar when damaged (2D: 18×5 over the head), idle villager's "?"
    ovx.lineWidth = 2;
    for (const u of entities) {
      if (u.type !== 'unit' || u.hp <= 0 || u.garrisonedIn || !unitVisible(u)) continue;
      if (u.id === followId && mode === 'eye') continue;
      const idle = u.team === myTeam && u.utype === 'villager' && !u.task && !u.target;
      if (u.hp >= u.maxHp && !idle) continue;
      const [x, z] = drawnAt(u); if ((x - camAt.x) ** 2 + (z - camAt.y) ** 2 > RANGE * RANGE) continue;
      const top = ovProj(x, (PICK_H[u.utype] || 0.32) * 2 + 0.06, z); if (top.behind) continue;
      if (u.hp < u.maxHp) { const sx = top.sx, y = top.sy - 8;
        ovx.fillStyle = '#000000'; ovx.fillRect(sx - 9, y, 18, 5); ovx.fillStyle = '#300'; ovx.fillRect(sx - 8, y + 1, 16, 3);
        ovx.fillStyle = u.hp / u.maxHp > 0.5 ? '#0c0' : '#c00'; ovx.fillRect(sx - 8, y + 1, 16 * u.hp / u.maxHp, 3); }
      if (idle) { ovx.fillStyle = '#ffd700'; ovx.strokeStyle = '#000'; ovx.font = 'bold 16px sans-serif'; ovx.textAlign = 'center';
        ovx.strokeText('?', top.sx, top.sy - (u.hp < u.maxHp ? 12 : 2)); ovx.fillText('?', top.sx, top.sy - (u.hp < u.maxHp ? 12 : 2)); }
    }
    // buildings: HP/construction bar, train or research progress, garrison count — above the roof
    _hb = _hb || new THREE.Box3();
    for (const [id, rec] of solids) {
      const e = entitiesById.get(id); if (!e || e.type !== 'building' || e.hp <= 0 || !rec.obj || !rec.obj.visible) continue;
      const f = buildingFogLevel(e); if (!(f === 2 || sameSide(e.team, myTeam))) continue;
      const hurt = e.hp < e.maxHp, busy = (e.queue && e.queue.length) || e.research, garr = e.team === myTeam && e.garrison && e.garrison.length;
      if (!hurt && !busy && !garr) continue;
      if (rec.topY == null || rec.topKey !== rec.key) { _hb.setFromObject(rec.obj); rec.topY = _hb.max.y; rec.topKey = rec.key; }
      const c = centerOf(e), t = ovProj(c.x, rec.topY + 0.08, c.y); if (t.behind) continue;
      const bw = (BLDGS[e.btype].w || 1) * 24, sx = t.sx; let y = t.sy - 11;
      if (hurt) { ovx.fillStyle = '#000000'; ovx.fillRect(sx - bw / 2 - 1, y, bw + 2, 6); ovx.fillStyle = !e.complete ? '#012c33' : '#300'; ovx.fillRect(sx - bw / 2, y + 1, bw, 4);
        ovx.fillStyle = !e.complete ? '#00ffff' : (e.hp / e.maxHp > 0.5 ? '#0c0' : '#c00'); ovx.fillRect(sx - bw / 2, y + 1, bw * e.hp / e.maxHp, 4); y += 7; }
      const bar = (pct, bg, fg) => { ovx.fillStyle = '#000000'; ovx.fillRect(sx - bw / 2 - 1, y, bw + 2, 5); ovx.fillStyle = bg; ovx.fillRect(sx - bw / 2, y + 1, bw, 3); ovx.fillStyle = fg; ovx.fillRect(sx - bw / 2, y + 1, bw * Math.min(1, pct), 3); };
      if (e.queue && e.queue.length) bar(e.trainTick / trainDurationFor(e.team, e.queue[0]), '#003', '#0af');
      if (e.research) bar(e.research.tick / researchDurationFor(e.team, e.research.target), '#330', '#fc0');
      if (garr) { const label = String(e.garrison.length); ovx.font = 'bold 12px sans-serif'; ovx.textAlign = 'left';
        const tw = ovx.measureText(label).width + 9; ovx.fillStyle = 'rgba(0,0,0,0.6)'; ovx.fillRect(sx + 3, t.sy - 30, tw, 15); ovx.fillStyle = '#ffd700'; ovx.fillText(label, sx + 7, t.sy - 19); }
    }
  }
  // ---- The selection outline, the placement ghost ----
  let _v2 = null;
  function hideSelectionFx(){ if (ghost) ghost.g.visible = false; }
  // The 2D map's behind-building outlines (render-outlines drawBehindBuildingOutlines): a unit hidden by a building
  // or a tree shows a thin team-colour outline over it. Drawn in the frame itself, no offscreen pass: each nearby
  // unit's meshes get twins in the x-ray group, which draws after the scenery and before the units (group order:
  // scenery 0, x-ray 5, units 10). Twins pass only where something already drawn is NEARER (GreaterDepth): the
  // body's twin marks its hidden pixels in the stencil, then the ink shell's twin paints team colour outside them —
  // a rim. The real unit draws last and covers whatever is actually in view.
  let xray = null; const xTwins = new Map(); // source mesh → twin
  // A twin material for a skinned mesh is its own copy: one material drawn on both skinned and plain meshes has its
  // shader program swapped (re-set up) at every change between them.
  const skinnedCopies = new WeakMap();
  function skinnedTwin(m, skinned){
    if (!skinned) return m; let c = skinnedCopies.get(m);
    if (!c) { c = m.clone(); c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; c.onBeforeRender = m.onBeforeRender; skinnedCopies.set(m, c); }
    return c;
  }
  let _xr = null;
  function updateXray(){
    if (!xray) {
      xray = new THREE.Group(); xray.renderOrder = 5; scene.add(xray);
      const m = o => { const x = new THREE.MeshBasicMaterial({ depthWrite: false, depthFunc: THREE.GreaterDepth, stencilWrite: true, stencilRef: 1,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, ...o }); x.onBeforeCompile = function(){}; x.onBeforeCompile.fow = true; return x; };
      xray.userData = { mask: m({ colorWrite: false, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp }), rim: new Map(),
        rimOf: t => { let r = xray.userData.rim.get(t); if (!r) { xray.userData.rim.set(t, r = screenHull(m({ color: teamColor(t), side: THREE.BackSide, stencilFunc: THREE.NotEqualStencilFunc }), HULL * 2, 2.4));
          r.onBeforeCompile.fow = true; } return r; } }; // the ink shell pushed wider: a rim ~1px outside the ink
    }
    const on = world && mode !== 'eye';   // (not through the eyes: team rims through every wall and tree would crowd a first-person view)
    xray.visible = on;
    const used = new Set();
    if (on) {
      // only a unit something actually stands in front of: a building's box on the line from the lens to it, or a tree
      // crown over that line within a couple of tiles of it
      const bl = [];
      for (const rec of solids.values()) if (rec.obj && rec.obj.visible && rec.obj.userData.bid != null) {
        if (!rec.box || rec.boxKey !== rec.key) { rec.box = new THREE.Box3().setFromObject(rec.obj); rec.boxKey = rec.key; } bl.push(rec.box); }
      _xr = _xr || { ray: new THREE.Ray(), p: new THREE.Vector3(), hit: new THREE.Vector3() };
      const cam = camera.position, R = _xr.ray;
      const hidden = v => {
        _xr.p.set(v.x, 0.3, v.z); const dist = cam.distanceTo(_xr.p); R.origin.copy(cam); R.direction.copy(_xr.p).sub(cam).normalize();
        for (const b of bl) if (R.intersectBox(b, _xr.hit) && cam.distanceTo(_xr.hit) < dist - 0.05) return true;
        const dx = cam.x - v.x, dz = cam.z - v.z, dh = Math.hypot(dx, dz) || 1;                   // back toward the lens, along the ground
        for (let s = 0.5; s <= 2.5; s += 0.5) { const x = v.x + dx / dh * s, z = v.z + dz / dh * s, ty = Math.floor(z), tx = Math.floor(x), t = map[ty] && map[ty][tx];
          if (t && t.t === TERRAIN.FOREST && t.res > 60 && fog[ty][tx] && 0.3 + (cam.y - 0.3) * s / dh < TREE_H + CROWN_R * 1.2) return true; }
        return false; };
      for (const u of entities) {
        if (u.type !== 'unit' || u.hp <= 0 || u.garrisonedIn || (u.id === followId && mode === 'eye')) continue;
        const v = villagers.get(u.id) || animals.get(u.id); if (!v || !v.obj || !v.obj.visible) continue;
        if (!hidden(v)) continue;
        v.obj.traverse(o => { if (o.isGroup) o.renderOrder = 10; });                              // the unit draws after its x-ray
        v.obj.updateWorldMatrix(true, true);
        v.obj.traverseVisible(o => {
          if (!o.isMesh || o.isInstancedMesh) return;
          const hull = o.material && o.material.side === THREE.BackSide, mat = skinnedTwin(hull ? xray.userData.rimOf(u.team) : xray.userData.mask, o.isSkinnedMesh);
          let t = xTwins.get(o);
          if (!t || t.geometry !== o.geometry) {
            if (t) xray.remove(t);
            if (o.isSkinnedMesh) { t = new THREE.SkinnedMesh(o.geometry, mat); t.bindMode = 'detached'; t.bind(o.skeleton, o.bindMatrix); }
            else t = new THREE.Mesh(o.geometry, mat);
            t.matrixAutoUpdate = false; t.matrixWorldAutoUpdate = false; t.frustumCulled = false; t.renderOrder = hull ? 1 : 0;
            xTwins.set(o, t); xray.add(t);
          }
          t.material = mat; t.matrix.copy(o.matrixWorld); t.matrixWorld.copy(o.matrixWorld); t.visible = true; t.userData.idle = 0; used.add(o); // (the group sits at the origin: local = world)
        });
      }
    }
    // unused: hidden, and dropped only after a while (a unit swapping rigs, or passing behind a building now and then,
    // would otherwise rebuild its twins each time)
    for (const [o, t] of xTwins) if (!used.has(o)) { t.visible = false; if (++t.userData.idle > 120) { xray.remove(t); xTwins.delete(o); } }
  }
  // The 2D selection outline: a white rim just outside the selected shapes' ink, any team, over everything — the
  // x-ray's method with the depth test off. Twins in the selection group (drawn last): the body and its ink shell
  // mark the stencil, then a wider shell paints white everywhere else. A unit's wider shell is its ink shell pushed
  // further (screenHull); a building (no pushable shell) uses its own surfaces with the corner directions averaged.
  let selG = null; const sTwins = new Map(), smoothGeos = new WeakMap(); // source mesh → [mask twin, rim twin]
  function smoothNormals(geo){ // the geometry with every vertex's normal averaged over the faces meeting at its position
    let g = smoothGeos.get(geo); if (g) return g;
    g = geo.clone(); const P = g.attributes.position, N = g.attributes.normal; if (!N) { smoothGeos.set(geo, geo); return geo; }
    const acc = new Map(), key = i => Math.round(P.getX(i) * 1e4) + ',' + Math.round(P.getY(i) * 1e4) + ',' + Math.round(P.getZ(i) * 1e4);
    for (let i = 0; i < P.count; i++) { const k = key(i); let a = acc.get(k); if (!a) acc.set(k, a = [0, 0, 0, []]);
      const n = [N.getX(i), N.getY(i), N.getZ(i)]; if (!a[3].some(q => q[0] * n[0] + q[1] * n[1] + q[2] * n[2] > 0.999)) { a[3].push(n); a[0] += n[0]; a[1] += n[1]; a[2] += n[2]; } }
    const out = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) { const a = acc.get(key(i)); out.set([a[0], a[1], a[2]], i * 3); }
    g.setAttribute('normal', new THREE.BufferAttribute(out, 3)); smoothGeos.set(geo, g); return g;
  }
  function updateSelection(){
    if (!selG) {
      selG = new THREE.Group(); selG.renderOrder = 20; scene.add(selG);
      const m = o => { const x = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, stencilWrite: true, stencilRef: 2, side: THREE.DoubleSide, forceSinglePass: true, ...o });
        x.onBeforeCompile = function(){}; x.onBeforeCompile.fow = true; return x; };
      const mark = { colorWrite: false, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp }, paint = { color: '#ffffff', stencilFunc: THREE.NotEqualStencilFunc };
      const fowOff = x => { x.onBeforeCompile.fow = true; return x; };
      selG.userData = { mask: m(mark), maskInk: fowOff(screenHull(m(mark), HULL, 1.5)),                 // the ink shell as drawn (hullUnionMat's push)
        rimU: fowOff(screenHull(m(paint), HULL * 2.2, 3)), rimB: fowOff(screenHull(m(paint), HULL * 2.5, 3)) };
    }
    const M = selG.userData, used = new Set();
    selG.visible = world; for (const pr of sTwins.values()) for (const t of pr) if (t) t.visible = false; // shown again below if still wanted
    const twin = (o, i, mat, geo) => { let pr = sTwins.get(o); if (!pr) sTwins.set(o, pr = []);
      let t = pr[i]; mat = skinnedTwin(mat, o.isSkinnedMesh);
      if (!t || t.geometry !== geo) { if (t) selG.remove(t);
        if (o.isSkinnedMesh) { t = new THREE.SkinnedMesh(geo, mat); t.bindMode = 'detached'; t.bind(o.skeleton, o.bindMatrix); } else t = new THREE.Mesh(geo, mat);
        t.matrixAutoUpdate = false; t.matrixWorldAutoUpdate = false; t.frustumCulled = false; t.renderOrder = i; pr[i] = t; selG.add(t); }
      t.material = mat; t.matrix.copy(o.matrixWorld); t.matrixWorld.copy(o.matrixWorld); t.visible = true; };
    if (world) for (const s of selected) {
      if (!s || s.hp <= 0 || s.garrisonedIn || (s.id === followId && mode === 'eye')) continue;
      const bld = s.type === 'building', root = bld ? (solids.get(s.id) || {}).obj : (villagers.get(s.id) || animals.get(s.id) || {}).obj;
      if (!root || !root.visible) continue;
      root.updateWorldMatrix(true, true);
      root.traverseVisible(o => {
        if (!o.isMesh || o.isInstancedMesh || !o.geometry.attributes.position) return;
        const shell = o.material && o.material.side === THREE.BackSide;
        if (shell && !bld) { twin(o, 0, M.maskInk, o.geometry); twin(o, 1, M.rimU, o.geometry); }  // a unit's ink shell: its ink marked, the rim pushed wider
        else if (shell) twin(o, 0, M.mask, o.geometry);                                                  // a building's ink shell: marked (the rim starts past it)
        else { twin(o, 0, M.mask, o.geometry); if (bld) twin(o, 1, M.rimB, smoothNormals(o.geometry)); }
        used.add(o);
      });
    }
    for (const [o, pr] of sTwins) if (!used.has(o)) { for (const t of pr) if (t) selG.remove(t); sTwins.delete(o); }
  }
  // The building being placed, as its real model in a see-through green (fits) or red (doesn't), on the hovered tile;
  // a wall drag, a box per tile.
  let ghost = null;
  function updateGhost(){
    if (ghost) ghost.g.visible = false;
    if (!placing || !hoverXY) return;
    // As 2D (drawGhost, render-fx.js): the real piece, see-through in its own colours; no ground tint (it read as a
    // shadow) — a piece that can't go there is tinted red instead
    const t0 = pick(hoverXY.x, hoverXY.y).tile, b = BLDGS[placing];
    const fake = (x, y, w, h) => ({ id: -1, type: 'building', btype: placing, x, y, w, h, team: myTeam, complete: true, hp: b.hp, maxHp: b.hp, buildProgress: 0, buildTime: 200, gateProgress: 0 });
    let pieces, ok;
    if (isWallBtype(placing) && window.isDraggingWall && window.wallDragStart) {   // a run of wall: every tile, linked to each other and to the walls there
      const tiles = getWallElbowTiles(window.wallDragStart, window.wallDragCorner || window.wallDragEnd, window.wallDragEnd).slice(0, 256);
      pieces = tiles.map((t, i) => ({ ...fake(t.x, t.y, 1, 1), id: -1 - i, ok: canPlace(placing, t.x, t.y, myTeam) })); ok = true;
    } else {                                                             // one piece; a gate at the footprint it'd really take along the wall run (gateFootprint)
      let ox = t0.x, oy = t0.y, bw = b.w, bh = b.h;
      if (isGateBtype(placing)) { const fp = gateFootprint(t0.x, t0.y, (tx, ty) => gateBaseAt(tx, ty, placing, myTeam)); ox = fp.ox; oy = fp.oy; bw = fp.gw; bh = fp.gh; }
      ok = canPlace(placing, t0.x, t0.y, myTeam);
      pieces = [{ ...fake(ox, oy, bw, bh), ok }];
    }
    const key = placing + ':' + ageBonus(myTeam) + ':' + ok + ':' + pieces.map(p => p.x + ',' + p.y + ',' + p.w + ',' + p.h + ',' + p.ok).join(';');
    if (!ghost || ghost.key !== key) {
      if (ghost) dropGhost();
      const g = new THREE.Group(), parts = [];
      if (isWallBtype(placing) || isGateBtype(placing)) {
        // Links as 2D's ghost overlay: to the other ghost tiles and (a valid piece only) the walls already there
        const at = new Map(); for (const p of pieces) for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) at.set(y * MAP + x, p);
        const look = (x, y) => at.get(y * MAP + x) || (ok ? occupantAt(x, y) : null);
        for (const p of pieces) { const o = wallModel(p, wallArms(p, look, n => at.has(n.y * MAP + n.x) && n.btype === placing)).obj; g.add(o); parts.push([o, p.ok]); }
      } else {
        const p = pieces[0];
        try { MODELS[placing](g, { ...p, x: 0, y: 0 }); } catch (err) { boxAt(g, '#ffffff', 0, 0, p.w, p.h, 0, 0.5); }
        g.position.set(p.x, 0, p.y); parts.push([g, ok]);
      }
      // see-through in its own colours (2D: the art at 55%); outline shells hidden, a see-through part would show them
      const RED = new THREE.Color('#ff3020');
      for (const [part, good] of parts) part.traverse(o => {
        if (o.isMesh && HULL_MATS.has(o.material)) { o.visible = false; return; }
        if (!o.material) return;
        const own = m => { const c = m.clone(); c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; c.transparent = true; c.opacity = o.isMesh ? 0.7 : 0.35;
          if (!good && c.color) c.color.lerp(RED, 0.65); return c; };
        o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
        o.userData.ghostOwn = true; o.renderOrder = 5;
      });
      scene.add(g); ghost = { g, key };
    }
    ghost.g.visible = true;
  }
  function dropGhost(){
    scene.remove(ghost.g);
    ghost.g.traverse(o => { if (o.geometry && o.geometry.userData.own) o.geometry.dispose(); if (o.userData.ghostOwn) [].concat(o.material).forEach(m => m.dispose()); });
    ghost = null;
  }

  function ensurePip(){
    if (pip) return;
    const st = document.createElement('style');
    st.textContent = `
#pov-pip{position:fixed;right:10px;z-index:40;width:min(46vw,420px);aspect-ratio:16/10;display:none;
  border:2px solid #d8c9a0;border-radius:6px;overflow:hidden;background:#000;box-shadow:0 4px 16px rgba(0,0,0,.5)}
#pov-pip.world{left:0;right:0;width:auto;aspect-ratio:auto;border:0;border-radius:0;box-shadow:none;z-index:6}
#pov-pip canvas{width:100%;height:100%;display:block;touch-action:none}
#pov-pip .pov-bar{position:absolute;top:0;left:0;right:0;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;align-items:center;
  padding:4px 6px;font:12px sans-serif;color:#fff;background:linear-gradient(rgba(0,0,0,.6),transparent);pointer-events:none}
#pov-pip.world .pov-bar{justify-content:flex-start;right:auto;background:none;font-size:13px;padding:6px 8px}
#pov-pip .pov-title{flex:1 0 auto;white-space:nowrap}
#pov-pip.world .pov-title{flex:0 0 auto;text-shadow:0 1px 2px #000}
#pov-pip .pov-btn{pointer-events:auto;cursor:pointer;padding:3px 7px;border-radius:4px;background:rgba(0,0,0,.45);
  border:1px solid rgba(216,201,160,.6);white-space:nowrap;user-select:none}
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
      + '<span class="pov-btn" data-a="full" title="Switch between the 2D map and the 3D world view"></span>'
      + '<span class="pov-btn" data-a="close" title="Close">✕</span></div>'
      + '<div class="pov-hint"></div>'
      + '<div class="pov-joy"><i></i></div><div class="pov-act">ACT</div>';
    titleEl = pip.querySelector('.pov-title');
    const b = a => pip.querySelector(`[data-a="${a}"]`);
    btnFull = b('full'); btnClose = b('close');
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
    actEl.addEventListener('pointerdown', ev => { actEl.setPointerCapture(ev.pointerId); const e = entitiesById.get(followId); actHeld = true; if (e) actNow(e); });
    for (const t of ['pointerup', 'pointercancel']) actEl.addEventListener(t, () => { actHeld = false; });
    btnFull.onclick = () => { if (world) povClose(); else openWorld(); };
    btnClose.onclick = () => povClose();
    document.body.appendChild(pip);
    window.addEventListener('resize', () => { if (renderer && pip.style.display !== 'none') setWorld(world); });
    // Steering keys (and the world view's arrows) are caught before input.js's handlers.
    const typing = ev => ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName); // e.g. MP chat
    window.addEventListener('keydown', ev => {
      if (!pip || pip.style.display === 'none' || typing(ev)) return;
      const k = ev.key.toLowerCase();
      if (steering) {
        if (ev.key === 'Escape') { if (world) leaveToMap(); else povClose(); }
        else if (STEER_KEYS[k]) held.add(STEER_KEYS[k]);
        else if (ev.key === ' ') { // held: the auto-repeat is ignored — actHeldTick keeps the rhythm (a repeat would restart the swing)
          if (!ev.repeat) { const e = entitiesById.get(followId); actHeld = true; if (e) actNow(e); } }
        else return;
      } else if (ev.key === 'Escape' && world && followId != null && mode !== 'orbit') leaveToMap();   // on another's unit (not driving): Esc still leaves
      else return;
      ev.stopPropagation(); ev.preventDefault();
    }, true);
    window.addEventListener('keyup', ev => {
      const k = ev.key.toLowerCase();
      if (ev.key === ' ') actHeld = false;
      if ((STEER_KEYS[k] && held.delete(STEER_KEYS[k])) || (steering && ev.key === ' ')) { ev.stopPropagation(); ev.preventDefault(); } // Space's key-up would click a focused HUD button
    }, true);
    window.addEventListener('blur', () => { held.clear(); actHeld = false; });
  }
  // Wire the world view's pointer input to the canvas (once the renderer exists).
  function wireCanvas(){
    const cv = renderer.domElement;
    if (cv.__wired) return; cv.__wired = true;
    cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp); cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('contextmenu', ev => ev.preventDefault());
    cv.addEventListener('pointerleave', () => { hoverXY = null; });
    cv.addEventListener('wheel', ev => { // the 2D rules: pinch/ctrl or a wheel notch zooms, a trackpad two-finger swipe pans (the map camera, which the 3D view follows)
      if (!world) return; ev.preventDefault();
      if (followId != null && mode === 'eye') { if (ev.deltaY > 0) zoomOut(); else zoomPush = 0; return; }                         // in its eyes: out, back behind it
      if (followId != null && mode !== 'orbit') { // riding a character: any scroll / pinch zooms the chase camera
        if (ev.deltaY < 0 && chaseK <= CHASE_MIN) { zoomIn(); return; }                                       // in past its nearest: into its eyes
        zoomPush = 0; chaseK = Math.max(CHASE_MIN, Math.min(CHASE_MAX, chaseK * (ev.deltaY < 0 ? 1 / 1.03 : 1.03))); return; }
      if (!ev.ctrlKey && isTrackpadWheel(ev)) { camX += ev.deltaX / ZOOM; camY += ev.deltaY / ZOOM; window.cameraFollowId = null; return; }
      if (mode === 'orbit') { zoomPush = 0; zoomBy *= ev.deltaY < 0 ? 1 / 1.02 : 1.02; zoomAt = { x: ev.clientX, y: ev.clientY }; } // a fixed 2% a step, as 2D; applied next frame
    }, { passive: false });
  }

  function startLoop(check){
    loadThree().then(() => {
      if (!check()) return; // closed or switched while loading
      if (!renderer) initScene();
      wireCanvas(); resize();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(loop);
    }).catch(err => {
      console.error('POV 3D: three.js failed to load', err);
      if (typeof showMsg === 'function') showMsg('3D view unavailable');
      povClose();
    });
  }
  // The corner window on a unit (the 👁 button / V), or — in the world view — anchor to it and look through its eyes.
  // No mode switch: the corner window rides behind its unit; the world view zooms between its map camera and a unit's eyes.
  function povOpen(id){
    const e = entitiesById.get(id);
    if (!e || e.type !== 'unit') return;
    if (world) { anchorTo(e); mode = 'chase'; refreshButtons(); return; }
    ensurePip();
    follow(e); eye = null; mode = 'chase';
    pip.style.display = 'block';
    setWorld(false);
    startLoop(() => followId === e.id);
  }
  // The 3D world view (the 2D/3D toggle): anchored to the selected unit, if one.
  // atStart: a match opening in 3D shows its black backdrop while the first frame builds — not a flash of the 2D map.
  function openWorld(atStart){
    ensurePip();
    followId = null; eye = null; mode = 'orbit';                                // the 2D view's camera carries over (a 2D follow too)
    unrevealed = true; pip.style.visibility = atStart ? '' : 'hidden';          // mid-game: the 2D map stays up until the first 3D frame is drawn (no black while loading)
    if (atStart && renderer) renderer.clear();                                  // a rematch: never the last match's final frame
    fadeIn = !!atStart;
    if (fadeIn) { const mm = document.getElementById('minimap-wrap'); if (mm) { mm.style.transition = 'none'; mm.style.opacity = '0'; } } // arrives with the first frame
    pip.style.display = 'block';
    setWorld(true);
    startLoop(() => world);
  }

  function povClose(){
    setSteering(false);
    if (unrevealed) { unrevealed = false; pip.style.visibility = ''; }
    if (fpDimmed) { fpDimmed = false; const mw = document.getElementById('minimap-wrap'); if (mw) mw.classList.remove('fp-active'); }
    if (document.pointerLockElement) document.exitPointerLock();
    cancelAnimationFrame(raf); raf = 0;
    followId = null;
    if (pip) { pip.style.display = 'none'; setWorld(false); }
    drag = null; ptrs.clear(); if (boxEl) boxEl.style.display = 'none';
    if (!scene) return;
    for (const rec of unitSprites.values()) { scene.remove(rec.sprite); rec.tex.dispose(); rec.sprite.material.dispose(); }
    for (const a of animals.values()) dropSolid(a);
    animals.clear();
    for (const v of villagers.values()) dropVillager(v);
    villagers.clear();
    for (const r of corpseModels.values()) dropCorpse(r);
    corpseModels.clear();
    dropFalls();
    for (const [id, r] of vilCorpses) { dropVillager(r); scene.remove(r.blood); r.blood.geometry.dispose(); r.blood.material.dispose(); }
    vilCorpses.clear();
    unitSprites.clear();
    dropBuildings();
  }

  // Toggle for the selected unit: open, switch to it, or close if already on it (the world view: its eyes, or back to orbit).
  function povToggle(id){
    if (world) { if (followId === id) unfollow(); else povOpen(id); return; }
    if (followId === id) povClose(); else povOpen(id);
  }

  window.povOpen = povOpen;
  window.povClose = povClose;
  window.povToggle = povToggle;
  window.toggleView3D = () => { if (world) povClose(); else openWorld(); };
  // A match opens in the 3D world view. ?view=2d|3d picks; automated browsers (the test battery drives the 2D map)
  // default to 2D.
  window.enterDefaultView = () => {
    warmFrames = 2;                                                             // every match start, the world already open (a rematch) or not
    eye = null; camFrom = null; camLast = null;                                 // a new match CUTS to its base (no glide from the last match's view)
    const v = new URLSearchParams(location.search).get('view');
    if (!world && (v ? v !== '2d' : !navigator.webdriver)) openWorld(true);
  };
  window.povWorld = () => world;
  // Fetch three.js while the menu is up, so a match opens straight into 3D.
  if (!/[?&]view=2d/.test(location.search) && !navigator.webdriver)
    window.addEventListener('load', () => setTimeout(() => loadThree().catch(() => {}), 500), { once: true });
  window.__povYaw = () => yaw; // dev: the view's heading (tests)
  window.__povAnimYaw = id => { const a = animals.get(id); return a ? a.yaw : null; }; // dev: an animal's drawn heading (tests)
  window.__pov3dScene = () => scene; // dev: profiling
  window.__povVM = (o, pitch) => { Object.assign(VM, o || {}); if (pitch !== undefined) fpPitch = pitch; const v = villagers.get(followId); return { ...VM, tilt: v && v.vmTilt, hands: v && v.fpHands, S: chh(-8), pose: v && v.lastPose, strike: v && v.fpStrike, mode }; }; // dev: tune the first-person viewmodel
  // The eye button: into character mode on a unit — the camera standing behind it (zoom in for its eyes) — opening
  // the world view if need be; again, back to the map.
  const inEyes = id => world && followId === id && mode !== 'orbit';
  window.povEyesUnit = () => world && mode !== 'orbit' ? followId : null;   // whose character mode, if any (the corner eye button)
  window.povEyes = id => {
    const u = entitiesById.get(id);
    if (!u || u.type !== 'unit' || u.hp <= 0) return;
    if (inEyes(id)) { leaveToMap(); return; }
    if (!world) openWorld();
    blendMs = 1000; anchorTo(u); mode = 'chase'; chaseK = 1; refreshButtons();
  };
  window.__povOnScreen = u => { if (!renderer) return false; _v3 = _v3 || new THREE.Vector3(); const [x, z] = drawnAt(u); _v3.set(x, 0.3, z).project(camera); return _v3.z < 1 && Math.abs(_v3.x) <= 1.05 && Math.abs(_v3.y) <= 1.05; };
  window.__povProject = u => { _v3 = _v3 || new THREE.Vector3(); const [x, z] = drawnAt(u); return project(x, (PICK_H[u.utype] || 0.32), z); }; // dev: a unit's screen spot (tests)
  window.__povPick = (x, y) => { const p = pick(x, y); return { unit: p.unit && p.unit.id, building: p.building && p.building.id, resource: p.resource, map: p.map }; }; // dev: what a click there hits (tests)
  window.__povCam = () => camera.position.toArray().map(v => +v.toFixed(2)); // dev: the camera spot (tests)
  window.__povPose = id => { const v = villagers.get(id); return v ? v.lastPose + ':' + (v.lastLoad || '') : null; }; // dev: a villager's drawn pose and load
  window.__povFacing = id => { const v = villagers.get(id); return v ? +v.yaw.toFixed(2) : null; }; // dev: a unit's drawn heading (tests)
  window.__povDrawnAt = id => { const v = villagers.get(id); return v ? [v.x, v.z] : null; }; // dev: where a villager is drawn (tests)
  window.povFollowing = () => followId;
  window.povSteering = () => steering;
  window.__povRigMix = () => { const out = { templates: rigTemplates.size, meshes: 0, plain: 0, team: 0, detail: 0, hull: 0, lines: 0, other: 0 };
    for (const T of rigTemplates.values()) for (const m of T.meshes) { out.meshes++; const M = m.mat;
      if (m.lines) out.lines++; else if (HULL_MATS.has(M)) out.hull++; else if (tcSwaps.has(M)) out.team++; else if (M.isMeshLambertMaterial && !M.map && !M.userData.detail && !M.transparent) out.plain++; else if (M.userData.detail || M.map) out.detail++; else out.other++; }
    return out; }; // dev
  window.__povBldParts = () => { const out = {}; for (const rec of solids.values()) { if (!rec.obj || !rec.obj.visible || rec.site || rec.dmg) continue; const e = entitiesById.get(rec.obj.userData.bid); if (!e) continue;
    const k = e.btype; if (out[k]) continue; const c = {}; rec.obj.traverseVisible(o => { if (!(o.isMesh || o.isLineSegments)) return; const t = o.isLineSegments ? 'lines' : HULL_MATS.has(o.material) ? 'hull' : (o.name || (o.parent && o.parent.name) || 'mesh'); c[t] = (c[t] || 0) + 1; }); out[k] = c; } return out; }; // dev
  window.__povBldDraws = () => { const out = {}; for (const rec of solids.values()) { if (!rec.obj || !rec.obj.visible) continue; const k = rec.site ? 'site' : rec.dmg ? 'damaged' : rec.door ? 'gate' : 'finished';
    let n = 0; rec.obj.traverseVisible(o => { if (o.isMesh || o.isLineSegments) n++; }); const e = out[k] || (out[k] = { count: 0, draws: 0 }); e.count++; e.draws += n; } return out; }; // dev
  window.__povMem = () => { const sz = m => { let b = 0; for (const v of m.values()) { if (v && v.m) b += v.m.byteLength || 0; } return b; };
    let tv = 0; for (const T of rigTemplates.values()) tv += T.verts || 0; let cv = 0; for (const c of vilCache.values()) cv += c.verts || 0;
    return { rigSamples: rigSamples.size, rigSampleMB: +(sz(rigSamples) / 1048576).toFixed(1), rigTemplates: rigTemplates.size, templateVertsK: Math.round(tv / 1000), vilCache: vilCache.size, vilCacheVertsK: Math.round(cv / 1000),
      tickPos: tickPos.size, heading: heading.size, lastPh: lastPh.size, farmPrev: farmPrev.size, legMaps: legMaps.size, mats: mats.size, blobGeos: blobGeos.size, painted: painted.size, unitSprites: unitSprites.size, villagers: villagers.size }; }; // dev: cache sizes
  window.povStats = () => ({ frames: frame, jsMs: +stats.js.toFixed(2), glMs: +stats.gl.toFixed(2), units: unitSprites.size + villagers.size, animals: animals.size, buildings: solids.size, arrows: feat.shaft ? feat.shaft.n : 0, shadows: feat.shadow ? feat.shadow.mesh.count : 0, calls: renderer ? renderer.info.render.calls : 0, tris: renderer ? renderer.info.render.triangles : 0 });
})();
