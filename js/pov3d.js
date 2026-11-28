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
  const SS = 1.5;                    // canvas texture supersample
  const MAX_UNITS = 60, MAX_UNITS_WORLD = 150;   // the corner window / the 3D world view (rigs are cheap; nearest the camera first)
  const STATIC_MS = 500;             // terrain/trees/building-set refresh cadence
  const BLDG_TOP = 230, BLDG_BASE = 10; // px of headroom above / margin below a footprint

  let THREE = null, loading = null;
  // CROWN_BIT: the stencil bit a tree crown marks (the trees); a building's rim (rimBOf) shows only on it and off the
  // building's own shape (maskB's bit 2) — under a crown in front, never on a unit, a horse, or its own parts
  const CROWN_BIT = 8;
  let unrevealed = false;   // the world view opened, its first frame not drawn yet (window.world3D waits for it)
  let fadeIn = false;       // that first frame fades up (a match opening in 3D)
  let renderer, scene, camera, groundTex, groundData, groundMesh, groundFor = null, fowTex, fowData, SKY, VOID;
  const solids = new Map(), mats = new Map(), animals = new Map(); // animals: id → 3D sheep/bear
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
    window._flatDraw = true; // ...and no hill lift: the camera here is set from the flat spot (js/iso.js)
    try {
      const iso = toIso(wx, wy);
      camX = iso.ix + W / 2 - ax; camY = iso.iy + H / 2 - ay;
      draw();
    } finally {
      window._maskDraw = false; window._povDraw = false; window._flatDraw = false;
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
    // (three's shader error check reads each new program's log back — a forced, blocking compile and link: 100+ ms
    // when a dozen new shaders come into view at once. Off: a broken shader still shows as a GL error in the console.)
    renderer.debug.checkShaderErrors = false;
    renderer.localClippingEnabled = true;                                   // construction sites (constructionSite)
    renderer.setPixelRatio(Math.min(isMobile ? 1.5 : 3, window.devicePixelRatio || 1)); // full res on desktop (below it, edges pixelate vs 2D); capped on phones, full screen gets heavy
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
  // ---- HILLS (js/core.js: elev, groundH) ----
  // The ground's height is put into the SHADERS, for everything at once: a 256² texture of the corner heights, and
  // three.js's own vertex-projection chunk changed to lift each vertex by the ground under it (its world x, z). So the
  // ground itself, every model, instance, billboard, decal and puff rides the hills with no code of its own — a shadow
  // lies along its slope, a wall follows it. Opted out with the define NO_HILL (the clouds, the void beyond the map).
  // A BUILDING is lifted as one piece, by the ground at its centre (lifted by its vertices, the ground a neighbour's
  // pad bends beside it would bend its roof): its baked geometry carries the spot (the hillAt attribute: levelGeo), a
  // material made for one building — a site's, a damaged one's, a ghost's — a uniform (hillAtU: levelMat).
  // The CODE side knows heights in three places only: the camera (camLift: the world is drawn from a camera raised by
  // the ground under the view's anchor, and everything else here reasons in the flat frame), project() and pick().
  const HILL_TOP = 3;   // the texture's full scale, in tiles (≥ the tallest ground: ELEV_LAIR)
  let hillTex = null, hillData = null, hillRev = -1, camLift = 0;
  function initHills(){
    if (hillTex) return;
    hillData = new Uint8Array(256 * 256 * 4);
    hillTex = new THREE.DataTexture(hillData, 256, 256); hillTex.magFilter = hillTex.minFilter = THREE.LinearFilter; hillTex.needsUpdate = true;
    for (const k in THREE.ShaderLib) THREE.ShaderLib[k].uniforms.hillMap = { value: hillTex };   // (cloned by reference: one texture for all)
    THREE.ShaderChunk.common += '\nuniform sampler2D hillMap;\n#ifdef HILL_AT_U\nuniform vec2 hillAtU;\n#endif\n';
    // (a vertex-only chunk every built-in material includes; a geometry without the attribute reads zero: by its vertices)
    THREE.ShaderChunk.clipping_planes_pars_vertex += '\n#define HILL_ATTR\nattribute vec3 hillAt;\n';
    const lift = (v, at = `${v}.xz`) => `${v}.y += texture2D( hillMap, ( ${at} + 0.5 ) / 256.0 ).r * ${HILL_TOP.toFixed(1)};`;
    THREE.ShaderChunk.project_vertex = `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
#endif
#ifdef NO_HILL
	mvPosition = modelViewMatrix * mvPosition;
#else
	mvPosition = modelMatrix * mvPosition;
	vec2 hillXZ = mvPosition.xz;
#ifdef HILL_AT_U
	hillXZ = hillAtU;
#elif defined( HILL_ATTR )
	if ( hillAt.z > 0.5 ) hillXZ = hillAt.xy;
#endif
	${lift('mvPosition', 'hillXZ')}
	mvPosition = viewMatrix * mvPosition;
#endif
gl_Position = projectionMatrix * mvPosition;`;
    const sv = THREE.ShaderLib.sprite, at = 'vec4 mvPosition = modelViewMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );';
    if (sv.vertexShader.includes(at)) sv.vertexShader = sv.vertexShader.replace(at, `vec4 hillW = modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ); ${lift('hillW')} vec4 mvPosition = viewMatrix * hillW;`);
  }
  const noHill = m => { m.defines = Object.assign(m.defines || {}, { NO_HILL: '' }); return m; };
  function levelMat(c, at){   // c: a material of its own (a clone); at: { value: Vector2 } — the building's centre
    const ob = c.onBeforeCompile; c.defines = Object.assign({}, c.defines, { HILL_AT_U: '' });
    c.onBeforeCompile = function(sh, r){ if (ob) ob.call(this, sh, r); sh.uniforms.hillAtU = at; }; c.onBeforeCompile.fow = !!(ob && ob.fow);
    return c;
  }
  function levelGeo(root, x, z){   // every geometry of its own under root (baked: bakeStill)
    root.traverse(o => { const g = o.geometry; if (!g || !g.userData.own || !g.attributes.position || g.attributes.hillAt) return;
      const n = g.attributes.position.count, a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = x; a[i * 3 + 1] = z; a[i * 3 + 2] = 1; }
      g.setAttribute('hillAt', new THREE.BufferAttribute(a, 3)); });
  }
  const standsLevel = e => !!e && e.type === 'building' && !isWallBtype(e.btype) && !isGateBtype(e.btype);   // (a wall and a gate follow the slope)
  function updateHills(dt){
    ensureElevation();
    if (elevRev !== hillRev) { hillRev = elevRev; hillData.fill(0);
      if (elevAny) { const n = MAP + 1; for (let y = 0; y < n && y < 256; y++) for (let x = 0; x < n && x < 256; x++) hillData[(y * 256 + x) * 4] = Math.round(Math.min(1, elev[y * n + x] / HILL_TOP) * 255); }
      hillTex.needsUpdate = true; lastStatic = 0; }   // (the ground's slope shading is baked with the static refresh)
    const to = eye ? groundH(eye.x, eye.y) : 0; camLift += (to - camLift) * Math.min(1, (dt || 0.016) * 10);
    if (Math.abs(to - camLift) < 1e-4) camLift = to;
  }
  // The lift follows the ground under each VERTEX, which shears a body standing on a slope (a horse's head rides higher
  // than its tail). A unit model stands upright instead: its root matrix carries the opposite shear, so the whole body
  // is lifted by the ground under its feet. Run once a frame, after every pose has set the root's position.
  let _shear = null;
  function standUpright(o){
    if (!o || o.userData.vm) return;                                 // (the first-person viewmodel is placed in camera space)
    if (!elevAny) { o.matrixAutoUpdate = true; return; }
    const x = o.position.x, z = o.position.z, d = 0.35;
    const gx = (groundH(x + d, z) - groundH(x - d, z)) / (2 * d), gz = (groundH(x, z + d) - groundH(x, z - d)) / (2 * d);
    _shear = _shear || new THREE.Matrix4();
    _shear.set(1, 0, 0, 0,  -gx, 1, -gz, gx * x + gz * z,  0, 0, 1, 0,  0, 0, 0, 1);
    o.updateMatrix(); o.matrix.premultiply(_shear); o.matrixAutoUpdate = false; o.matrixWorldNeedsUpdate = true;
  }
  function initShared(){
    initHills();
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
            float pw = clamp(uHullW * projectionMatrix[1][1] * 0.5 * uHullRes.y / gl_Position.w, uHullPx, uHullPx * 2.2);
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
    const m = noHill(new THREE.MeshLambertMaterial({ color: '#b3d4ec', emissive: '#86b0d2', emissiveIntensity: 0.6, fog: false }));
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
  // The map size is a uniform, not baked into the shader: a material compiled for one match's map keeps sampling right
  // when the next match's map is another size (baked, a 90-tile key read a 60-tile map's fog off by a third: black units).
  const fowU = { value: null }, fowN = { value: 1 }; let fowHooked = false;
  function fowPatch(m){
    if (!(m.isMeshBasicMaterial || m.isMeshLambertMaterial || m.isMeshStandardMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial)) return;
    const prev = m.onBeforeCompile, key = m.customProgramCacheKey() + '|fow';   // key read BEFORE the swap (the default key is the function's source)
    const f = function(sh, r){ prev.call(this, sh, r); sh.uniforms.fowMap = fowU; sh.uniforms.fowSize = fowN;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vFowUv; uniform float fowSize;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 fowW = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            fowW = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);   // (a tree, a rock: lit by the fog of the tile it stands on — a crown over unexplored ground doesn't go black)
          #endif
          fowW = modelMatrix * fowW; vFowUv = vec2(fowW.x / fowSize, 1.0 - fowW.z / fowSize);`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D fowMap; varying vec2 vFowUv;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb *= texture2D(fowMap, vFowUv).r;'); };
    f.fow = true; m.onBeforeCompile = f; m.customProgramCacheKey = () => key; m.needsUpdate = true;
  }
  function hookFow(){
    if (fowHooked) return; fowHooked = true;
    THREE.Mesh.prototype.onBeforeRender = function(r, s, c, g, m){ if (m && !m.onBeforeCompile.fow && fowU.value) fowPatch(m); };
  }
  const GROUND_SINK = 0.12;
  function buildGround(){
    if (groundMesh) { scene.remove(groundMesh); groundMesh.traverse(o => o.geometry && o.geometry.dispose()); groundTex.dispose(); fowTex.dispose(); }
    // (the painted picture, render-terrain's groundArt — the 2D's; a slope's shade rides the fog texture's blue)
    groundData = new Uint8Array(MAP * MAP * 4); groundArtVer = -1; bshadowSig = null;
    if (typeof groundArt === 'function') { groundTex = new THREE.CanvasTexture(groundArt().c); groundTex.magFilter = THREE.NearestFilter; groundTex.anisotropy = 8; }   // (its pixels crisp up close, as the 2D's)
    else groundTex = new THREE.DataTexture(groundData, MAP, MAP);
    groundTex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(MAP, MAP, MAP, MAP);   // (a vertex a tile corner: the hills lift them — initHills)
    geo.rotateX(-Math.PI / 2);
    // No depth writes, drawn first: sprite billboards may dip below y=0.
    fowData = new Uint8Array(MAP * MAP * 4);
    fowTex = new THREE.DataTexture(fowData, MAP, MAP); fowTex.magFilter = fowTex.minFilter = THREE.NearestFilter; // crisp tile edges, as 2D
    fowU.value = fowTex; fowN.value = MAP; hookFow();
    const gm = new THREE.MeshBasicMaterial({ map: groundTex, depthWrite: false });
    gm.onBeforeCompile = sh => { sh.uniforms.fowMap = { value: fowTex };
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D fowMap;')
        .replace('#include <map_fragment>', '#include <map_fragment>\nvec4 fowG = texture2D(fowMap, vMapUv); diffuseColor.rgb *= fowG.r * (1.0 + (fowG.b * 255.0 - 128.0) * 0.0055);'); };   // (r: the fog; b: a slope's shade, as the 2D's)
    gm.customProgramCacheKey = () => 'ground-fow';
    gm.onBeforeCompile.fow = true;
    groundMesh = new THREE.Mesh(geo, gm);
    groundMesh.renderOrder = -1;
    groundMesh.position.set(MAP / 2, 0, MAP / 2);
    scene.add(groundMesh);
    // The ground hides what is behind a hill: it writes no depth itself (above), so a copy of it does — unseen, and
    // GROUND_SINK lower, clear of all that lies on or just under the ground (patches, shadows, outline shells).
    const sink = new THREE.MeshBasicMaterial({ colorWrite: false }); sink.onBeforeCompile = function(){}; sink.onBeforeCompile.fow = true;
    const under = new THREE.Mesh(geo, sink); under.position.y = -GROUND_SINK; under.renderOrder = -3; groundMesh.add(under);
    // beyond the map's edge: black too (the 2D map's void), just under the ground
    const edge = new THREE.Mesh(new THREE.PlaneGeometry(MAP * 5, MAP * 5).rotateX(-Math.PI / 2), noHill(new THREE.MeshBasicMaterial({ color: '#000000', depthWrite: false }))); // hazed like the ground: no hard band against the sky
    edge.position.set(0, -0.002, 0); edge.renderOrder = -2; groundMesh.add(edge);             // (a child: it's rebuilt and dropped with the ground)
    groundFor = map;
    dropBuildings(); dropUnits(); heading.clear(); // a new world reuses entity ids
  }

  const rgbCache = new Map();
  function rgb(hex){
    let c = rgbCache.get(hex);
    if (!c) { const n = parseInt(hex.slice(1), 16); c = [n >> 16, (n >> 8) & 255, n & 255]; rgbCache.set(hex, c); }
    return c;
  }
  let groundArtVer = -1, bshadow = null, bshadowSig = null;
  function refreshGround(){
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
      const f = (fog[y] && fog[y][x]) || 0;
      const i = ((MAP - 1 - y) * MAP + x) * 4; // texture row 0 is the plane's far (+Z) edge
      // the tile's own colour and the fog of war, both per tile and crisp as 2D: unexplored black, explored-but-unseen dimmed
      fowData[i] = f === 2 ? 255 : f ? 140 : 0; fowData[i + 1] = 0; fowData[i + 2] = 128 + (elevAny && typeof hillShade === 'function' ? hillShade(x, y) * 10 : 0); fowData[i + 3] = 255;
      const cols = TCOL[map[y][x].t === TERRAIN.FOREST ? TERRAIN.GRASS : map[y][x].t] || TCOL[0]; // under a tree, grass: its shadow does the darkening
      const c = rgb(cols[(x * 7 + y * 13) % cols.length]), k = elevAny && typeof hillShade === 'function' ? 1 + hillShade(x, y) * 0.055 : 1;   // (a slope's shade, as 2D's)
      groundData[i] = Math.min(255, c[0] * k); groundData[i + 1] = Math.min(255, c[1] * k); groundData[i + 2] = Math.min(255, c[2] * k); groundData[i + 3] = 255;
    }
    const art = groundTex.isCanvasTexture ? groundArt() : null;
    // A building shows at ONE fog level, as 2D draws it (buildingFogLevel): its whole footprint takes that level in the
    // fog texture, so a building half on unexplored ground isn't half black
    for (const e of entities) {
      if (e.type !== 'building' || e.hp <= 0 || !bldgVisible(e)) continue;
      const lv = buildingFogLevel(e) === 2 ? 255 : 140, b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h;
      for (let y = e.y; y < e.y + h; y++) for (let x = e.x; x < e.x + w; x++) {
        if (x < 0 || y < 0 || x >= MAP || y >= MAP) continue; const i = ((MAP - 1 - y) * MAP + x) * 4; if (fowData[i] < lv) fowData[i] = lv; }
    }
    // Building shadows: flat shapes on the ground under what is solid (buildingShadowPolys, render-buildings — the 2D's),
    // one mesh for them all, remade when the buildings in sight change. They share the trees' and units' stencil bit:
    // overlapping shadows darken once.
    let sig = ''; const cast = [];
    for (const e of entities) { if (e.type !== 'building' || e.hp <= 0 || !bldgVisible(e)) continue; cast.push(e); sig += e.id + ':' + e.btype + ':' + e.x + ',' + e.y + ',' + (e.w || 0) + (e.complete === false ? 's' : '') + ';'; }
    if (sig !== bshadowSig) { bshadowSig = sig; const pos = [];
      for (const e of cast) for (const poly of buildingShadowPolys(e)) for (let i = 1; i < poly.length - 1; i++) for (const q of [poly[0], poly[i + 1], poly[i]]) pos.push(q[0], 0.005, q[1]);
      if (!bshadow) { bshadow = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: SHADOW, depthWrite: false,
        stencilWrite: true, stencilRef: 4, stencilFuncMask: 4, stencilWriteMask: 4, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp, side: THREE.DoubleSide })); bshadow.frustumCulled = false; }
      if (bshadow.parent !== scene) scene.add(bshadow);
      bshadow.geometry.dispose(); bshadow.geometry = new THREE.BufferGeometry(); bshadow.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bshadow.visible = pos.length > 0; }
    if (!art) groundTex.needsUpdate = true; else if (art.ver !== groundArtVer) { groundArtVer = art.ver; if (!groundSubUpload(art.dirty)) groundTex.needsUpdate = true; art.dirty = []; }
    fowTex.needsUpdate = true;
  }

  // The ground's mended boxes, sent to its texture alone: a whole upload of the picture (MAP·GROUND_PX square, 33MB on a
  // 90-tile map) stalled a phone's GPU ~100ms at every path worn or building sighted. False: upload it whole.
  function groundSubUpload(boxes){
    const p = renderer.properties.get(groundTex);
    if (!boxes || boxes.length > 32 || !p.__webglTexture || p.__version !== groundTex.version) return false;   // (not up yet, or new: whole)
    const gl = renderer.getContext(), D = groundArt().d, N = D.width, H = D.height;
    renderer.state.bindTexture(gl.TEXTURE_2D, p.__webglTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const [x, y, w, h] of boxes) { const buf = new Uint8Array(w * h * 4);
      for (let r = 0; r < h; r++) buf.set(D.data.subarray(((y + r) * N + x) * 4, ((y + r) * N + x + w) * 4), (h - 1 - r) * w * 4);   // (flipped: the texture's row 0 is the picture's last, flipY)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, H - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf); }
    if (groundTex.generateMipmaps && groundTex.minFilter !== THREE.NearestFilter && groundTex.minFilter !== THREE.LinearFilter) gl.generateMipmap(gl.TEXTURE_2D);
    return true;
  }

  function bldgVisible(e){
    const f = buildingFogLevel(e);
    if (f === 0) return false;
    return f === 2 || sameSide(e.team, myTeam) || scoutedByMe.has(e.id);
  }
  function dropBuildings(){
    for (const w of solids.values()) dropSolid(w);
    solids.clear(); wallRuns();
  }

  // ART PROTOTYPE (?proto, or window.__artProto before the 3D loads): faces, fuller wheat. Viewer-only look; off by
  // default until approved.
  const ART_PROTO = typeof location !== 'undefined' && /[?&]proto\b/.test(location.search) || !!window.__artProto;
  // the steel (forge tiers, blades, tools, helmets) and gold colours: a broad sheen, as the painted icons' highlights
  const SHINY = new Map([['#a7abb0', 1], ['#a8adb3', 1], ['#c6cdd8', 1], ['#b9bec6', 1], ['#b8bfc6', 1], ['#dde3ea', 1], ['#f2f6fb', 1],
    ['#daa520', 2], ['#e8b90f', 2], ['#d1a017', 2], ['#c99815', 2]]);
  const DETAIL_K = 1.7;   // surface pattern contrast (the pattern's darkening, scaled up)
  // col is '#rrggbb', or '#rrggbb|detail' to add a surface texture (DETAIL).
  function mat(col, twoSided){
    const k = col + (twoSided ? '/2' : '');
    let m = mats.get(k);
    if (!m) {
      const [color, detail] = col.split('|');
      // Depth offsets order near-coincident layers: ink lines over surfaces,
      // surfaces over the outline hulls (else they fight at grazing angles).
      const shine = SHINY.get(color), base = { color, side: twoSided ? THREE.DoubleSide : THREE.FrontSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
      m = shine ? new THREE.MeshPhongMaterial({ ...base, specular: shine === 2 ? '#fff2b0' : '#6b6b6b', shininess: shine === 2 ? 22 : 24 }) : new THREE.MeshLambertMaterial(base);   // (steel: a soft sheen; gold: a glint)
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
  // UVs. Its darkening is scaled by DETAIL_K: courses and boards read, the art stays flat-colored.
  const DETAIL = { // [world units per tile repeat, painter]
    planks:  [0.5, (c, r) => rows(c, r, 4, true)],
    planksR: [0.5, (c, r) => { c.translate(64, 0); c.rotate(Math.PI / 2); rows(c, r, 4, true); }], // boards running the other way
    stakes:  [0.5, (c, r) => { c.translate(64, 0); c.rotate(Math.PI / 2); rows(c, r, 4, false); }], // upright palisade logs
    stone:   [0.6, (c, r) => blocks(c, r, 4, 2)],
    // a stone wall's masonry, as the 2D draws it (drawWallLink): three equal courses to the wall's height (14 art px:
    // the pattern repeats every six), bricks about a third of a tile long in running bond, one flat tone; joints as dark as blocks()'
    wall:    [28 / (PX * Math.sqrt(3) / 2), c => { tone(c, 255); c.fillRect(0, 0, 64, 64); tone(c, 190);
      for (let i = 0; i < 6; i++) { c.fillRect(0, i * 64 / 6, 64, 1.2); for (let j = 0; j < 2; j++) c.fillRect((j + (i % 2) * 0.5) * 32, i * 64 / 6, 1.2, 64 / 6); } }],
    slabs:   [2, (c, r) => blocks(c, r, 2, 2, 0)],
    shingles:[0.4, (c, r) => blocks(c, r, 6, 6)],
    plaster: [1, (c, r) => speckle(c, r, 240)],
    thatch:  [0.3, (c, r) => { tone(c, 255); c.fillRect(0, 0, 64, 64);                      // straw strands down the slope, in courses
      for (let k = 0; k < 70; k++) { tone(c, 196 + r() * 50 | 0); c.fillRect(r() * 64, r() * 64 - 8, 1 + r() * 1.2, 8 + r() * 14); }
      for (let i = 0; i < 4; i++) { tone(c, 186); c.fillRect(0, i * 16 + 15, 64, 1.2); } }],
    soil:    [1, (c, r) => speckle(c, r, 205)],
    // rough-cut stone (the Castle Town Center) — big blocks of uneven length, a tone each, lit along the top, shaded along the bottom, dark mortar
    rough:   [0.95, (c, r) => { const n = 3, h = 64 / n; tone(c, 150); c.fillRect(0, 0, 64, 64);
      for (let i = 0; i < n; i++) { let x0 = -(r() * 14 | 0); while (x0 < 64) { const w = 15 + r() * 14 | 0, t = 214 + r() * 40 | 0, y = i * h + 1.2;
        for (const dx of [0, 64]) { const bx = x0 + 1.2 - dx; tone(c, t); c.fillRect(bx, y, w - 1.2, h - 1.2); tone(c, Math.min(255, t + 16)); c.fillRect(bx, y, w - 1.2, 1.6);
          tone(c, t - 34); c.fillRect(bx, y + h - 3.4, w - 1.2, 2.2); tone(c, t - 14); c.fillRect(bx + w - 3, y, 1.8, h - 1.2); }
        x0 += w; } } }],
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
  function detailCanvas(name){
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    let seed = name.length * 977; // a fixed pattern per texture (viewer-only, but stable)
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    DETAIL[name][1](cv.getContext('2d'), r);
    return cv;
  }
  // A still model's whole body as ONE material: colour per vertex, and the surface pattern too (the attribute `det`
  // picks a layer of all the patterns stacked in one array texture; -1 none) — a house is a body, its outline, its ink.
  // (after the patterns, a soldier's armour — armorCanvas: its rows in the colour, and in the alpha how much of the
  // owner's colour shows there; laid by the part's uv, not the world)
  const DETAIL_IDS = Object.keys(DETAIL), ARMOR_IDS = ['scale', 'chain'], bodyMats = new Map(); let detailArr = null;
  function detailLayers(){
    if (!detailArr) { const cvs = DETAIL_IDS.map(detailCanvas).concat(ARMOR_IDS.map(armorCanvas)), n = cvs.length, data = new Uint8Array(64 * 64 * 4 * n);
      cvs.forEach((cv, i) => { const px = cv.getContext('2d').getImageData(0, 0, 64, 64).data;
        for (let y = 0; y < 64; y++) data.set(px.subarray(y * 256, y * 256 + 256), i * 16384 + (63 - y) * 256); });   // (rows flipped: as a canvas texture)
      detailArr = new THREE.DataArrayTexture(data, 64, 64, n); detailArr.wrapS = detailArr.wrapT = THREE.RepeatWrapping;
      detailArr.minFilter = THREE.LinearMipmapLinearFilter; detailArr.magFilter = THREE.LinearFilter; detailArr.generateMipmaps = true; detailArr.anisotropy = 4; detailArr.needsUpdate = true; }
    return detailArr;
  }
  // An armour layer: white under its dark rows (a multiplier); alpha = the owner's colour's share (scale: the chest
  // and shoulders whole, above a hard edge; chain: a faint wash all over).
  function armorCanvas(kind){
    const cv = document.createElement('canvas'); cv.width = cv.height = 64; const c = cv.getContext('2d');
    const row = (y0, n, r, dx, col) => { c.strokeStyle = col; c.lineWidth = 1.3; for (let i = 0; i < n; i++) for (let x = (i % 2) * dx / 2 - dx; x < 70; x += dx) { c.beginPath(); c.arc(x, y0 + i * r * 1.45, r, 0, Math.PI); c.stroke(); } };
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 64, 64);
    if (kind === 'scale') { row(31, 6, 3.2, 6.4, 'rgb(153,153,153)'); c.fillStyle = 'rgb(115,115,115)'; c.fillRect(0, 29, 64, 1.6); }
    else row(2, 22, 2.1, 4.2, 'rgb(171,171,171)');
    const im = c.getImageData(0, 0, 64, 64), d = im.data;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) d[(y * 64 + x) * 4 + 3] = kind === 'scale' ? (y < 30 ? 255 : 0) : 51;
    c.putImageData(im, 0, 0); return cv;
  }
  function bodyMat(side){
    let m = bodyMats.get(side); if (m) return m;
    detailLayers();
    m = new THREE.MeshLambertMaterial({ vertexColors: true, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const scales = DETAIL_IDS.map(k => 1 / DETAIL[k][0]);
    m.onBeforeCompile = sh => {
      sh.uniforms.detailArr = { value: detailArr }; sh.uniforms.detailScales = { value: scales }; sh.uniforms.detailK = { value: DETAIL_K };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float det; varying float vDet; varying vec3 vWPos; varying vec3 vWNrm;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvDet = det; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = mat3(modelMatrix) * objectNormal;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vDet; varying vec3 vWPos; varying vec3 vWNrm; uniform mediump sampler2DArray detailArr; uniform float detailScales[' + scales.length + ']; uniform float detailK;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 an = abs(normalize(vWNrm)); int di = int(max(vDet, 0.0) + 0.5);
          vec2 duv = an.y > 0.85 ? vWPos.xz : vec2(an.x > an.z ? vWPos.z : vWPos.x, -vWPos.y);
          vec3 dpat = texture(detailArr, vec3(duv * detailScales[di], float(di))).rgb;
          diffuseColor.rgb *= mix(vec3(1.0), max(vec3(0.0), 1.0 - detailK * (1.0 - dpat)), step(-0.5, vDet));`);
    };
    m.customProgramCacheKey = () => 'body';
    bodyMats.set(side, m); return m;
  }
  function withDetail(m, name){
    const [span, paint] = DETAIL[name];
    let tex = detailTex.get(name);
    if (!tex) {
      tex = new THREE.CanvasTexture(detailCanvas(name)); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 4;
      detailTex.set(name, tex);
    }
    m.onBeforeCompile = sh => {
      sh.uniforms.detailMap = { value: tex }; sh.uniforms.detailScale = { value: 1 / span }; sh.uniforms.detailK = { value: DETAIL_K };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = mat3(modelMatrix) * objectNormal;'); // after skinning: patterns ride a skinned part
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm; uniform sampler2D detailMap; uniform float detailScale; uniform float detailK;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          vec3 an = abs(normalize(vWNrm));
          vec2 duv = an.y > 0.85 ? vWPos.xz : vec2(an.x > an.z ? vWPos.z : vWPos.x, -vWPos.y);
          diffuseColor.rgb *= max(vec3(0.0), 1.0 - detailK * (1.0 - texture2D(detailMap, duv * detailScale).rgb));`);
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
  // (ghostAt: the wall pieces, gate or tower being placed, where they fit — updateGhost. The standing walls see them as
  // the tiles' occupants, so they are drawn as they will be once it is built: the 2D's ghostOverlay, render-fx.js.)
  let ghostAt = new Map(), ghostSig = '';
  const occupantAt = (x, y) => { const g = ghostAt.get(y * MAP + x); if (g) return g; const row = map[y], cell = row && row[x]; return cell && cell.occupied != null ? entitiesById.get(cell.occupied) : null; };
  // A town's wall is hundreds of pieces of three draws each (body, outline, ink). The finished, whole ones are drawn
  // merged, a run per 8×8 tiles; each piece keeps its own model, on a layer the camera doesn't draw, for all that reads
  // it (picking, selection and x-ray rims, bounds). A run is rebuilt when its pieces change, or show or hide.
  const RUN_LAYER = 1, runs = new Map(); let runUid = 0;
  // (its still, merged meshes — not a flag, the sails, a door: those are named, or groups)
  function joinRun(rec, e){
    const c = centerOf(e); rec.run = (c.x >> 3) + (c.y >> 3) * 4096; rec.uid = ++runUid;
    for (const o of rec.obj.children) if ((o.isMesh || o.isLineSegments) && !o.name && !o.children.length) { o.layers.set(RUN_LAYER); o.userData.run = true; }
  }
  function wallRuns(){
    const by = new Map();
    for (const rec of solids.values()) if (rec.run != null && !rec.hid) { let m = by.get(rec.run); if (!m) by.set(rec.run, m = { sig: '', recs: [] }); m.sig += rec.uid + ','; m.recs.push(rec); }
    for (const [k, run] of runs) { const m = by.get(k); if (m && m.sig === run.sig) continue;
      for (const o of run.objs) { scene.remove(o); o.geometry.dispose(); } runs.delete(k); }
    const v = new THREE.Vector3(), nm = new THREE.Matrix3();
    for (const [k, m] of by) { if (runs.has(k)) continue;
      const groups = new Map();
      for (const rec of m.recs) { rec.obj.updateMatrixWorld(true);
        for (const c of rec.obj.children) { if (!c.userData.run) continue; const gk = c.material.uuid + '|' + c.renderOrder; let g = groups.get(gk); if (!g) groups.set(gk, g = { src: c, parts: [] }); g.parts.push(c); } }
      const objs = [];
      for (const { src, parts } of groups.values()) {
        let nv = 0, ni = 0; for (const c of parts) { nv += c.geometry.attributes.position.count; ni += c.geometry.index ? c.geometry.index.count : 0; }
        const bg = new THREE.BufferGeometry(), idx = src.geometry.index ? new Uint32Array(ni) : null; let oi = 0;
        for (const name in src.geometry.attributes) { const size = src.geometry.attributes[name].itemSize, arr = new Float32Array(nv * size); let ov = 0;
          for (const c of parts) { const A = c.geometry.attributes[name], n = c.geometry.attributes.position.count, M = c.matrixWorld;
            if (name === 'position') for (let i = 0; i < n; i++) { v.fromBufferAttribute(A, i).applyMatrix4(M); arr.set([v.x, v.y, v.z], (ov + i) * 3); }
            else if (name === 'normal') { nm.getNormalMatrix(M); for (let i = 0; i < n; i++) { v.fromBufferAttribute(A, i).applyMatrix3(nm); arr.set([v.x, v.y, v.z], (ov + i) * 3); } }   // (not normalised: an outline's push keeps its zero normals)
            else if (A) arr.set(A.array.subarray(0, n * size), ov * size);
            ov += n; }
          bg.setAttribute(name, new THREE.BufferAttribute(arr, size)); }
        if (idx) { let ov = 0; for (const c of parts) { const I = c.geometry.index.array; for (let i = 0; i < I.length; i++) idx[oi++] = I[i] + ov; ov += c.geometry.attributes.position.count; }
          bg.setIndex(new THREE.BufferAttribute(idx, 1)); }
        bg.computeBoundingSphere();
        const o = src.isLineSegments ? new THREE.LineSegments(bg, src.material) : new THREE.Mesh(bg, src.material); o.renderOrder = src.renderOrder; scene.add(o); objs.push(o);
      }
      runs.set(k, { sig: m.sig, objs });
    }
  }
  function refreshWall(e){
    const arms = wallArms(e, occupantAt, n => !isTowerBtype(n.btype)), hurt = isHurt(e), key = wallKey(e, arms) + (hurt ? ':hurt' : '');
    let rec = solids.get(e.id);
    if (rec && rec.key === key) return;
    if (bldSpent > BLD_MS) { bldLeft = true; return; }   // (this frame's building is done: the old model stands till its turn)
    const tb = performance.now();
    if (rec) { if (rec.site && e.complete) siteDone(e); dropSolid(rec); }
    const r = wallModel(e, arms); r.obj.userData.bid = e.id;
    const b = BLDGS[e.btype];
    // (a finished, whole piece merges by material, as a building does, and joins its neighbours' run — wallRuns. A gate:
    // its wall sections merged apart and marked, for its selection rim; the door stays its own.)
    if (e.complete && !hurt) {
      if (r.door) { const g = r.obj, armG = new THREE.Group(); g.remove(r.door);
        for (const c of g.children.filter(c => c.userData.arm)) { g.remove(c); armG.add(c); }
        bakeWhole(armG); bakeWhole(g); bakeWhole(r.door);
        for (const c of armG.children.slice()) { c.userData.arm = true; g.add(c); } }
      else bakeStill(r.obj);
      joinRun(r, e);
      if (r.door) r.obj.add(r.door);
    }
    if (!e.complete) { r.site = constructionSite(r.obj, e.x, e.y, e.w || b.w, e.h || b.h, false); r.siteOf = e.id; }
    else if (hurt) { r.dmg = buildingDamage(r.obj, e.x, e.y, e.w || b.w, e.h || b.h); r.dmg.jump(Math.min(DMG_FROM, e.hp / e.maxHp)); }
    scene.add(r.obj); solids.set(e.id, { ...r, key });
    bldSpent += performance.now() - tb;
  }
  // The links a wall/gate e draws to its same-team wall-like neighbors (at(x, y) → the entity there); shared(n):
  // n draws that link itself, so e leaves its -x/-z one to it.
  // A wall piece's stretches of wall, TILE BY TILE as the 2D (wallPiece, render-buildings.js): each stands on the piece's
  // own tile — from its post (or, with two opposite neighbours and no post, straight through) out to the tile's edge
  // on each side a wall-like neighbour stands; toward a tower or a gate's post, on to that post. A gate draws stretches
  // only toward towers and other gates (a wall piece runs to it). Sevens: tile centre x, z; axis (0: along x, 1: along
  // z); from, to (tiles off that centre); end faces left off at the low / the high end (1: lapped into the neighbour's).
  function wallArms(e, at, shared){
    const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h, arms = [], gate = isGateBtype(e.btype);
    const like = (x, y) => { const n = at(x, y); return !!n && n.team === e.team && isWallLike(n); };
    arms.turned = false; arms.gatePost = false; arms.dg = 0;   // (diagonal walls: off — WALL_DIAGONALS)
    arms.bare = !gate && wallPostless(e, like);
    if (gate) {
      for (let fy = e.y; fy < e.y + h; fy++) for (let fx = e.x; fx < e.x + w; fx++) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = at(fx + dx, fy + dy);
        if (!n || n === e || n.id === e.id || n.team !== e.team || !isWallLike(n) || isWallBtype(n.btype)) continue;
        if (dx + dy < 0 && shared(n)) continue;   // (the other gate's own)
        const s0 = pillarHalf(e), s1 = 1 - pillarHalf(n), neg = dx + dy < 0;
        arms.push(fx + 0.5, fy + 0.5, dx ? 0 : 1, neg ? -s1 : s0, neg ? -s0 : s1, 0, 0);
      }
      return arms;
    }
    const pw2 = pillarHalf(e), LAP = 0.02;
    // toward (dx, dy): how far the piece reaches (0: no neighbour), and whether it laps into a neighbour's stretch
    const reach = (dx, dy) => { const n = at(e.x + dx, e.y + dy); if (!n || n.id === e.id || n.team !== e.team || !isWallLike(n)) return [0, 0];
      if (isWallBtype(n.btype)) return e.complete && n.complete ? [0.5 + LAP, 1] : [0.5, 0];   // (a piece going up: flush, its end face kept)
      if (isGateBtype(n.btype)) { const len = Math.max(n.w || 1, n.h || 1), i = (n.w || 1) >= (n.h || 1) ? e.x + dx - n.x : e.y + dy - n.y; if (i !== 0 && i !== len - 1) return [0.5, 0]; }
      return [1 - pillarHalf(n), 0]; };
    for (const [axis, dx, dy] of [[0, 1, 0], [1, 0, 1]]) {
      const [rb, lb] = reach(-dx, -dy), [rf, lf] = reach(dx, dy);
      if (arms.bare) { if (rb && rf) arms.push(e.x + 0.5, e.y + 0.5, axis, -rb, rf, lb, lf); continue; }
      if (rb) arms.push(e.x + 0.5, e.y + 0.5, axis, -rb, -pw2, lb, 0);
      if (rf) arms.push(e.x + 0.5, e.y + 0.5, axis, pw2, rf, 0, lf);
    }
    return arms;
  }
  const wallKey = (e, arms) => (e.complete ? 1 : 0) + ':' + ageOf(e) + ':' + teamColor(e.team) + ':' + arms.join(',') + (arms.turned ? ':t' : '') + (arms.bare ? ':b' : '') + (arms.gatePost ? ':p' : '') + (arms.dg ? ':d' + arms.dg : '');
  let noFaceMat = null;   // a box face that isn't drawn
  function wallModel(e, arms){
    const noFace = noFaceMat || (noFaceMat = new THREE.MeshBasicMaterial({ visible: false }));
    const b = BLDGS[e.btype], w = e.w || b.w, h = e.h || b.h, gate = isGateBtype(e.btype);
    const stone = e.btype === 'SWALL' || e.btype === 'SGATE', a = ageOf(e), tc = teamColor(e.team);
    const k = 1; // (full height: a site rises by its cut — constructionSite)
    const g = new THREE.Group(), body = stone ? '#cfc8b6|wall' : WOOD.L + '|stakes';
    const pw = (stone ? 9 : 7) / 32, T = pw, linkH = 14 / HPX * k; // links as thick as the pillars (drawWallLink thick = pw/2 px each side)
    // Each stretch (wallArms): a slab with a team top. A lapped end has no end face: lying in the next piece's slab, its
    // top edge on that slab's walkway showed as a pale dashed line.
    for (let i = 0; i < arms.length; i += 7) {
      const [cx, cz, axis, s0, s1, nf0, nf1] = arms.slice(i, i + 7);
      const x0 = axis ? cx - T / 2 : cx + s0, x1 = axis ? cx + T / 2 : cx + s1, z0 = axis ? cz + s0 : cz - T / 2, z1 = axis ? cz + s1 : cz + T / 2;
      const slab = boxAt(g, topped(body, tc), x0, z0, x1, z1, 0, linkH, 'hull');
      slab.userData.arm = true;   // (a gate's selection outline leaves these out: updateSelection)
      softEdges(g, x0, z0, x1, z1, 0, linkH, axis ? 'z' : 'x');
      if (nf0 || nf1) { const f = axis ? 4 : 0; slab.material = slab.material.slice(); if (nf0) slab.material[f + 1] = noFace; if (nf1) slab.material[f] = noFace; }
    }
    if (!gate) {
      for (let fy = e.y; fy < e.y + h && !arms.gatePost && !arms.bare; fy++) for (let fx = e.x; fx < e.x + w; fx++) {
        const pH = 22 / HPX * k, cx = fx + 0.5, cz = fy + 0.5;
        const post = boxAt(g, topped(body, tc), cx - pw / 2, cz - pw / 2, cx + pw / 2, cz + pw / 2, 0, pH, 'hull');
        // (stone, joined: the post's faces and the slabs' are one wall — its soft edges start above them, as the 2D)
        // (stone: no soft edge lines — the post and its walls are one piece of masonry; the bold outline and the light give its shape)
        if (arms.turned) post.rotation.y = Math.PI / 4; else if (!stone) softEdges(g, cx - pw / 2, cz - pw / 2, cx + pw / 2, cz + pw / 2, 0, pH);
      }
      addHulls(g, true); // union outlines: drawn first, the parts paint over them — a run's outline can't show through the pillar it butts into
      return { obj: g };
    }
    // Gate: end pillars on the first and last tile of its line, a door between.
    const alongZ = h > w, n = Math.max(w, h), P = 14 / 32, pH = 28 / HPX * k;
    const dg = arms.dg;   // (on a diagonal run: the posts on the wall pieces either side, the door turned between them)
    const ends = dg === 1 ? [[e.x - 0.5, e.y + 1.5], [e.x + 1.5, e.y - 0.5]] : dg === 2 ? [[e.x - 0.5, e.y - 0.5], [e.x + 1.5, e.y + 1.5]]
      : [[e.x + 0.5, e.y + 0.5], alongZ ? [e.x + 0.5, e.y + n - 0.5] : [e.x + n - 0.5, e.y + 0.5]];
    for (const [cx, cz] of ends) {
      const post = boxAt(g, topped(stone ? '#cfc8b6|wall' : WOOD.L + '|stakes', a >= 2 && stone ? '#b0b0a4' : tc), cx - P / 2, cz - P / 2, cx + P / 2, cz + P / 2, 0, pH, 'hull');
      if (dg) { post.rotation.y = Math.PI / 4; continue; }   // (square to its run)
      if (!stone) softEdges(g, cx - P / 2, cz - P / 2, cx + P / 2, cz + P / 2, 0, pH);
      if (stone && a >= 2) for (const [mx, mz] of [[0, 0], [1, 0], [0, 1], [1, 1]])
        boxAt(g, '#e0d8c6', cx - P / 2 + mx * (P - 0.1), cz - P / 2 + mz * (P - 0.1), cx - P / 2 + mx * (P - 0.1) + 0.1, cz - P / 2 + mz * (P - 0.1) + 0.1, pH, pH + 6 / HPX, 'hull');
    }
    const [a0, a1] = ends, doorH = 16 / HPX * k, dt = 2 / 32; // the door slab: drawWallLink thick 2 each side
    const door = new THREE.Group(), span0 = (alongZ ? a0[1] : a0[0]) + P / 2 + 0.004, span1 = (alongZ ? a1[1] : a1[0]) - P / 2 - 0.004; // a hair short of the pillars: no end face lying on theirs, none inside them (an open site shows their inside)
    const dx0 = alongZ ? a0[0] - dt : span0, dx1 = alongZ ? a0[0] + dt : span1, dz0 = alongZ ? span0 : a0[1] - dt, dz1 = alongZ ? span1 : a0[1] + dt;
    if (dg) { const len = 2 * Math.SQRT2 - P - 0.008, m = boxAt(door, topped('#8b5a2b|stakes', '#a5723a'), -len / 2, -dt, len / 2, dt, 0, doorH, 'hull');
      m.position.x = e.x + 0.5; m.position.z = e.y + 0.5; m.rotation.y = dg === 1 ? Math.PI / 4 : -Math.PI / 4; }
    else { boxAt(door, topped('#8b5a2b|stakes', '#a5723a'), dx0, dz0, dx1, dz1, 0, doorH, 'hull'); softEdges(door, dx0, dz0, dx1, dz1, 0, doorH, alongZ ? 'z' : 'x'); }
    door.userData.keepWhole = true; g.add(door);
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
    if (rec.roof) for (const t of rec.roof) dropVillager(t);
    if (rec.yard) for (const t of rec.yard) dropVillager(t);
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
      const hg = hullGeometry(src, s, m.userData.hullW || HULL, union || m.userData.hullRound ? null : (i, o) => { // characters keep their outline under the feet (the ground draws first and blocks nothing)
        if (wp.fromBufferAttribute(src.attributes.position, i).applyMatrix4(m.matrixWorld).y >= 0.004) return;
        off.copy(o).applyMatrix3(M); // on the ground: no downward growth
        if (off.y < 0) { off.y = 0; o.copy(off.applyMatrix3(Mi)); }
      }, scr);
      if (!hg) continue;
      if (!union && !m.userData.hullRound && groundSpan(src, m.matrixWorld) > HULL_FLOOR_MAX) dropGroundFaces(hg, src, m.matrixWorld);
      const h = new THREE.Mesh(own(hg), hm);
      if (union) h.renderOrder = 1;
      m.add(h);
    }
  }
  // A building's shell has no underside: through an open (damaged) roof it showed as a black floor. Triangles with all
  // three corners on the ground leave the index. Only past HULL_FLOOR_MAX across (a wall, a hall): a small solid part —
  // a post, a leg, a prop — keeps its underside, whose rim is its outline where it stands (without, it thinned away).
  const HULL_FLOOR_MAX = 0.4; let _gb = null;
  const groundSpan = (src, M) => { _gb = _gb || new THREE.Box3(); if (!src.boundingBox) src.computeBoundingBox(); _gb.copy(src.boundingBox).applyMatrix4(M); return Math.max(_gb.max.x - _gb.min.x, _gb.max.z - _gb.min.z); };
  function dropGroundFaces(hg, src, M){
    const P = src.attributes.position, idx = hg.index ? hg.index.array : null, n = idx ? idx.length : P.count, keep = [], v = new THREE.Vector3();
    const low = i => v.fromBufferAttribute(P, i).applyMatrix4(M).y < 0.004;
    for (let t = 0; t < n; t += 3) { const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
      if (!(low(a) && low(b) && low(c))) keep.push(a, b, c); }
    if (keep.length < n) hg.setIndex(keep);
  }
  // The hull of src seen at scale s (its own units; null if too thin to show):
  // every vertex out along its averaged face normal so each face moves HW.
  // ground(i, offset) may trim a vertex's offset in place.
  // screen: the shell stays on the part, its push direction in the normals (screenHull); 'skinned' (a rig): that
  // normal goes through the bone matrix — the part's scale itself, not its inverse-transpose
  function hullGeometry(src, s, HW, ground, screen = false){
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
        const k = 1 / HW, q = screen === 'skinned' ? [1, 1, 1] : [s.x * s.x, s.y * s.y, s.z * s.z]; // (a stretched pole: else its push turns down its length)
        nOut[3 * i] = o.x * q[0] * k; nOut[3 * i + 1] = o.y * q[1] * k; nOut[3 * i + 2] = o.z * q[2] * k; o.set(0, 0, 0); } // (per unit width: the shader normalizes)
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
  // Dark Age thatch (every first-age roof), as a real thatched roof: a deep, soft mass of straw — the eaves rounded into
  // a fat nose drooping below the wall tops, a rounded crown, the gable ends softened — under the owner's ridge roll
  const THATCH = '#d2ac58|thatch';
  // flush: sides where the roof stops at its wall, no overhang — [low across, high across, low end, high end] (along x:
  // the z0 eave, the z1 eave, the x0 gable, the x1 gable): a house hard against another, their roofs meet, not cross.
  // A geometry without its end at coordinate ≤ lo / ≥ hi along `ax` (null: kept) — the source of an outline shell that
  // has no end there: where a roof runs on into the next house's, no black line crosses the join.
  let rodOpen = null;
  function openEnded(geo, ax, lo, hi){
    const g = geo.index ? geo.toNonIndexed() : geo.clone(), P = g.attributes.position, keep = [];
    const at = i => ax === 'x' ? P.getX(i) : ax === 'y' ? P.getY(i) : P.getZ(i);
    for (let t = 0; t < P.count; t += 3) { const a = at(t), b = at(t + 1), c = at(t + 2);
      if ((lo !== null && a <= lo && b <= lo && c <= lo) || (hi !== null && a >= hi && b >= hi && c >= hi)) continue; keep.push(t, t + 1, t + 2); }
    g.setIndex(keep); const out = own(g.toNonIndexed()); g.dispose(); return out;
  }
  // …and an edge-line set without the lines lying in those end planes.
  function openEdges(lines, ax, lo, hi){
    const P = lines.attributes.position, k = ax === 'x' ? 0 : ax === 'y' ? 1 : 2, out = [], e = 1e-3;
    for (let i = 0; i < P.count; i += 2) { const a = P.array[i * 3 + k], b = P.array[i * 3 + 3 + k];
      if ((lo !== null && Math.abs(a - lo) < e && Math.abs(b - lo) < e) || (hi !== null && Math.abs(a - hi) < e && Math.abs(b - hi) < e)) continue;
      for (let j = 0; j < 6; j++) out.push(P.array[i * 3 + j]); }
    const g = own(new THREE.BufferGeometry()); g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3)); return g;
  }
  function thatchRoof(g, tc, box, wallH, rise, alongX, flush = null){
    const [x0, z0, x1, z1] = box, T = 0.085, over = 0.16, end = 0.14, F = flush || [];
    const half = (alongX ? z1 - z0 : x1 - x0) / 2, hw = half + over, eY = wallH - 0.06, rY = wallH + rise + T * 0.6, slope = (rY - eY) / hw;
    // (the shape's + side is the low-across side once turned along x; the slope the same either way, so a flush eave sits higher)
    const lowAcross = alongX ? 1 : -1, hwP = half + (F[lowAcross > 0 ? 0 : 1] ? 0.012 : over), hwN = half + (F[lowAcross > 0 ? 1 : 0] ? 0.012 : over), eP = rY - slope * hwP, eN = rY - slope * hwN;
    const e0 = F[2] ? 0.03 : end, e1 = F[3] ? 0.03 : end, open = F[2] || F[3];
    // the cross-section (s across the ridge, y up): outer surface eave → crown → eave, a rounded nose at each eave,
    // the underside a thickness T below
    const sh = new THREE.Shape(), n = 0.35 * T;
    sh.moveTo(-hwN, eN + n); sh.quadraticCurveTo(-hwN - n * 0.4, eN - n * 0.3, -hwN + n, eN - n * 0.2);    // the − nose, curled under
    sh.lineTo(0, rY - T * 1.7);                                                                             // underside up to the apex
    sh.lineTo(hwP - n, eP - n * 0.2); sh.quadraticCurveTo(hwP + n * 0.4, eP - n * 0.3, hwP, eP + n);       // the + nose
    sh.lineTo(T * 1.1, rY - T * 1.1 * slope * 0.9); sh.quadraticCurveTo(0, rY + T * 0.15, -T * 1.1, rY - T * 1.1 * slope * 0.9);   // the rounded crown
    sh.lineTo(-hwN, eN + n);
    const len = (alongX ? x1 - x0 : z1 - z0) + e0 + e1 - 0.06;
    const geo = own(new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 3, curveSegments: 6 }));
    const hg = open ? openEnded(geo, 'z', F[2] ? 0.001 : null, F[3] ? len - 0.001 : null) : geo;   // (extruded along z: its start is the low end)
    for (const q of open ? [geo, hg] : [geo]) { if (alongX) q.rotateY(Math.PI / 2).translate(x0 - e0 + 0.03, 0, (z0 + z1) / 2); else q.translate((x0 + x1) / 2, 0, z0 - e0 + 0.03); }
    const m = new THREE.Mesh(geo, mat(THATCH)); m.userData.hullGeo = hg; g.add(m);
    const top = rY + T * 0.05;
    const rp = alongX ? pole(g, tc, [x0 - e0, top, (z0 + z1) / 2], [x1 + e1, top, (z0 + z1) / 2], 0.042) : pole(g, tc, [(x0 + x1) / 2, top, z0 - e0], [(x0 + x1) / 2, top, z1 + e1], 0.042);
    if (open) rp.userData.hullGeo = rodOpen || (rodOpen = new THREE.CylinderGeometry(0.5, 0.5, 1, 12, 1, true));   // (the ridge roll runs on too: no ring round its end)
  }
  // A turned thatch roof (the mill's cone: many sides; a camp's hipped pyramid: 4, turned to the walls): the straw
  // bulging out from the apex and curling under at the eave into a fat lip
  function thatchCone(g, cx, cz, r, y0, rise, sides, turn = 0){
    const T = 0.08, pts = [];
    for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(new THREE.Vector2(r * t + Math.sin(Math.PI * t) * 0.035, y0 + rise * (1 - Math.pow(t, 0.85)))); }
    pts.push(new THREE.Vector2(r + T * 0.45, y0 - T * 0.15), new THREE.Vector2(r + T * 0.15, y0 - T * 0.5), new THREE.Vector2(r - T * 0.6, y0 - T * 0.35), new THREE.Vector2(0.001, y0 + rise * 0.35));
    const geo = own(new THREE.LatheGeometry(pts.reverse(), sides).rotateY(turn)); geo.translate(cx, 0, cz); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat(THATCH)); m.userData.hullGeo = geo; g.add(m); return m;
  }
  // A half-timber frame on one wall face (the 2D house draws the same): sill, top plate and corner posts, two studs, and
  // one brace across a bay (brace: its bay, -1 none) from its bottom corner up to the far stud's top
  function timberFrame(g, col, face, box, wallH, brace){
    const B = 0.055, d = 0.016, v = y => y * wallH, on = (u0, u1, y0, y1) => onFace(g, col, face, ...box, u0, u1, v(y0), v(y1), d);   // (no ink: thin strips' edge lines fought the wall)
    on(0, 1, 0, 0.09); on(0, 1, 0.91, 1);                                              // sill, plate
    on(0, B, 0.09, 0.91); on(1 - B, 1, 0.09, 0.91);                                    // corner posts
    for (const t of [0.36, 0.64]) on(t - B / 2, t + B / 2, 0.09, 0.91);               // studs
    if (brace < 0) return;
    // the brace: a beam laid on the face between two (u, y) points
    const [x0, z0, x1, z1] = box, alongZ = face[0] === 'x', sgn = face[1] === '1' ? 1 : -1, at = face === 'x0' ? x0 : face === 'x1' ? x1 : face === 'z0' ? z0 : z1;
    const P = (u, y) => { const a = alongZ ? z0 + (z1 - z0) * u : x0 + (x1 - x0) * u, n = at + sgn * d / 2; return alongZ ? new THREE.Vector3(n, v(y), a) : new THREE.Vector3(a, v(y), n); };
    for (const [ua, ub] of [HOUSE_BRACE[brace]]) {
      const p0 = P(ua, 0.09), p1 = P(ub, 0.91), X3 = p1.clone().sub(p0), L = X3.length(); X3.normalize();
      const Z3 = alongZ ? new THREE.Vector3(sgn, 0, 0) : new THREE.Vector3(0, 0, sgn), Y3 = new THREE.Vector3().crossVectors(Z3, X3);
      const m = new THREE.Mesh(unitBox, faceMats(col)); m.position.copy(p0).add(p1).multiplyScalar(0.5);
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X3, Y3, Z3)); m.scale.set(L, B * 0.85, d); g.add(m);
    }
  }
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
  // What an opening looks into: its inside — the reveal's sides, its floor and its back — the wall's own colour darkened
  // (little light gets in), lit so each surface shades apart; not black.
  const INTERIOR_MATS = new Set(), ROOM_SHADE = 0.5;
  function interiorMat(col){
    const [c, detail] = col.split('|'), n = parseInt(c.slice(1), 16), ch = v => Math.round(v * ROOM_SHADE).toString(16).padStart(2, '0');
    const m = mat('#' + ch(n >> 16) + ch((n >> 8) & 255) + ch(n & 255) + (detail ? '|' + detail : ''));
    INTERIOR_MATS.add(m); return m; }
  // A face's outward normal (Newell's, turned to its `out`).
  function faceNormal(f){
    const pts = f.loop, n = new THREE.Vector3();
    for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; n.x += (a[1] - b[1]) * (a[2] + b[2]); n.y += (a[2] - b[2]) * (a[0] + b[0]); n.z += (a[0] - b[0]) * (a[1] + b[1]); }
    n.normalize(); if (n.dot(V3(f.out)) < 0) n.negate(); return n;
  }
  // A solid's deck: an up-facing face below its top (a walk, a recessed roof) — its height, -Infinity if none.
  function deckOf(faces){
    const top = Math.max(...faces.flatMap(f => f.loop.map(p => p[1])));
    return Math.max(-Infinity, ...faces.filter(f => f.out[1] > 0.5 && f.loop.every(p => p[1] < top - 1e-4)).map(f => f.loop[0][1]));
  }
  // The walls' body, D thick behind their faces — one description for the finished model (a parapet's rim and inner
  // faces: solid's top/back) and a site's or a ruin's slabs (thickGeo). inset: a point's place on the back; where two
  // walls meet at a corner the backs meet on the bisector (mitred: straight in, the two bodies overlapped there).
  // shared: an outline edge two wall faces have (a corner, a storey's seam) is inside the body — no band on it.
  // outward: an outline edge's way out of its face, in the face's plane (from the loop's winding, not its centre: a
  // merlon's far side faced in). slide: the way a site presses a point down — a corner's along its corner edge, which
  // both its walls hold (each pressing along its own lean, a round tower's joints opened); else its face's, sd.
  function wallBody(faces, D){
    const key = (x, z) => Math.round(x * 1e4) + ',' + Math.round(z * 1e4), ek = (a, c) => { const p = key(a[0], a[2]) + ',' + Math.round(a[1] * 1e4), q = key(c[0], c[2]) + ',' + Math.round(c[1] * 1e4); return p < q ? p + '|' + q : q + '|' + p; };
    const cols = new Map(), edges = new Map();
    for (const f of faces) { const n = faceNormal(f); if (Math.abs(n.y) >= 0.5) continue; const nh = new THREE.Vector3(n.x, 0, n.z).normalize();
      f.loop.forEach((p, k) => { const kk = key(p[0], p[2]); let l = cols.get(kk); if (!l) cols.set(kk, l = []); if (!l.some(q => q.dot(nh) > 0.999)) l.push(nh);
        const e = ek(p, f.loop[(k + 1) % f.loop.length]); edges.set(e, (edges.get(e) || 0) + 1); }); }
    const other = (p, nh) => { const l = cols.get(key(p.x, p.z)); return l && l.find(q => q.dot(nh) < 0.999 && 1 + q.dot(nh) > 0.1); };
    const pk = p => key(p[0], p[2]) + ',' + Math.round(p[1] * 1e4), lean = new Map();
    for (const f of faces) f.loop.forEach((a, k) => { const c = f.loop[(k + 1) % f.loop.length], dy = c[1] - a[1];
      if (Math.abs(dy) > 1e-6 && edges.get(ek(a, c)) > 1) { const d = new THREE.Vector3(c[0] - a[0], dy, c[2] - a[2]).divideScalar(dy); lean.set(pk(a), d); lean.set(pk(c), d); } });
    // deckY: a solid's deck (a walk, a recessed roof: an up-facing face below its top) — its walls' backs are seen above
    // it only (below, inside the masonry or under the deck)
    return { deckY: deckOf(faces),
      slide: (p, sd) => lean.get(pk([p.x, p.y, p.z])) || sd,
      inset: (p, nh) => { const o = other(p, nh); return o ? p.clone().addScaledVector(nh.clone().add(o), -D / (1 + nh.dot(o))) : p.clone().addScaledVector(nh, -D); },
      shared: (a, c) => edges.get(ek([a.x, a.y, a.z], [c.x, c.y, c.z])) > 1,
      outward: (contour, k, u, v) => { let A = 0; for (let i = 0; i < contour.length; i++) { const p = contour[i], q = contour[(i + 1) % contour.length]; A += p.x * q.y - q.x * p.y; }
        const a = contour[k], c = contour[(k + 1) % contour.length], ex = c.x - a.x, ey = c.y - a.y, s = A > 0 ? 1 : -1;
        return u.clone().multiplyScalar(s * ey).addScaledVector(v, -s * ex).normalize(); } };
  }
  // wallSpec: { D, top } — the walls are D thick, their top (a rim, a merlon's crown and sides) in that material, each
  // one's back in its lining (f.lining, else its own): the body wallBody makes, so a site or a ruin (thickGeo) is the
  // very same walls.
  function solidGeo(faces, T, nMats, pierce, rims = [], level = false, wallSpec = null){ // level: openings tunnel straight in (a site's slabs: thickGeo)
    const buckets = Array.from({ length: nMats + 1 }, () => []), body = wallSpec && wallBody(faces, wallSpec.D);
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
      if (body && Math.abs(n.y) < 0.5) { // its body: the back (no openings — they end in their reveals) and a band on each free edge but the foot
        const nh = new THREE.Vector3(n.x, 0, n.z).normalize(), In = p => body.inset(p, nh), bk = n.clone().negate();
        // (from the deck up: below it the back is never seen, and its edges, where walk and deck meet, were traced as ink)
        const dv = v.y > 1e-6 ? (body.deckY - o.y) / v.y : -Infinity, bp = [];
        contour.forEach((a, k) => { const c = contour[(k + 1) % contour.length], ia = a.y >= dv, ic = c.y >= dv;
          if (ia) bp.push(a); if (ia !== ic) bp.push(new THREE.Vector2(a.x + (c.x - a.x) * (dv - a.y) / (c.y - a.y), dv)); });
        if (bp.length >= 3) for (const [i0, i1, i2] of THREE.ShapeUtils.triangulateShape(bp, [])) tri(buckets[f.lining ?? f.mat ?? 0], In(to3(bp[i0])), In(to3(bp[i1])), In(to3(bp[i2])), bk);
        for (let k = 0; k < contour.length; k++) { const a = to3(contour[k]), c = to3(contour[(k + 1) % contour.length]), w = body.outward(contour, k, u, v);
          if (w.y < -0.5 || body.shared(a, c)) continue;
          tri(buckets[wallSpec.top], a, c, In(c), w); tri(buckets[wallSpec.top], a, In(c), In(a), w); } }
      for (const h of holes) {
        const nIn = level ? new THREE.Vector3(n.x, 0, n.z).normalize() : n, out3 = h.map(to3), in3 = out3.map(p => p.clone().addScaledVector(nIn, -T)), mid = out3[0].clone().add(out3[2]).multiplyScalar(0.5);
        for (let k = 0; k < 4; k++) for (const r of [out3, in3]) rims.push(r[k], r[(k + 1) % 4]); // the opening's front and back edges
        for (let k = 0; k < 4; k++) {
          const k1 = (k + 1) % 4, want = mid.clone().sub(out3[k].clone().add(out3[k1]).multiplyScalar(0.5));
          tri(buckets[nMats], out3[k], out3[k1], in3[k1], want); tri(buckets[nMats], out3[k], in3[k1], in3[k], want);   // (the reveal: inside, in shade)
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
  // depth: the walls' thickness (a site's cut shows it); top (a material index): the walls are built that thick here too
  // — their top and back drawn from it (wallBody; a wall's back in its f.lining), not as faces of their own; line: the
  // inner edges' ink
  function solid(g, cols, faces, { T = 0.06, thresh, depth = T, top = null, line = ink } = {}){
    cols = [].concat(cols);
    const ws = top == null ? null : { D: depth, top };
    const rims = [], m = new THREE.Mesh(solidGeo(faces, T, cols.length, true, rims, false, ws), cols.map(c => mat(c)).concat(interiorMat(cols[0])));
    const plain = solidGeo(faces, T, cols.length, false, [], false, ws);
    m.add(new THREE.LineSegments(own(new THREE.EdgesGeometry(plain, thresh)), line));
    if (rims.length) { const rl = new THREE.LineSegments(own(new THREE.BufferGeometry().setFromPoints(rims)), line); rl.userData.rims = true; m.add(rl); }
    m.userData.hullGeo = plain; m.userData.T = depth;
    m.userData.slab = jag => thickGeo(faces, depth, cols.length, jag, ws);                    // (a site's walls: real slabs)
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
  // (r, eave1: the ridge's place across, and the far eave's height — a roof flush on one side is not symmetric)
  function roofShell(g, col, x0, z0, x1, z1, eaveTop, ridgeTop, t, alongX = true, r = null, eave1 = eaveTop, open = null){
    const d = alongX ? z1 - z0 : x1 - x0; if (r === null) r = d / 2;
    const sh = new THREE.Shape([[0, eaveTop], [r, ridgeTop], [d, eave1], [d, eave1 - t], [r, ridgeTop - t], [0, eaveTop - t]].map(p => new THREE.Vector2(...p)));
    const geo = own(new THREE.ExtrudeGeometry(sh, { depth: alongX ? x1 - x0 : z1 - z0, bevelEnabled: false }));
    // (open: [its low end, its high end] runs on into the next roof — no outline, no edge line there. Extruded along z
    // from the high end when along x.)
    const depth = alongX ? x1 - x0 : z1 - z0, O = open && (open[0] || open[1]) ? (alongX ? [open[1], open[0]] : open) : null;
    const hg = O ? openEnded(geo, 'z', O[0] ? 0.001 : null, O[1] ? depth - 0.001 : null) : null;
    for (const q of hg ? [geo, hg] : [geo]) if (alongX) q.rotateY(-Math.PI / 2);
    const m = inked(geo, mat(col), alongX ? x1 : x0, 0, z0, 1, 1, 1);
    if (O) { m.userData.hullGeo = hg; const ln = m.children.find(c => c.isLineSegments);
      ln.geometry = alongX ? openEdges(ln.geometry, 'x', O[1] ? -depth : null, O[0] ? 0 : null) : openEdges(ln.geometry, 'z', O[0] ? 0 : null, O[1] ? depth : null); }
    g.add(m);
  }
  // (flush: as thatchRoof's)
  function roofOn(g, col, [x0, z0, x1, z1], wallH, rise, t, alongX, side, end0, end1, flush = null){
    const F = flush || [], half = (alongX ? z1 - z0 : x1 - x0) / 2, slope = rise / half, ridgeTop = wallH + rise + t;
    const s0 = F[0] ? 0.01 : side, s1 = F[1] ? 0.01 : side, e0 = F[2] ? 0.01 : end0, e1 = F[3] ? 0.01 : end1, v0 = wallH + t - slope * s0, v1 = wallH + t - slope * s1;
    if (alongX) roofShell(g, col, x0 - e0, z0 - s0, x1 + e1, z1 + s1, v0, ridgeTop, t, true, s0 + half, v1, [F[2], F[3]]);
    else roofShell(g, col, x0 - s0, z0 - e0, x1 + s1, z1 + e1, v0, ridgeTop, t, false, s0 + half, v1, [F[2], F[3]]);
  }
  // Pyramid (square base side 1 at y=0, apex y=1) scaled over a footprint.
  function pyramid(g, col, x0, z0, x1, z1, y0, rise){
    // (no base: it lies on what carries it — a damaged one's crumbling sides showed it fighting that top)
    if (!pyramidGeo) pyramidGeo = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1, true).rotateY(Math.PI / 4).translate(0, 0.5, 0);
    g.add(inked(pyramidGeo, mat(col), (x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, rise, z1 - z0));
  }
  function round(g, col, cx, cz, r0, r1, y0, y1, seg, inkIt = true, topCol = col){
    const geo = own(new THREE.CylinderGeometry(r1, r0, 1, seg)), ms = [mat(col), mat(topCol), mat(col)];
    const m = inkIt === true ? inked(geo, ms, 0, 0, 0, 1, 1, 1, seg > 8 ? 30 : 20) : new THREE.Mesh(geo, ms);
    if (inkIt === 'hull') m.userData.hullGeo = geo;   // (its silhouette alone: no inner lines)
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
    // (its ink: a thin frame round the triangle, in its mesh — as the flags')
    const T = [[0, 0], [7 / 32, -2 / HPX], [0, -4 / HPX]], cx = 7 / 96, cy = -2 / HPX, O = T.map(([a, b]) => [cx + (a - cx) * 1.3, cy + (b - cy) * 1.3]), pts = [], idx = [];
    for (let i = 0; i < 3; i++) { const j = (i + 1) % 3, b = pts.length / 3; pts.push(T[i][0], T[i][1], 0, T[j][0], T[j][1], 0, O[j][0], O[j][1], 0, O[i][0], O[i][1], 0); idx.push(b, b + 1, b + 2, b, b + 2, b + 3); }
    const t0 = new THREE.BufferGeometry(); t0.setAttribute('position', new THREE.Float32BufferAttribute(T.flatMap(([a, b]) => [a, b, 0]), 3));
    const t = framed(t0, pts, idx, col);
    const pv = new THREE.Group(); pv.name = 'pennant'; pv.position.set(x, y0 + 8 / HPX, z); pv.userData.phase = (x * 3.7 + z * 5.3) % 6.28;
    pv.add(new THREE.Mesh(t, rigPlainMat(THREE.DoubleSide))); g.add(pv);
  }
  // A stone boulder as the map's deposits draw them (initFeatures 'stone'): the same squat spun profile, flat-shaded, in
  // their greys; radius r, height h.
  let _oreGeo = null; const _oreMat = new Map();
  const rock = (g, col, x, z, r, h = r * 1.7) => {
    _oreGeo = _oreGeo || (() => { const q = new THREE.LatheGeometry([[0, 0], [0.95, 0], [1.02, 0.35], [0.82, 0.74], [0.4, 0.98], [0, 1]].map(([a, b]) => new THREE.Vector2(a, b)), 7).toNonIndexed(); q.computeVertexNormals(); return q; })();
    let m0 = _oreMat.get(col); if (!m0) _oreMat.set(col, m0 = new THREE.MeshLambertMaterial({ color: col, flatShading: true }));
    const m = new THREE.Mesh(_oreGeo, m0); m.position.set(x, 0, z); m.scale.set(r, h, r); m.rotation.y = x * 7.1 + z * 3.3;
    m.userData.hullGeo = _oreGeo; m.userData.hullRound = true; g.add(m); return m;   // (hullRound: outlined all round, as the deposits — a wall's outline stops at the ground, a boulder's doesn't)                                 // (an outline, no inner edge lines: as the deposits)
  };
  // A cloth's triangles (P: 9 numbers each, grp: each one's material) as one geometry, sorted into one group per material
  // (a group a triangle made every one a separate part to merge: bakePose)
  // W: each vertex's place on the cloth [u across, t down from its tied edge] (clothMat's shader moves it by them)
  function clothGeo(P, grp, W){
    const out = [], wo = [], groups = [];
    for (const m of [0, 1]) { const start = out.length / 3; grp.forEach((g2, i) => { if (g2 === m) { for (let k = 0; k < 9; k++) out.push(P[i * 9 + k]); for (let k = 0; k < 6; k++) wo.push(W[i * 6 + k]); } }); groups.push([start, out.length / 3 - start, m]); }
    const geo = own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3)); geo.setAttribute('wind', new THREE.Float32BufferAttribute(wo, 2)); geo.computeVertexNormals();
    for (const [a, n, m] of groups) if (n) geo.addGroup(a, n, m);
    return geo;
  }
  // A cloth (canvasAwning, stallTent) made blowable: named 'cloth' (bakeStill leaves it whole), inked, the ink's vertices
  // given their places on the cloth too (the nearest cloth vertex's), with its wind's strength (world units) and phase
  function windCloth(mesh, thresh, amp, ph){
    const geo = mesh.geometry, P = geo.attributes.position, W = geo.attributes.wind, key = (x, y, z) => Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4), at = new Map();
    for (let i = 0; i < P.count; i++) at.set(key(P.getX(i), P.getY(i), P.getZ(i)), i);
    const eg = edgesOf(geo, thresh), EP = eg.attributes.position, ew = new Float32Array(EP.count * 2);
    for (let i = 0; i < EP.count; i++) { const j = at.get(key(EP.getX(i), EP.getY(i), EP.getZ(i))); if (j != null) { ew[2 * i] = W.getX(j); ew[2 * i + 1] = W.getY(j); } }
    eg.setAttribute('wind', new THREE.BufferAttribute(ew, 2));
    for (const g2 of [geo, eg]) { const n = g2.attributes.position.count, k = new Float32Array(n * 2); for (let i = 0; i < n; i++) { k[2 * i] = amp; k[2 * i + 1] = ph; } g2.setAttribute('windK', new THREE.BufferAttribute(k, 2)); }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clothMat) : clothMat(mesh.material);
    mesh.add(new THREE.LineSegments(eg, clothMat(ink))); mesh.name = 'cloth'; return mesh;
  }
  // The wind on the cloths (render-buildings' clothWind, the 2D's: the same swell), in the vertex shader: each vertex
  // lowered by its place on the cloth (wind: u across, t down) at its cloth's strength and phase (windK). Moved on the
  // CPU and re-sent, two Town Center awnings were ~7MB a second of uploads. Viewer-only, on the flags' clock (wind).
  const clothMats = new Map();
  function clothMat(m){
    let c = clothMats.get(m); if (c) return c;
    c = m.clone(); const prev = m.onBeforeCompile, key = m.customProgramCacheKey() + '|cloth', C = TC_CANVAS;
    c.onBeforeCompile = function(sh, r){ prev.call(this, sh, r); sh.uniforms.uWind = wind;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 wind; attribute vec2 windK; uniform float uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.y -= windK.x * ${C.wind.toFixed(4)} * wind.y * wind.y * sin(3.14159265 * wind.x) * sin(uWind * ${C.windRate.toFixed(4)} + windK.y - 1.2 * wind.x);`); };
    c.customProgramCacheKey = () => key;
    clothMats.set(m, c); return c;
  }
  // A Market stall's tent (drawBuilding MARKET's stall, MARKET_TENT): four striped faces from a peak over (cx, cz) down to
  // the eaves of the square ±R at height y0, sagging, folded and draped between the corners, the cloth thick (its
  // underside and an edge band round the eaves). Inked at its hips and edges, not along its folds.
  function stallTent(g, cx, cz, R, y0, tc){
    const T = MARKET_TENT, n = T.n, Hk = 1 / HPX, apex = [cx, y0 + T.rise * Hk, cz], th = T.thick * Hk, M = 6, S = 6, P = [], grp = [];
    const W = [], tri = (a, b, c, m) => { P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); W.push(a[3], a[4], b[3], b[4], c[3], c[4]); grp.push(m); }, lo = p => [p[0], p[1] - th, p[2], p[3], p[4]];
    const C = [[cx - R, cz - R], [cx + R, cz - R], [cx + R, cz + R], [cx - R, cz + R]];
    for (let f = 0; f < 4; f++) { const A = C[f], B = C[(f + 1) % 4];
      const at = (u, t) => { const e = [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u], c = (u * n) % 1;
        return [apex[0] + (e[0] - apex[0]) * t, apex[1] + (y0 - apex[1]) * t - (T.sag * 4 * t * (1 - t) + T.fold * t * (2 - t) * Math.sin(Math.PI * c) + T.drape * 4 * u * (1 - u) * t * t) * Hk, apex[2] + (e[1] - apex[2]) * t, u, t]; };
      for (let i = 0; i < n; i++) for (let q = 0; q < S; q++) { const u0 = (i + q / S) / n, u1 = (i + (q + 1) / S) / n - (q === S - 1 ? 1e-7 : 0), m = i % 2;
        for (let j = 0; j < M; j++) { const t0 = j / M, t1 = (j + 1) / M, a = at(u0, t0), b = at(u1, t0), c = at(u1, t1), d = at(u0, t1);
          tri(a, b, c, m); tri(a, c, d, m); tri(lo(a), lo(c), lo(b), m); tri(lo(a), lo(d), lo(c), m); }
        const e0 = at(u0, 1), e1 = at(u1, 1); tri(e0, e1, lo(e1), m); tri(e0, lo(e1), lo(e0), m); } }   // (the eave's edge band)
    const mesh = new THREE.Mesh(clothGeo(P, grp, W), [mat(tc, true), mat(TC_CANVAS.tan, true)]);
    windCloth(mesh, 25, 0.6 * TC_CANVAS.wind * Hk, cx * 0.07 + cz * 0.03); g.add(mesh); return mesh;   // (the 2D's: 0.6 the awnings' swell)
  }
  // A striped canvas awning: from its keep edge P0–P1 (height h0) down to its eave Q0–Q1 (h1), TC_CANVAS.n stripes (team and
  // tan by turns) running down it, sagging, folded and draped between its corner posts (drawTCAnnexRoof's), TC_CANVAS.thick thick.
  // Inked round its edges only, not along its folds.
  function canvasAwning(g, P0, P1, Q0, Q1, h0, h1, tc, k){
    const C = TC_CANVAS, soft = 0.45, n = C.n, sag = C.sag * soft * k / HPX, fold = C.fold * k / HPX, drape = C.drape * soft * k / HPX, M = 8, P = [], grp = [];
    const L = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], W = [], tri = (a, b, c, m) => { P.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); W.push(a[3], a[4], b[3], b[4], c[3], c[4]); grp.push(m); };
    const th = C.thick * k / HPX, lo = p => [p[0], p[1] - th, p[2], p[3], p[4]];   // (its underside, TC_CANVAS.thick below)
    const at = (u, t) => { const c = (u * n) % 1, p = L(L(P0, P1, u), L(Q0, Q1, u), t);
      return [p[0], h0 + (h1 - h0) * t - sag * 4 * t * (1 - t) - fold * t * (2 - t) * Math.sin(Math.PI * c) - drape * 4 * u * (1 - u) * t * t, p[1], u, t]; };
    // one sheet: each stripe 8 columns across, M rows down the slope (shared corners: no seams)
    const S = 8, ts = Array.from({ length: M + 1 }, (_, j) => j / M);
    for (let i = 0; i < n; i++) for (let q = 0; q < S; q++) { const u0 = (i + q / S) / n, u1 = (i + (q + 1) / S) / n - (q === S - 1 ? 1e-7 : 0);
      for (let j = 0; j + 1 < ts.length; j++) { const a = at(u0, ts[j]), b = at(u1, ts[j]), c = at(u1, ts[j + 1]), d = at(u0, ts[j + 1]); tri(a, d, c, i % 2); tri(a, c, b, i % 2);
        tri(lo(a), lo(c), lo(d), i % 2); tri(lo(a), lo(b), lo(c), i % 2); } }
    // its thickness: an edge band round the three open sides (the eave and both ends; the keep side is against the wall)
    const band = (p, q, m) => { tri(p, q, lo(q), m); tri(p, lo(q), lo(p), m); };
    for (let q = 0; q < n * S; q++) band(at(q / (n * S), 1), at((q + 1) / (n * S), 1), Math.floor(q / S) % 2);
    for (let j = 0; j < M; j++) { band(at(0, ts[j]), at(0, ts[j + 1]), 0); band(at(1 - 1e-7, ts[j]), at(1 - 1e-7, ts[j + 1]), (n - 1) % 2); }
    const mesh = new THREE.Mesh(clothGeo(P, grp, W), [mat(tc, true), mat(TC_CANVAS.tan, true)]);
    windCloth(mesh, 89, TC_CANVAS.wind * k / HPX, P0[0] * 0.05 + P0[1] * 0.11 + Q0[0] * 0.3); g.add(mesh); return mesh;   // (each awning its own phase)
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
  // A building's footprint as one unseen slab: a click on the ground within it is the building (between a farm's rows, in
  // a yard, under an awning), and its selection outline goes round the whole — not round each post, prop or crop row.
  let plateMat = null;
  function footPlate(g, e){ const w = e.w || BLDGS[e.btype].w, h = e.h || BLDGS[e.btype].h;
    for (const [x0, z0, x1, z1] of footParts(e, w, h)) {
      const p = new THREE.Mesh(own(new THREE.BoxGeometry(x1 - x0, 0.006, z1 - z0).translate(e.x + (x0 + x1) / 2, 0.003, e.y + (z0 + z1) / 2)), plateMat || (plateMat = new THREE.MeshBasicMaterial({ visible: false })));
      p.name = 'plate'; g.add(p); } }
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
    // a wooden staff and a gilt finial, hull-outlined (the cloth below gets a thin black frame of its own)
    pole(g, WOOD.post, [x, y0, z], [x, y0 + poleH, z], 0.014 * s).name = 'flagPole';
    const knob = blob(g, GOLD, x, y0 + poleH + 0.024 * s, z, 0.03 * s); knob.name = 'flagPole';
    const L = 17 * s / PX, Hf = 8.5 * s / HPX, NX = 12, NY = 4, geo = own(new THREE.PlaneGeometry(L, Hf, NX, NY).translate(L / 2, -Hf / 2, 0));
    // Its outline: a thin black frame round the cloth's edge, in its plane (no overlap, so no depth fight from either
    // side), in the cloth's own mesh (the colour per vertex): it waves with it
    const m = HULL * 0.3, pts = [], idx = [], strip = (x0, x1, y0, y1, n) => { const b = pts.length / 3;
      for (let a = 0; a <= n; a++) { const xx = x0 + (x1 - x0) * a / n; pts.push(xx, y0, 0, xx, y1, 0); }
      for (let a = 0; a < n; a++) { const q = b + 2 * a; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); } };
    // (as finely cut as the cloth, so it bends with it)
    const side = (x0, x1) => { const b = pts.length / 3; for (let a = 0; a <= NY; a++) { const yy = -Hf * a / NY; pts.push(x0, yy, 0, x1, yy, 0); } for (let a = 0; a < NY; a++) { const q = b + 2 * a; idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2); } };
    strip(-m, L + m, m, 0, NX); strip(-m, L + m, -Hf, -Hf - m, NX); side(-m, 0); side(L, L + m);
    const f = new THREE.Mesh(framed(geo, pts, idx, col), rigPlainMat(THREE.DoubleSide));
    f.geometry.userData.rest = Float32Array.from(f.geometry.attributes.position.array);
    f.position.set(x, y0 + poleH - 0.01, z); f.rotation.y = -3 * Math.PI / 4;
    f.name = 'flag'; f.userData.len = L; f.userData.hgt = Hf; f.userData.s = s; f.userData.phase = (x * 0.37 + z * 0.71) % (2 * Math.PI); g.add(f);   // (each flag its own phase: not all in step)
  }
  // A flat cloth (geo, facing +z) and its black frame (pts, idx) as one geometry, the colour per vertex; geo is freed.
  function framed(geo, pts, idx, col){
    const P = geo.attributes.position, n0 = P.count, n = n0 + pts.length / 3, c = new THREE.Color(col);
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), cols = new Float32Array(n * 3);
    pos.set(P.array); pos.set(pts, n0 * 3);
    for (let i = 0; i < n; i++) { nrm[i * 3 + 2] = 1; if (i < n0) cols.set([c.r, c.g, c.b], i * 3); }
    const I = geo.index ? Array.from(geo.index.array) : Array.from({ length: n0 }, (_, i) => i);
    const out = own(new THREE.BufferGeometry()); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    out.setAttribute('color', new THREE.BufferAttribute(cols, 3)); out.setIndex(I.concat(idx.map(i => i + n0))); geo.dispose();
    return out;
  }


  const ageOf = e => (teamAge && isPlayerTeam(e.team)) ? teamAge[e.team] : 0;

  // A part set in place whole on a construction site (a roof, a cap, an awning), not built up course by course.
  const piece = g => { const p = new THREE.Group(); p.userData.piece = true; g.add(p); return p; };
  // A farm's crop — the standing sheaves and the stubble of the cut ones — as one mesh of its own: a sheaf cut
  // remakes this alone (refreshModel), not the field under it.
  // A farm's crop: every sheaf (stalks, heads) and its stubble, built once; which show is set in place (cropSync) — a
  // harvest stroke rebuilt the whole field, 10-20ms on a phone at every sheaf cut.
  function farmCrop(e){
    const w = e.w || 2, h = e.h || 2, fseed = e.x * 7 + e.y * 13, px = 1 / PX, K = ART_PROTO ? 5 : 3, N = FARM_CROP_ROWS.length * FARM_CROP_COLS;
    const stalks = [], heads = [], stubs = [], xz = [];
    const up = new THREE.Vector3(0, 1, 0);
    FARM_CROP_ROWS.forEach((t, ri) => {
      for (let i = 0; i < FARM_CROP_COLS; i++) {
        const n = ri * FARM_CROP_COLS + i;
        const x = e.x + w * farmSheafU(ri, i) + (((n * 5 + fseed) % 5) - 2) * 0.5 * px, z = e.y + h * t + (((n * 11 + fseed) % 3) - 1) * px;
        xz[n] = [x, z]; stubs.push([x, 0.03, z, 0.018, 0.06, 0.018]);
        const lean = (((n * 13 + fseed) % 5) - 2) * 0.55 * px, H = (6 + (((n * 3 + fseed) % 3) - 1) * 0.7) / HPX;
        for (const k of ART_PROTO ? [-2, -1, 0, 1, 2] : [-1, 0, 1]) { // splayed across the screen: world (1,0,-1)/√2 (prototype: a fuller sheaf)
          const hk = H * (ART_PROTO ? 1.4 : 1) * (k ? (Math.abs(k) > 1 ? 0.66 : 0.82) : 1), s = (k * (ART_PROTO ? 1.8 : 2.5) * px + lean) * Math.SQRT1_2;
          const dir = new THREE.Vector3(s, hk, -s), L = dir.length(), q = new THREE.Quaternion().setFromUnitVectors(up, dir.normalize());
          stalks.push([x + s / 2, hk / 2, z - s / 2, 0.028, L, 0.028, q]);  // the art: 1.4px stalks
          heads.push([x + s + dir.x * 0.035, hk + dir.y * 0.035, z - s + dir.z * 0.035, 0.05, 0.09, 0.05, q]); // 2×4px heads
        }
      }
    });
    // (stalks, plain grain heads — no ink — and stubble, coloured per vertex: in that order, K boxes a sheaf, one stub)
    const sg = boxBatch(stalks, 'rod'), hg = boxBatch(heads, 'ball'), Pr = sg.attributes.position.count / (N * K), Pb = hg.attributes.position.count / (N * K);
    const geo = tintJoin([[sg, '#c9a227'], [hg, '#e8c84a'], [boxBatch(stubs, 'rod'), '#9a7f4a']]);
    geo.userData.crop = { N, K, Pr, Pb, xz, orig: geo.attributes.position.array.slice(), shown: new Array(N).fill(true), stub: new Array(N).fill(true) };
    cropSync(e, geo);
    return geo;
  }
  // Show the sheaves standing now, stubble where they're cut (a hidden box: its vertices pinched to one point); a sheaf
  // just cut falls away from the blade.
  function cropSync(e, geo){
    const C = geo.userData.crop, standing = farmStandingLive(e), prev = farmPrev.get(e.id), live = farmLive.get(e.id), P = geo.attributes.position, A = P.array, O = C.orig;
    farmPrev.set(e.id, standing);
    const put = (v0, n, show) => { const s = v0 * 3, e3 = (v0 + n) * 3; if (show) A.set(O.subarray(s, e3), s); else for (let i = s; i < e3; i += 3) { A[i] = O[s]; A[i + 1] = O[s + 1]; A[i + 2] = O[s + 2]; } };
    let moved = false;
    for (let n = 0; n < C.N; n++) {
      const up = standing[n];
      if (!up && prev && prev[n]) cutSheaf(C.xz[n][0], C.xz[n][1], live && live.away.has(n) ? live.away.get(n) : n * 2.39996);
      if (C.shown[n] !== up) { C.shown[n] = up; moved = true;
        put(n * C.K * C.Pr, C.K * C.Pr, up); put(C.N * C.K * C.Pr + n * C.K * C.Pb, C.K * C.Pb, up); }
      if (C.stub[n] !== !up) { C.stub[n] = !up; moved = true; put(C.N * C.K * (C.Pr + C.Pb) + n * C.Pr, C.Pr, !up); }
    }
    if (moved) P.needsUpdate = true;
  }

  // Which sides of a house stand hard against another house: [z0, z1, x0, x1] (thatchRoof's flush). Viewer-only.
  function houseFlush(e){
    if (e.id < 0) return null;
    const is = (x, y) => { const t = map[y] && map[y][x], o = t && t.occupied != null ? entitiesById.get(t.occupied) : null; return !!(o && o.btype === 'HOUSE' && o.hp > 0); };
    return [is(e.x, e.y - 1), is(e.x, e.y + 1), is(e.x - 1, e.y), is(e.x + 1, e.y)];
  }
  let tcShadeMat = null, shieldGeo = null, stakeTip = null;
  const MODELS = {
    // A flat tilled field (walkable: units stand on the ground, so the bed is
    // paint, not a raised block), a low planting ridge under each crop row, and
    // the art's sheaves — three splayed golden stalks with grain heads — cut
    // to stubble as the field is worked (drawBuilding FARM layout: rows,
    // stagger, jitter, lean and height all from the same per-farm seed).
    FARM(g, e){
      const w = e.w || 2, h = e.h || 2, dead = e.exhausted, fseed = e.x * 7 + e.y * 13, px = 1 / PX;
      // (in the world the soil is the ground's own — groundArt, render-terrain; in the lab, a patch of it)
      if (e.id < 0 || typeof groundArt !== 'function') patch(g, dead ? '#7d6a52|soil' : '#7a5a38|soil', e.x, e.y, e.x + w, e.y + h);
      const ridges = FARM_CROP_ROWS.map(t => [e.x + w / 2, 0.004, e.y + h * t, w - 0.08, 0.008, 0.06]);
      g.add(new THREE.Mesh(boxBatch(ridges), mat(dead ? '#6f5d47' : '#6b4d2e')));
      g.add(new THREE.Mesh(farmCrop(e), wheatMat()));
    },
    // Cottage under a gable (drawGableBlock: W 32, hh 16, wall 16, roof 20). Dark: plank walls under a thick thatch and
    // the owner's ridge roll (every Dark building is thatched: THATCH); Feudal: plaster, half-timbering, the owner's
    // shingles; Castle: whitewash, darker oak. A brick chimney (smoking) from Feudal on. Brace and chimney placed per house (houseLayout, shared
    // with the 2D art).
    HOUSE(g, e){
      const a = ageOf(e), x0 = e.x, z0 = e.y, x1 = e.x + 1, z1 = e.y + 1, box = [x0, z0, x1, z1];
      const wallH = 16 / HPX, roofH = 20 / HPX, tc = teamColor(e.team), L = houseLayout(e);
      const wall = a === 0 ? WOOD.plankL : AGE_WALLS[Math.min(a, 2)].gl, beam = a >= 2 ? '#57432e' : WOOD.beam;
      const thick = 0.035, rise = roofH - thick, f = houseFaces(x0, z0, x1, z1, wallH, rise, true, !e.complete || e.openTop);
      solid(g, wall + (a === 0 ? '|planks' : '|plaster'), Object.values(f));
      if (a > 0) for (const fc of FACES) timberFrame(g, beam, fc, box, wallH, L.braceBay(fc));   // (no door: the house reads cleaner without one)
      // the roof: Dark thatch (thick, deep eaves) under the owner's ridge roll; later the owner's shingles
      const rp = piece(g);
      const flush = houseFlush(e);   // (hard against another house: no overhang on that side)
      if (a === 0) thatchRoof(rp, tc, box, wallH, rise, true, flush);
      else roofOn(rp, tc + '|shingles', box, wallH, rise, thick, true, 0.05, 0.1, 0.13, flush);
      // (drawGableBlock: ridge along x through the middle, 20px up; the roof rests on the gable walls, overhanging 13% past
      // the front (+x) gable, 10% past the back and 5% past the eaves — the overhang and the back slope's end show, as the art)
      if (a >= 1) { // chimney: along the ridge (per house), 30% down the +z slope, 16px proud; a dark flue, smoke from it
        const cx = x0 + L.chimney, cz = z0 + 0.665, top = wallH + 0.67 * roofH + 16 / HPX, ch = piece(g), capT = top + 3 / HPX;
        boxAt(ch, '#9a4a34', cx - 0.08, cz - 0.08, cx + 0.08, cz + 0.08, wallH, top);
        boxAt(ch, '#8d857a', cx - 0.11, cz - 0.11, cx + 0.11, cz + 0.11, top, capT);
        boxAt(ch, '#1c1208', cx - 0.045, cz - 0.045, cx + 0.045, cz + 0.045, capT - 0.004, capT + 0.002, false);
        (g.userData.smoke = g.userData.smoke || []).push([cx, capT + 0.01, cz]);
      }
    },
    // The keep in the back quadrant (drawTC2D, the 2D's): Dark planks, one window a face; Feudal a stone storey under a
    // plaster one framed by two timber rings (the cloths' beam, a top plate); Castle rough stone with lighter corner
    // stones, a team shield a face and merlons all round. A deck recessed behind its rim; striped cloths over the side
    // quadrants on posts, goods along their eaves (authored 3x3, scaled to 4x4).
    TC(g, e){
      const a = ageOf(e), W = e.w || 4, k = W / 3, x = e.x, z = e.y, mid = W / 2, tc = teamColor(e.team);
      const keepH = 74 * k / HPX, hK = (a === 1 ? 40 : 36) * k / HPX, hO = 30 * k / HPX, fas = 3.5 * k / HPX, rimD = 5 * k / HPX;
      const wood = a === 0, kL = wood ? WOOD.plankL + '|planks' : a === 1 ? '#f0e4c6|plaster' : '#c7bea9|rough', kT = shadeHex(tc, 0.85) + '|planks';   // (the roof deck: team-coloured planks)
      const box = [x, z, x + mid, z + mid], rimW = mid * (1 - 38 / 48) / 2 * (a === 1 ? 0.6 : 1);
      // The keep, with a real parapet: walls rimW thick round a deck recessed rimD below their top (the art's inset roof).
      // The rim and the parapet's inner faces are those walls' top and back (solid's top/back): one body, a site's too.
      const F = keepH - rimD, [i0, j0, i1, j1] = [x + rimW, z + rimW, x + mid - rimW, z + mid - rimW];
      const outer = boxFaces(...box, 0, keepH), deck = { ...boxFaces(i0, j0, i1, j1, F, keepH).bottom, out: [0, 1, 0], mat: 1 }, wH = 14 * k / HPX;
      const cren = a >= 2 ? crenelFaces(...box, 0, keepH, [0, 1, 2, 3].flatMap(m => [0, 3].flatMap(n => [[m, n], [n, m]])).map(([mx, mz]) => [x + rimW / 2 + (mid - rimW) * mx / 3, z + rimW / 2 + (mid - rimW) * mz / 3]).filter((p, i, A) => A.findIndex(q => q[0] === p[0] && q[1] === p[1]) === i), rimW, 7 * k / HPX) : null;   // (Castle: the walls rise into the merlons, corners too: one piece)
      if (cren) for (const f of FACES) { outer[f] = cren[f]; outer[f].lining = 2; }   // (its parapet and merlons dressed inside, as their crowns)
      const corners = cren ? 3 : null;   // (Castle: the corner columns, one merlon wide, in a lighter stone: strips of the walls — see below)
      if (!wood) { for (const f of FACES) for (const u of a >= 2 ? [0.24, 0.76] : [0.34, 0.66]) outer[f].holes.push(hole(f, box, u, keepH * (a === 1 ? 0.75 : 0.68) - wH / 2, 6 * k / 32, wH)); }   // (two windows a face; Dark one)
      else for (const f of FACES) outer[f].holes.push(hole(f, box, 0.5, keepH * 0.7 - wH / 2, 8 * k / 32, wH));
      // Under the decks the keep's two front walls are in their shade (as the 2D): a dark sheet a hair off each, from the
      // ground to where the decks meet them. (Whole and standing only: a site or a ruin has no decks to shade it.)
      if (e.complete && !e.openTop) { const dH = hK - fas * 0.5, sm = tcShadeMat || (tcShadeMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: SHADOW, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
        const px = new THREE.Mesh(own(new THREE.PlaneGeometry(mid, dH).rotateY(Math.PI / 2)), sm); px.position.set(x + mid + 0.004, dH / 2, z + mid / 2); g.add(px);
        const pz = new THREE.Mesh(own(new THREE.PlaneGeometry(mid, dH)), sm); pz.position.set(x + mid / 2, dH / 2, z + mid + 0.004); g.add(pz); }
      const kR = wood ? kL : a === 1 ? '#7a5a40|planks' : '#cdc4b0';   // (Feudal a plank rim round the deck; Castle the merlons and rim plain stone)
      if (a === 1) {   // Feudal: the walls one piece, stone up to the cloths, plaster above (no box inside)
        const sY = hK - 0.02, lo = boxFaces(...box, 0, sY), up = boxFaces(...box, sY, keepH - 6 * k / HPX);   // (up to the top plate's foot: the plate is the top)
        for (const f of FACES) { up[f].holes = outer[f].holes; up[f].cut = true; up[f].lining = 2; lo[f].mat = 3; }   // (plaster: cut, never pressed onto the stone; lined with the rim's planks)
        solid(g, [kL, kT, kR, '#cfc6b3|rough'], [...FACES.map(f => lo[f]), ...FACES.map(f => up[f]), outer.bottom, deck], { T: 0.08, depth: rimW, top: 2 }); }
      else { const walls = FACES.flatMap(f => corners == null ? [outer[f]] : stripFace(outer[f], f[0] === 'z' ? [x + rimW, x + mid - rimW] : [z + rimW, z + mid - rimW], [corners, null, corners]));
        solid(g, [kL, kT, kR, '#e4ddcc|stone'], [...walls, outer.bottom, deck], { T: 0.08, depth: rimW, top: 2 }); }   // (a crenelled one: its merlons' crowns, sides and backs the same top and back)
      const nAcc = g.children.length;   // (the parts laid over the keep's walls from here: siteCut)
      // a ring beam round the keep (its faces o thick: top and back the ring's; the underside, seen from below, its own) — a
      // piece, as the cloths: a site sets it in place whole once the walls reach it (a ruin's comes down with them)
      // (topCol: its top and inside in another wood; inner: how far in past the keep's face it reaches)
      const ringBeam = (col, y0, y1, o, topCol = null, inner = 0) => { const O = boxFaces(x - o, z - o, x + mid + o, z + mid + o, y0, y1); if (topCol) for (const f of FACES) O[f].lining = 1;
        const under = [[[x - o, y0, z - o], [x + mid + o, y0, z - o], [x + mid, y0, z], [x, y0, z]], [[x + mid + o, y0, z - o], [x + mid + o, y0, z + mid + o], [x + mid, y0, z + mid], [x + mid, y0, z]],
          [[x + mid + o, y0, z + mid + o], [x - o, y0, z + mid + o], [x, y0, z + mid], [x + mid, y0, z + mid]], [[x - o, y0, z + mid + o], [x - o, y0, z - o], [x, y0, z], [x, y0, z + mid]]];
        solid(piece(g), topCol ? [col, topCol] : col, [...FACES.map(f => O[f]), ...under.map(loop => ({ loop, out: [0, -1, 0] }))], { depth: o + inner, top: topCol ? 1 : 0 }); };
      const beamH = 6 * k / HPX, beamO = 0.1;   // (the ring the cloths hang from: below)
      if (a === 1) ringBeam('#5e4330', keepH - beamH, keepH, beamO, '#7a5a40|planks', rimW);   // Feudal: a plate round the plaster storey's top — one wooden ring, the rim and parapet round the deck
      if (a >= 2) {   // Castle: a team shield between the windows
        // a shield: the team's colour, a gold quarter — a piece (hung, not built): a site hangs it whole once the wall is up
        const sh = (cx, cz, alongX, o) => { const w = 8 * k / HPX, h = 10 * k / HPX, y0 = keepH * 0.66 - h / 2, sp = piece(g);
          const B = (u0, u1, y0b, y1b, col, d0, d1) => alongX ? boxAt(sp, col, cx + u0, Math.min(cz + d0, cz + d1), cx + u1, Math.max(cz + d0, cz + d1), y0b, y1b, false) : boxAt(sp, col, Math.min(cx + d0, cx + d1), cz + u0, Math.max(cx + d0, cx + d1), cz + u1, y0b, y1b, false);
          B(-w / 2, w / 2, y0, y0 + h, tc, 0, o); B(0.001, w / 2 - 0.001, y0 + h / 2, y0 + h - 0.001, '#e6c34a', o, o * 1.8); B(-w / 2 + 0.001, -0.001, y0 + 0.001, y0 + h / 2, '#e6c34a', o, o * 1.8); };   // (the gold quarters: plates on its face, a hair inside its edges)
        // (one shield a face, centred between the two windows)
        sh(x + mid / 2, z + mid, true, 0.03); sh(x + mid / 2, z, true, -0.03); sh(x + mid, z + mid / 2, false, 0.03); sh(x, z + mid / 2, false, -0.03);   // (offsets that hold at any zoom)
      }
      // The awnings: striped canvas from the keep edge (hK) down to the outer eave (hO), a scallop per stripe hanging there
      // (the 2D's drawTCAnnexRoof, TC_CANVAS)
      const cOut = a >= 1 ? 0.1 : 0;   // (the cloths hang from under the beam round the keep: from its outer face)
      canvasAwning(piece(g), [x + mid + cOut, z], [x + mid + cOut, z + mid], [x + W, z], [x + W, z + mid], hK, hO, tc, k);
      canvasAwning(piece(g), [x, z + mid + cOut], [x + mid, z + mid + cOut], [x, z + W], [x + mid, z + W], hK, hO, tc, k);
      if (a >= 1) ringBeam(a === 1 ? '#5e4330' : '#d8d0bd|stone', hK, hK + beamH, beamO);   // the beam each cloth hangs from (Feudal a timber, Castle a stone ledge): one ring
      for (let i = nAcc; i < g.children.length; i++) if (!g.children[i].userData.piece) g.children[i].traverse(o => { if (o.isMesh) o.userData.siteCut = true; });
      // Posts under the outer corners, up to the cloth where it stands: its sag down the slope, its fold across it
      const run = W - mid - cOut, under = (d, a) => { const t = (d - cOut) / run, u = a / mid, c = (u * TC_CANVAS.n) % 1; const soft = 0.45; return hK + (hO - hK) * t - (TC_CANVAS.sag * soft * 4 * t * (1 - t) + TC_CANVAS.fold * t * (2 - t) * Math.sin(Math.PI * c) + TC_CANVAS.drape * soft * 4 * u * (1 - u) * t * t) * k / HPX - TC_CANVAS.thick * 0.6 * k / HPX; };   // (its top up inside the cloth, short of where its outline would show through)
      // (just in from the canvas's eave corners, tucked into the cloth; outlined, no ink ring round their tops — inside the
      // cloth it showed through)
      const pi = 0.09;
      {   // a post under each eave corner (the cloth's frame taken to run just under the cloth)
        const ps = 0.045, P = (px, pz, h) => pole(g, '#5e4632', [px, 0, pz], [px, h, pz], ps, 'rod');
        if (a >= 2) for (const [px, pz] of [[x + W - pi, z + pi], [x + W - pi, z + mid - pi], [x + pi, z + W - pi], [x + mid - pi, z + W - pi]]) boxAt(g, '#d6cdbb|rough', px - 0.08, pz - 0.08, px + 0.08, pz + 0.08, 0, 0.16, 'hull');   // (stone plinths, Castle)
        for (const [px, pz] of [[x + W - pi, z + pi], [x + W - pi, z + mid - pi]]) P(px, pz, under(px - x - mid, pz - z));   // (each up into the cloth where it stands)
        for (const [px, pz] of [[x + pi, z + W - pi], [x + mid - pi, z + W - pi]]) P(px, pz, under(pz - z - mid, px - x));
        // goods under the cloth, a few and plain (no outlines): barrels and a sack; a woodpile (Dark) or crates (later); an anvil (Feudal on)
        const barrel = (cx, cz) => round(g, '#a9804e', cx, cz, 0.13, 0.13, 0, 0.31, 10, 'hull');
        const sack = (cx, cz, col) => round(g, col, cx, cz, 0.14, 0.075, 0, 0.24, 9, 'hull');
        const crate = (cx, cz, h = 0.27) => boxAt(g, '#c9a26e', cx - h / 2, cz - h / 2, cx + h / 2, cz + h / 2, 0, h, 'hull');
        // lined along each awning's outer eave, between its posts (the ground under the cloth stays free to walk)
        const L = mid - 2 * pi - 0.5, A = t => [x + W - 0.32, z + pi + 0.25 + L * t], B = t => [x + pi + 0.25 + L * t, z + W - 0.32];
        barrel(...A(0)); barrel(...A(0.3)); sack(...A(0.62), '#e3d3a8');
        if (a >= 1) { const [ax2, az2] = A(1); round(g, '#7a5a3a', ax2, az2, 0.09, 0.09, 0, 0.14, 10, 'hull'); boxAt(g, '#4d5257', ax2 - 0.05, az2 - 0.11, ax2 + 0.05, az2 + 0.11, 0.14, 0.21, 'hull'); }
        else barrel(...A(1));
        if (a === 0) { const [cx, cz] = B(0.2); for (const [dy, dz] of [[0.06, -0.1], [0.06, 0.01], [0.06, 0.12], [0.15, -0.045], [0.15, 0.065]]) pole(g, '#9c7046', [cx - 0.24, dy, cz + dz], [cx + 0.24, dy, cz + dz], 0.055, 'rod'); }   // (the woodpile along the eave)
        else { crate(...B(0)); crate(...B(0.3), 0.22); }
        sack(...B(0.65), '#c9a46a'); sack(...B(1), '#e3d3a8');
      }
      // the keep floor the garrisoned villagers stand on (roofArchers: where, render-units' roofCrew)
      g.userData.roof = ROOF_REST.map(() => ({ y: F }));
      // The pole stands on the keep floor, its flag 42px up (28px above the rim at Castle) (×k).
      if (e.complete) flag(g, x + mid / 2, z + mid / 2, F, a >= 2 ? keepH + 28 * k / HPX - F : 42 * k / HPX, tc, k);
    },
    // The hall along the back (windows facing the yard) and a drill yard with straw dummies;
    // from Feudal a spear rack, a target, hay and a horse. Per age as the 2D (BARRACKS_ART): Dark planks under thatch in
    // a stake stockade; Feudal plaster, half-timber and shields; Castle a stone ground storey (drawBuilding
    // BARRACKS, authored 2x2 ×1.5). Yard props are thin: hull outline, no ink.
    BARRACKS(g, e){
      const x = e.x, z = e.y, W = e.w || 3, s = W / 2, tc = teamColor(e.team), a = ageOf(e);
      // BP(a, b): the art's compound grid (b across the hall → +x, a along it → -z).
      const BP = (A, B) => ({ x: x + s + (0.406 + B / 32 - 1) * s, z: z + s + (1.031 - A / 32 - 1) * s });
      const h0 = BP(30, -13), h1 = BP(-30, 13), wallH = 24 * s / HPX, roofH = 12 * s / HPX, BA = BARRACKS_ART, k = s / 32;
      const wall = a === 0 ? WOOD.plankL + '|planks' : AGE_WALLS[Math.min(a, 2)].gl + '|plaster', hall = [h0.x, h0.z, h1.x, h1.z];
      const f = houseFaces(...hall, wallH, roofH, false, !e.complete || e.openTop);
      // (u on the yard wall x1 runs a = 30 → -30)
      const uA = A => (30 - A) / 60;
      for (const A of BA.windows) f.x1.holes.push(hole('x1', hall, uA(A), BA.winV[0] * wallH, BA.winW * k, BA.winV[1] * wallH));
      solid(g, wall, Object.values(f));
      if (a >= 1) { // half-timbering (the 2D's): sill (Feudal), the storey rail, plate, corner posts, studs on the long walls;
        // at Castle the lower storey is stone, flush: laid on each face to the rail, its ends closing the corners
        const beam = a >= 2 ? '#57432e' : WOOD.beam, d = 0.016, stone = a >= 2, [r0, r1] = BA.railV, lo = stone ? r1 : 0.09;
        for (const fc of FACES) { const long = fc[0] === 'x', n = long ? 60 : 26, B = 1.6 / n;
          const on = (u0, u1, y0, y1, col = beam, dd = d) => onFace(g, col, fc, ...hall, u0, u1, y0 * wallH, y1 * wallH, dd);
          const band = (y0, y1, col, dd, e = 0) => on(-e, 1 + e, y0, y1, col, dd);
          if (stone) band(0, r0, '#ded5c2|stone', 0.012, 0.012 / ((long ? hall[3] - hall[1] : hall[2] - hall[0]) || 1)); else band(0, 0.09);
          band(r0, r1, beam, d); on(0, 1, 0.91, 1);
          on(0, B, stone ? r0 : 0.09, 0.91); on(1 - B, 1, stone ? r0 : 0.09, 0.91);
          if (long) for (const A of BA.studs) on(uA(A) - B / 2, uA(A) + B / 2, lo, 0.91); }
      }
      if (a >= 1 && e.complete) {
        // heater shields on the yard wall's studs (on the stone at Castle), in team colour; hung, as the yard's gear, once finished
        if (!shieldGeo) { const sh = new THREE.Shape(BARRACKS_SHIELD.map(([u, w]) => new THREE.Vector2(u, w)));
          shieldGeo = new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false }).rotateY(Math.PI / 2); }
        // (outlined with ink on its own edges: a shell round a plate this close to the wall loses to the wall)
        for (const A of BA.shields) { const u = uA(A);
          const m = inked(shieldGeo, mat(tc), hall[2] + 0.018, BA.shieldV * wallH, hall[1] + (hall[3] - hall[1]) * u, 0.014, BA.shieldR * s / HPX, BA.shieldR * k, 30);
          m.userData.hullGeo = null; g.add(m); }
      }
      if (a === 0) thatchRoof(piece(g), tc, hall, wallH, roofH, false); else roofOn(piece(g), tc + '|shingles', hall, wallH, roofH, 0.04, false, 0.06, 0.05, 0.05);
      const y0 = BP(30, 13), y1 = BP(-30, 51);
      if (e.id < 0) patch(g, '#bfa38a|soil', y0.x, y0.z, y1.x, y1.z);                      // the yard (in the world: the ground's own worn earth — groundArt)
      const fh = 9 * s / HPX, posts = [[-30, 13], [-30, 26], [-30, 38.5], [-30, 51], [-15, 51], [0, 51], [15, 51], [30, 51], [30, 13], [30, 26], [30, 38.5]];
      // The fence stops a hand's width short of the hall (or its stone), so both keep their outlines.
      const gap = 0.035 + 0.05, backX = BP(0, 13).x + gap;
      const nearZ = BP(-30, 0).z, farZ = BP(30, 0).z, frontX = BP(0, 51).x;
      if (a === 0) { // the Dark stockade: sharpened stakes, one lashing rail behind them
        const sH = BA.stakeH * s / HPX, tip = 2.2 * s / HPX, r = 0.03, ry = BA.stakeRail * s / HPX;
        if (!stakeTip) stakeTip = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0);
        for (const [A, B] of BA.stakes) { const p = BP(A, B), px = B === 13 ? backX : p.x;
          post(g, px, p.z, sH - tip, WOOD.post, r);
          const tm = new THREE.Mesh(stakeTip, mat(WOOD.post)); tm.position.set(px, sH - tip, p.z); tm.scale.set(r, tip, r); tm.userData.hullGeo = stakeTip; g.add(tm); }   // (a plain point: the outline only, no edge ink)
        const back = r + 0.012;
        pole(g, WOOD.post, [backX, ry, nearZ - back], [frontX, ry, nearZ - back], 0.016);
        pole(g, WOOD.post, [frontX - back, ry, farZ], [frontX - back, ry, nearZ], 0.016);
        pole(g, WOOD.post, [backX, ry, farZ - back], [frontX, ry, farZ - back], 0.016);
      } else {
        for (const [A, B] of posts) { const p = BP(A, B); post(g, B === 13 ? backX : p.x, p.z, fh, WOOD.post, 0.035); }
        // Two rails along the near end (a=-30), the front (b=51) and the far end (a=+30).
        for (const hy of [3.5 * s / HPX, 7 * s / HPX]) { // rails at 3.5px and 7px
          pole(g, WOOD.post, [backX, hy, nearZ], [frontX, hy, nearZ], 0.018);
          pole(g, WOOD.post, [frontX, hy, farZ], [frontX, hy, nearZ], 0.018);
          pole(g, WOOD.post, [backX, hy, farZ], [frontX, hy, farZ], 0.018);
        }
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
      // Feudal on: a two-storey timber shed, its gable to the view — a loft door high in it, a hoist beam out over it with a
      // log on its rope; sawn planks stacked beside it (Castle: on a stone plinth). drawBuilding LCAMP draws the same.
      if (ageOf(e) >= 1) {
        const a = ageOf(e), x = e.x, z = e.y, b0 = a >= 2 ? 0.12 : 0, box = [x + 0.36, z + 0.1, x + 0.94, z + 0.6], wallH = 0.58, rise = 0.28, ov = 0.08;
        if (a >= 2) boxAt(g, '#bdb5a3|stone', box[0] - 0.02, box[1] - 0.02, box[2] + 0.02, box[3] + 0.02, 0, b0);
        const f = houseFaces(...box, wallH, rise, false, !e.complete || e.openTop);
        f.z1.holes.push(hole('z1', box, 0.5, 0.42, 0.12, 0.14)); f.x1.holes.push(hole('x1', box, 0.5, 0.26, 0.09, 0.09));
        for (const fc of Object.values(f)) { fc.loop = fc.loop.map(([px, py, pz]) => [px, py + b0, pz]); for (const h of fc.holes || []) h.at = [h.at[0], h.at[1] + b0, h.at[2]]; }
        solid(g, '#b89868|planks', Object.values(f));
        roofOn(piece(g), teamColor(e.team) + '|shingles', box, b0 + wallH, rise, 0.035, false, 0.05, ov, ov);   // (as much over the back as the front)
        if (!e.complete) return;
        const cx = (box[0] + box[2]) / 2, top = b0 + wallH + rise - 0.05, bz = box[3] + 0.17, lr = 0.07;
        pole(g, '#6e5138', [cx, top, box[3] - 0.05], [cx, top, bz], 0.02);                                         // the hoist beam
        // the load: a log hauled up to the loft and let down again on its rope (animateModels: rope scaled to its length,
        // the log at its end). Viewer-only.
        const hoist = new THREE.Group(); hoist.name = 'hoist'; hoist.position.set(cx, top - 0.02, bz - 0.02); g.add(hoist);
        hoist.userData = { lo: top - 0.02 - (b0 + lr + 0.02), hi: 0.12, phase: (x * 3.1 + z * 1.7) % 1 };
        const rope = new THREE.Group(); rope.name = 'hoistRope'; hoist.add(rope); pole(rope, '#3a3027', [0, 0, 0], [0, -1, 0], 0.005);
        const load = new THREE.Group(); load.name = 'hoistLog'; hoist.add(load); log(load, TREE_BARK, 0, 0, 0.4, lr, true, 0, TREE_CUT);
        for (let j = 0; j < 4; j++) boxAt(g, j % 2 ? '#c8a476' : '#d6b588', x + 0.06, z + 0.1, x + 0.28, z + 0.56, j * 0.035, (j + 1) * 0.035);   // sawn planks
      }
      const hut = ageOf(e) >= 1 ? null : campHut(g, e, '#b89868|planks', '#8a6a48|shingles');
      if (!e.complete) return;
      // Everything inside the tile, in front of the hut (z > 0.625), the pile lower than its walls. (Feudal on: no pile — the
      // hoisted log is the camp's wood)
      const rr = 0.075, lz = e.y + 0.81;
      if (ageOf(e) === 0) { for (const dz of [-rr, rr]) log(g, TREE_BARK, e.x + 0.29, lz + dz, 0.5, rr, true, rr, TREE_CUT);
        log(g, TREE_BARK, e.x + 0.29, lz, 0.5, rr, true, rr * (1 + Math.sqrt(3)), TREE_CUT); } // resting in the two's groove
      const st = ageOf(e) === 0 ? [0.8, 0.82] : [0.22, 0.8];   // (Feudal on: clear of the hoisted log's run)
      round(g, TREE_BARK, e.x + st[0], e.y + st[1], 0.1, 0.1, 0, 9 / HPX, 12, true, TREE_CUT); // stump with a pale cut top
      return hut;
    },
    // Dark Age: the hut in dark timber. Later a shaft house: an open shed on four posts round a fire pit, the hipped
    // roof closing in a collar under a head-frame whose wheel winds a bucket up out of the pit and back.
    // In front, heaps of gold and quarried stone (drawBuilding MCAMP).
    MCAMP(g, e){
      if (ageOf(e) === 0) campHut(g, e, '#7a6a55|planks', '#55483a|shingles');   // (the 2D art's dark timber mine shed)
      else shaftHouse(g, e);
      if (!e.complete) return;
      for (const [dx, dz, r, y, col] of [[0.24, 0.78, 0.06, 0, '#d1a017'], [0.34, 0.72, 0.055, 0, '#c99815'], [0.3, 0.88, 0.065, 0, '#e8b90f'], [0.4, 0.84, 0.05, 0, '#d1a017'], [0.32, 0.8, 0.05, 0.07, '#e8b90f']])
        rock(g, col, e.x + dx, e.y + dz, r, r * 1.4).position.y = y;                                             // the gold heap (drawBuilding MCAMP's)
      if (ageOf(e) === 0) { for (const [x, z, r, col] of [[0.8, 0.8, 0.15, '#9d9d9d'], [0.6, 0.96, 0.07, '#8c8c8c']]) rock(g, col, e.x + x, e.y + z, r); return; }
      for (const [dx, dz, r, y] of [[0.8, 0.8, 0.07, 0], [0.9, 0.76, 0.055, 0], [0.84, 0.9, 0.06, 0], [0.73, 0.88, 0.045, 0], [0.85, 0.82, 0.05, 0.07]])
        rock(g, '#9d9d9d', e.x + dx, e.y + dz, r, r * 1.4).position.y = y;                                       // the stone heap
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
      // the cap: Dark thatch (a fat, low-hanging straw cone), later shingles; corners over the octagon's
      if (a === 0) thatchCone(piece(g), c.x, c.y, r1 + 0.1, H - 0.06, 28 / HPX, 12);
      else { const cap = own(new THREE.ConeGeometry(r1 + 0.03, 22 / HPX, 16).rotateY(Math.PI / 8).translate(0, 11 / HPX, 0));
        piece(g).add(inked(cap, mat(WOOD.L + '|shingles'), c.x, H, c.y, 1, 1, 1, 30)); }
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
    // Paved plaza; on three corner tiles a stall — a little striped tent on four posts (stallTent) — over its goods (grain sacks, gold, stone); a crate and a log
    // on the front tile (drawBuilding MARKET, drawMarketPlaza).
    MARKET(g, e){
      const x = e.x, z = e.y, W = e.w || 3, tc = teamColor(e.team), H = 20 / HPX;
      patch(g, '#b7b2a6|slabs', x, z, x + W, z + W);
      const r = 21 / 32 / 2, gd = new THREE.Group(); gd.name = 'goods'; g.add(gd); // (the goods: gone with the awnings when it's damaged)
      for (const [tx, tz, good] of [[0, 0, 'sacks'], [0, W - 1, 'gold'], [W - 1, 0, 'stone']]) {
        const cx = x + tx + 0.5, cz = z + tz + 0.5;
        // its posts up into the tent's thick cloth (outlined, no ink ring round their tops: the TC's), the tent over them
        for (const [px, pz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) pole(g, WOOD.post, [cx + px, 0, cz + pz], [cx + px, H - MARKET_TENT.thick * 0.9 / HPX, cz + pz], 0.028, 'rod');
        stallTent(piece(g), cx, cz, r + 0.045, H, tc);   // (its corners clear of the posts: they stand wholly under it)
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
  // A vertical face cut along its run into strips at the given cuts (world coordinate along it: x for a z-face, z for an
  // x-face): each strip its own face, in the material mats[i] (null: the face's own), its openings with it. Strips of one
  // face share their seams exactly, so a solid keeps them one body (wallBody: a seam is inside it, no band).
  function stripFace(f, cuts, mats){
    const ax = Math.abs(f.out[0]) > 0.5 ? 2 : 0, clip = (poly, c, keepBelow) => { const out = [];
      for (let k = 0; k < poly.length; k++) { const p = poly[k], q = poly[(k + 1) % poly.length], ip = keepBelow ? p[ax] <= c : p[ax] >= c, iq = keepBelow ? q[ax] <= c : q[ax] >= c;
        if (ip) out.push(p);
        if (ip !== iq) { const t = (c - p[ax]) / (q[ax] - p[ax]), r = p.map((v, i) => v + (q[i] - v) * t); r[ax] = c; out.push(r); } }
      return out; };
    const edges = [-Infinity, ...cuts, Infinity];
    return edges.slice(0, -1).map((lo, i) => { let poly = f.loop; if (lo > -Infinity) poly = clip(poly, lo, false); if (edges[i + 1] < Infinity) poly = clip(poly, edges[i + 1], true);
      const holes = (f.holes || []).filter(h => h.at[ax] > lo && h.at[ax] < edges[i + 1]);
      return { ...f, loop: poly, holes, mat: mats[i] ?? f.mat }; }).filter(g => g.loop.length >= 3);
  }
  // A crenellated block's walls (one solid: no joint where a merlon meets its wall): each face rises into the merlons
  // standing flush on it. Built mW thick (solid's depth/top), their top is the walk and the merlons' crowns, sides and
  // backs. spots: merlon centres (world x, z) flush with the edges (castleMerlonSpots); mW across, mH tall. Returns the
  // named faces (holes go on .x0/.x1/.z0/.z1), the bottom, and the deck: the walk's middle, inside walls mW thick, its
  // outline through every corner of their top's inner edge (a straight edge past them was traced as ink across the walk).
  function crenelFaces(X0, Z0, X1, Z1, y0, y1, spots, mW, mH){
    const w = mW / 2, H = y1 + mH, e = 1e-6, foot = spots.map(([u, v]) => [u - w, v - w, u + w, v + w]);
    const along = (sel, a0, a1) => foot.filter(sel).map(f => [f[a0], f[a1]]).sort((p, q) => p[0] - q[0]);
    const iv = { z0: along(f => f[1] <= Z0 + e, 0, 2), z1: along(f => f[3] >= Z1 - e, 0, 2), x0: along(f => f[0] <= X0 + e, 1, 3), x1: along(f => f[2] >= X1 - e, 1, 3) };
    const prof = (I, A0, A1) => { const pts = [[A0, I.length && I[0][0] <= A0 + e ? H : y1]];   // the top line, A0 → A1: up over each merlon
      for (const [a, b] of I) { if (a > A0 + e) pts.push([a, y1], [a, H]); pts.push([b, H]); if (b < A1 - e) pts.push([b, y1]); }
      if (pts[pts.length - 1][0] < A1 - e) pts.push([A1, y1]); return pts; };
    const side = (n, A0, A1, P, out) => ({ loop: [P(A0, y0), P(A1, y0), ...prof(iv[n], A0, A1).reverse().map(([a, y]) => P(a, y))], out, holes: [] });
    const F = { z0: side('z0', X0, X1, (a, y) => [a, y, Z0], [0, 0, -1]), z1: side('z1', X0, X1, (a, y) => [a, y, Z1], [0, 0, 1]),
      x0: side('x0', Z0, Z1, (a, y) => [X0, y, a], [-1, 0, 0]), x1: side('x1', Z0, Z1, (a, y) => [X1, y, a], [1, 0, 0]),
      bottom: { loop: [[X0, y0, Z0], [X1, y0, Z0], [X1, y0, Z1], [X0, y0, Z1]], out: [0, -1, 0], holes: [] } };
    const d = mW, ends = (I, lo, hi) => I.flatMap(ab => ab).filter(t => t > lo + e && t < hi - e);   // (merlon edges along a wall, inside its corners)
    if (X1 - X0 > 2 * d + 1e-3 && Z1 - Z0 > 2 * d + 1e-3) {
      const a0 = X0 + d, a1 = X1 - d, b0 = Z0 + d, b1 = Z1 - d;
      F.deck = { loop: [[a0, y1, b0], ...ends(iv.z0, a0, a1).sort((p, q) => p - q).map(t => [t, y1, b0]), [a1, y1, b0], ...ends(iv.x1, b0, b1).sort((p, q) => p - q).map(t => [a1, y1, t]),
        [a1, y1, b1], ...ends(iv.z1, a0, a1).sort((p, q) => q - p).map(t => [t, y1, b1]), [a0, y1, b1], ...ends(iv.x0, b0, b1).sort((p, q) => q - p).map(t => [a0, y1, t])], out: [0, 1, 0], holes: [] };
    }
    return F;
  }
  // The Castle: render-buildings' CASTLE_PARTS as stone solids (the TC keep's masonry) — arrow slits in the towers,
  // windows in the keep, the gate's opening; merlons at castleMerlonSpots; the keep's team spire and flag.
  MODELS.CASTLE = (g, e) => {
    const x = e.x, z = e.y, tc = teamColor(e.team), col = '#ded5c2|stone', mW = CASTLE_MERLON, mH = 7 / HPX;
    for (const q of CASTLE_PARTS.flat()) {
      const box = [x + q.b[0], z + q.b[1], x + q.b[2], z + q.b[3]], y0 = q.y0 / HPX;
      // (a curtain runs a little into the tower or gatehouse at each end: one piece with it, no seam where they meet)
      if (q.kind === 'wall') { const k = q.edge[0] === 'u' ? 1 : 0; box[k] -= 0.05; box[k + 2] += 0.05; }
      if (q.kind === 'roof') { pyramid(piece(g), tc + '|shingles', ...box, y0, q.rise / HPX); continue; }
      const y1 = q.y1 / HPX, cren = q.kind === 'wall' || q.kind === 'crown' || q.kind === 'gate';
      const f = cren ? crenelFaces(...box, y0, y1, castleMerlonSpots(q).map(([u, v]) => [x + u, z + v]), mW, mH) : boxFaces(...box, y0, y1);
      if (q.kind === 'shaft') for (const n of q.out) f[n].holes.push(hole(n, box, 0.5, 20 / HPX, 0.08, 10 / HPX));
      if (q.kind === 'keep') for (const n of FACES) f[n].holes.push(hole(n, box, 0.5, 36 / HPX, 0.16, 11 / HPX));
      if (q.kind === 'gate') for (const n of ['z0', 'z1']) f[n].holes.push(hole(n, box, 0.5, 0, 0.42, 20 / HPX));   // (the passage: in from the field, out into the courtyard)
      if (!cren) { solid(g, col, Object.values(f), { depth: mW / 2 }); continue; }
      solid(g, col, [...FACES.map(n => f[n]), f.bottom, ...(f.deck ? [f.deck] : [])], { depth: mW, top: 0 });   // (walls a merlon thick: their top the walk and the merlons)
    }
    const roof = CASTLE_PARTS.flat().find(q => q.kind === 'roof');
    if (e.complete) flag(g, x + 2, z + 2, (roof.y0 + roof.rise) / HPX, null, tc);
    // the portcullis just inside the gate's mouth, an iron-bound grille that slides up into the stone (animateModels:
    // render-units' castleYard lifts it); the yard's walkers (yardWalkers)
    const pc = new THREE.Group(), ph = 20 / HPX, pz = z + 4 - 0.07, bar = 0.022;
    for (let k = -1.5; k <= 1.5; k++) boxAt(pc, '#3a3129', x + 2 + k * 0.1 - bar / 2, pz - bar / 2, x + 2 + k * 0.1 + bar / 2, pz + bar / 2, 0, ph, false);
    for (let k = 1; k <= 4; k++) boxAt(pc, '#3a3129', x + 2 - 0.2, pz - bar / 2, x + 2 + 0.2, pz + bar / 2, ph * k / 4.4 - bar / 2, ph * k / 4.4 + bar / 2, false);
    pc.name = 'portcullis'; pc.userData.keepWhole = true; g.add(pc);
    if (e.complete) g.userData.yard = Array.from({ length: BLDGS.CASTLE.garrisonCap }, () => ({ y: 0 }));
  };

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
  let fallers = [], glints = [], fallSent = null;   // (fallSent: the fallers list last sent to the GPU with all at rest: none to redo)
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
    // the crowns (and their outlines) mark CROWN_BIT where they're drawn: a building's rim behind them shows there alone
    for (const mtl of [leaf, hullCrown]) Object.assign(mtl, { stencilWrite: true, stencilRef: CROWN_BIT, stencilWriteMask: CROWN_BIT, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
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
    sx.fillStyle = SHADOW_FILL; sx.beginPath(); sx.arc(32, 32, 30, 0, 2 * Math.PI); sx.fill();
    // (one darkening a pixel: where ovals overlap — a forest's, a crowd's — they don't pile up; its own stencil bit, and
    // only where the oval is: alphaTest)
    const stex = new THREE.CanvasTexture(sc), smat = new THREE.MeshBasicMaterial({ map: stex, transparent: true, depthWrite: false, alphaTest: 0.05,
      stencilWrite: true, stencilRef: 4, stencilFuncMask: 4, stencilWriteMask: 4, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp });
    const sgeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    part('shadow', sgeo, smat, null); part('shadowU', sgeo, smat, null); part('shadowF', sgeo, smat, null);   // (F: a felled tree's, laid each frame)
    part('shadowP', sgeo, smat, null);   // (P: a shot's in flight, updateArrows)
    // Arrows (drawProjectiles): a tan 20px shaft behind a steel head, built
    // along +y with the tip at the origin; fletched archer arrows add two
    // crossed team-color vanes at the tail.
    const L = 20 / PX, thin = new THREE.Vector3(1, 1, 1); // (bigger than the 2D art's 14px: thinner reads as nothing at a 3D distance)
    part('shaft', new THREE.CylinderGeometry(0.017, 0.017, L, 6).translate(0, -L / 2, 0), new THREE.MeshLambertMaterial({ color: ARROW_SHAFT }), thin, 0.008);
    part('head', new THREE.ConeGeometry(0.035, 0.1, 6).translate(0, -0.01, 0), new THREE.MeshLambertMaterial({ color: '#dde3ea' }), thin, 0.008);
    const vane = new THREE.BufferGeometry();
    vane.setAttribute('position', new THREE.Float32BufferAttribute([0, -L + 0.11, 0, 0.04, -L + 0.02, 0, 0, -L + 0.02, 0, 0, -L + 0.11, 0, 0, -L + 0.02, 0.04, 0, -L + 0.02, 0,
      0, -L + 0.11, 0, -0.04, -L + 0.02, 0, 0, -L + 0.02, 0, 0, -L + 0.11, 0, 0, -L + 0.02, -0.04, 0, -L + 0.02, 0], 3));
    vane.computeVertexNormals();
    part('vane', vane, new THREE.MeshLambertMaterial({ color: '#ffffff', side: THREE.DoubleSide }), null);
    // the air an arrow parts: a faint streak back from its nock (its matrix: the arrow's)
    part('streak', new THREE.CylinderGeometry(0.006, 0.014, 0.42, 5).translate(0, -L - 0.21, 0), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.32, depthWrite: false }), null);
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
  // (tileHash: render-terrain — the per-tile variety is shared with the 2D)
  // Rebuild every instance list from the map (fog: explored tiles, like the ground) — only the tiles the camera can
  // see, give or take a margin: instanced meshes aren't culled per instance, and the RANGE square around the eye held
  // ~6x more trees than the view (behind and beside the camera), ~45% of a battle frame's triangles. A turn or zoom
  // re-lists at once (viewTurned), so nothing pops in at the edges.
  const _fFr = { fr: null, m: null, s: null }, featView = { pos: null, dir: null, fov: 0 };
  function refreshFeatures(){
    for (const k in feat) feat[k].n = 0;
    fallers = []; glints = [];
    const R = RANGE + 4, cx = Math.floor(eye.x), cy = Math.floor(eye.y);
    if (!_fFr.fr) { _fFr.fr = new THREE.Frustum(); _fFr.m = new THREE.Matrix4(); _fFr.s = new THREE.Sphere(new THREE.Vector3(), 2.5); }
    camera.updateMatrixWorld(); _fFr.fr.setFromProjectionMatrix(_fFr.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    featView.pos = camera.position.clone(); featView.dir = camera.getWorldDirection(new THREE.Vector3()); featView.fov = camera.fov;
    for (let y = Math.max(0, cy - R); y < Math.min(MAP, cy + R); y++) for (let x = Math.max(0, cx - R); x < Math.min(MAP, cx + R); x++) {
      const t = seenTile(x, y);   // (in the fog: as last seen)
      if (!t.res || t.res <= 0 || !(fog[y] && fog[y][x])) continue;
      _fFr.s.center.set(x + 0.5, elevAny ? 0.8 + groundH(x + 0.5, y + 0.5) - camLift : 0.8, y + 0.5); if (!_fFr.fr.intersectsSphere(_fFr.s)) continue; // (radius 2.5: a crown's reach, plus the margin a turn eats before the re-list)
      const wx = x + 0.5, wz = y + 0.5; putTile = y * MAP + x;
      if (t.t === TERRAIN.FOREST) {
        const k = treeSize(x, y); // the art's per-tree size noise (render-terrain)
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
        if (!treeFellTicks.has(key)) treeFellTicks.set(key, fog[y][x] === 2 ? tick : tick - T30(40));   // (first met in the fog already cut: it lies there)
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
    for (const k in feat) { const f = feat[k]; f.mesh.count = f.n; if (f.hull) f.hull.count = f.n; sendInst(f.mesh, f.n); }
  }
  // Has the camera turned, zoomed or slid enough since the last list that the margin might show its edge?
  function viewTurned(){
    if (!featView.dir) return true;
    return camera.getWorldDirection(_fFr.d || (_fFr.d = new THREE.Vector3())).dot(featView.dir) < 0.985   // ~10°
      || camera.position.distanceToSquared(featView.pos) > 2.25 || Math.abs(camera.fov - featView.fov) > 3;
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
  // Short-lived bits (chips, smoke, dust) are one instanced mesh a kind, not a mesh each. Each is plain data (p, s,
  // col, and a rotation or an opacity), written to its instance every frame (bitsDraw).
  function bitsMesh(geo, m, cap, alpha){
    geo = geo.clone(); if (alpha) { geo.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
      m.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float iAlpha; varying float vBitA;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvBitA = iAlpha;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vBitA;').replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vBitA;'); };
      m.customProgramCacheKey = () => 'bits-alpha'; }
    const mesh = new THREE.InstancedMesh(geo, m, cap); mesh.setColorAt(0, new THREE.Color()); mesh.count = 0; mesh.frustumCulled = false; scene.add(mesh);
    return mesh;
  }
  let chipMesh = null, hazeMesh = null, _bitQ = null, _bitE, _bitM, _bitS;   // (three.js loads lazily: made on first use)
  // Send the live part of an instance pool to the GPU: its first n items, nothing when empty. Flagged whole, every pool
  // (FEAT_CAP slots: arrows, felled trees, chips, shadows…) went up every frame — ~2.8MB a frame for a few live ones.
  // (one range, reset each time: a pool not drawn for a while must not pile up ranges)
  function sendFirst(attr, n){ if (!attr || n <= 0) return; attr.clearUpdateRanges(); attr.addUpdateRange(0, n * attr.itemSize); attr.needsUpdate = true; }
  function sendInst(mesh, n){ sendFirst(mesh.instanceMatrix, n); sendFirst(mesh.instanceColor, n); }
  function bitsDraw(mesh, list){
    if (!_bitQ) { _bitQ = new THREE.Quaternion(); _bitE = new THREE.Euler(); _bitM = new THREE.Matrix4(); _bitS = new THREE.Vector3(); }
    const n = Math.min(list.length, mesh.instanceMatrix.count), A = mesh.geometry.attributes.iAlpha;
    for (let i = 0; i < n; i++) { const b = list[i];
      mesh.setMatrixAt(i, _bitM.compose(b.p, b.rx != null ? _bitQ.setFromEuler(_bitE.set(b.rx, 0, b.rz)) : _bitQ.identity(), b.s.isVector3 ? b.s : _bitS.setScalar(b.s)));
      mesh.setColorAt(i, b.col); if (A) A.array[i] = b.a; }
    mesh.count = n; sendInst(mesh, n); sendFirst(A, n);
  }
  const bitCols = new Map(), bitCol = c => { let k = bitCols.get(c); if (!k) bitCols.set(c, k = new THREE.Color(c)); return k; };
  function chipBurst(x, y, z, ang){ // a few wood chips thrown back off the bark, falling and fading
    for (let i = 0; i < 5; i++) {
      const sp = 0.5 + Math.random() * 0.4, a2 = ang + Math.PI + (Math.random() - 0.5) * 1.6;
      chips.push({ p: new THREE.Vector3(x, y, z), s: new THREE.Vector3(0.02, 0.014, 0.026), col: bitCol(i % 2 ? '#d8b98a' : '#b88a52'), rx: 0, rz: 0, v: new THREE.Vector3(Math.cos(a2) * sp, 0.6 + Math.random() * 0.5, Math.sin(a2) * sp), age: 0 });
    }
  }
  function updateChips(dt){
    for (let i = chips.length - 1; i >= 0; i--) {
      const c = chips[i]; c.age += dt; c.v.y -= 3.4 * dt; c.p.addScaledVector(c.v, dt); c.rx += dt * 12; c.rz += dt * 9;
      if (c.p.y < 0.007) { c.p.y = 0.007; c.v.set(0, 0, 0); }
      if (c.age > 1.5) chips.splice(i, 1);
    }
    if (chips.length || chipMesh) bitsDraw(chipMesh = chipMesh || bitsMesh(unitBox, new THREE.MeshLambertMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }), 400), chips);
  }
  // Per frame: the wind clock, falling / fallen trees, twinkling glints.
  function animateFeatures(dt = 0){
    wind.value = aTick;
    updateTreeHits(); updateChips(dt); updateFlyers(dt); updateSheaves(dt);
    // A cut tree pivots on its stump's top toward screen-right, coming to rest where its crown meets the ground.
    // As 2D, it lies mostly on its own square: a little smaller, and slid back off the stump as it goes down so the
    // crown ends near the square's edge rather than across the next tile.
    const T = feat.trunkF, C = feat.crownF, SF = feat.shadowF, FIT = 0.85;
    // (all lying still and the list as last sent: nothing to redo — chopped trees lie for minutes, were rebuilt every frame)
    if (fallers !== fallSent) { let moving = false; SF.n = 0;
    const dir = _e2 = _e2 || new THREE.Vector3(0, 1, 0).applyAxisAngle(FALL_AXIS, -Math.PI / 2); // the way it falls, on the ground
    T.n = C.n = 0;
    for (const f of fallers) {
      const u = Math.min(1, (tick - treeFellTicks.get(f.key)) / T30(40)), sc = f.k * (1 + (FIT - 1) * u); if (!(u >= 1)) moving = true;
      const rest = Math.acos(Math.min(1, Math.max(0, (CROWN_R * sc - STUMP_H * f.k) / (TREE_H * sc))));
      const back = Math.max(0, (TREE_H + CROWN_R) * f.k * FIT - 1.05) * u * u;                  // slides with the fall
      _m.compose(_p.set(f.wx - dir.x * back, STUMP_H * f.k, f.wz - dir.z * back), _q.setFromAxisAngle(FALL_AXIS, -rest * u * u), _s.set(sc, sc, sc)); // accelerating, like a real fall
      T.mesh.setMatrixAt(T.n++, _m); C.mesh.setMatrixAt(C.n++, _m);
      // its shadow, as the 2D's (felledTreeShadow: along the fall, from the stump)
      for (const [a, along, across] of felledTreeShadow(f.k, u)) { if (SF.n >= FEAT_CAP) break;
        _m.compose(_p.set(f.wx + dir.x * a, 0.006, f.wz + dir.z * a), _q.setFromAxisAngle(_s.set(0, 1, 0), Math.atan2(-dir.z, dir.x)), _s.set(2 * along, 1, 2 * across)); SF.mesh.setMatrixAt(SF.n++, _m); }
    }
    for (const f of [T, C]) { f.mesh.count = f.n; f.hull.count = f.n; sendInst(f.mesh, f.n); }
    SF.mesh.count = SF.n; sendInst(SF.mesh, SF.n); fallSent = moving ? null : fallers; }
    // Glints face the camera and twinkle: each swells and fades on its own phase.
    const G = feat.glint, face = _q.setFromAxisAngle(_p.set(0, 1, 0), Math.atan2(-Math.cos(yaw), -Math.sin(yaw)));
    G.n = 0;
    for (const g of glints) {
      const tw = Math.max(0, Math.sin(aTick * 0.05 + g.phase)) ** 3;
      if (tw < 0.05) continue;
      G.mesh.setMatrixAt(G.n++, _m.compose(_p.set(g.x, g.y, g.z), face, _s.set(g.size * tw, g.size * tw, 1)));
    }
    G.mesh.count = G.n; sendInst(G.mesh, G.n);
  }

  // Shots in flight, on drawProjectiles' path (render-fx projEnds/projAt: where each is loosed from and lands, its parabola), each
  // pointed along its true 3D flight line. The sim steps them 20 times a second; between steps each is carried on along
  // its path (never past its aim point) so a fast arrow glides instead of hopping. Arrows fly flat here (ARROW_ARC:
  // render-units — the bow's aim is shared with the 2D); a trebuchet's stone is lobbed as the 2D's.
  let arrowTick = -1, arrowT0 = 0, _d, P3 = null;
  const _pa = {};
  const stones = new Map();   // projectile id → a trebuchet stone's model
  // a stone: an icosahedron the sling stone's size, its corners pushed in and out (8 shapes, by its shot), flat faces,
  // outlined; made once a shape, copied a shot
  const rocks = [];
  function stoneModel(id){
    const k = id % 8; if (rocks[k]) return rocks[k].clone();
    const geo = new THREE.IcosahedronGeometry(1, 0), P = geo.attributes.position;
    for (let i = 0; i < P.count; i++) { const x = P.getX(i), y = P.getY(i), z = P.getZ(i), h = Math.abs(Math.round(x * 7 + y * 13 + z * 17 + k * 29)) % 7, f = 0.8 + h * 0.05;
      P.setXYZ(i, x * f, y * f * 0.9, z * f); }   // (a corner's copies hash alike: they move together, the faces stay shut)
    geo.computeVertexNormals();
    const g = new THREE.Group(), m = new THREE.Mesh(geo, mat('#8f8a80')); m.scale.setScalar(ar(TREB_STONE, 1.5)); m.userData.hullGeo = geo; m.userData.hullRound = true; g.add(m); addHulls(g);
    return (rocks[k] = g).clone();
  }
  function updateArrows(now){
    if (tick !== arrowTick) { arrowTick = tick; arrowT0 = now; }
    P3 = P3 || { flat: false, heading: worldFacing, hk: HPX / PX, arc: ARROW_ARC, pitch: ARROW_PITCH };
    const ahead = Math.min(1, (now - arrowT0) / (1000 / TPS)) * PROJECTILE_TILES_PER_TICK;
    const S = feat.shaft, Hd = feat.head, V = feat.vane, SP = feat.shadowP, TR = feat.streak, dir = _d = _d || new THREE.Vector3(), o = _pa;
    S.n = Hd.n = V.n = SP.n = TR.n = 0;
    for (const p of projectiles) {
      if (!projVisible(p) || S.n >= FEAT_CAP) continue;
      const prog = projProg(p, ahead); projAt(p, prog, P3, o);
      const x = o.x, y = o.y, h = o.h / HPX;
      // its shadow: thrown along the light by its height (projShadowAt, the 2D's); higher, smaller
      const sg = projShadowAt(o), fade = Math.max(0.45, 1 - o.h / 400), stone = isStoneShot(p);
      if (stone) put('shadowP', sg[0] + 0.5, 0.008, sg[1] + 0.5, 0.36 * fade, 1, 0.3 * fade);
      else put('shadowP', sg[0] + 0.5, 0.008, sg[1] + 0.5, 0.4 * fade, 1, 0.07, -Math.atan2(o.gy, o.gx));
      // Flight tangent: the ground run over the whole flight, and d(height)/d(progress).
      dir.set(o.gx, o.dh / HPX, o.gy).normalize();
      if (stone) { // a trebuchet's stone, tumbling end over end the way it flies
        let st = stones.get(p.id);
        if (!st) { st = stoneModel(p.id); scene.add(st); stones.set(p.id, st); }
        st.position.set(x + 0.5, h, y + 0.5); st.rotation.set(0, -Math.atan2(o.gy, o.gx), -prog * p.totalDist * 2.5, 'YXZ'); st.userData.seen = arrowTick; continue; }
      _m.compose(_p.set(x + 0.5, h, y + 0.5), _q.setFromUnitVectors(_s.set(0, 1, 0), dir), _s.set(1, 1, 1));
      S.mesh.setMatrixAt(S.n++, _m); Hd.mesh.setMatrixAt(Hd.n++, _m);
      if (prog > 0.04) TR.mesh.setMatrixAt(TR.n++, _m);   // (the air it parts: once it's clear of the bow)
      const a = p.attackerSnap; // bare shafts until the archer's team has Fletching (tower/TC bolts fly bare)
      if (a && a.utype === 'archer' && hasUpgrade(a.team, 'fletching')) { V.mesh.setMatrixAt(V.n, _m); V.mesh.setColorAt(V.n++, _c.set(teamColorLight(a.team))); }
    }
    for (const [id, st] of stones) if (st.userData.seen !== arrowTick) { scene.remove(st); stones.delete(id); }   // (landed)
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
    for (const f of [S, Hd, V, SP, TR]) {
      f.mesh.count = f.n; if (f.hull) f.hull.count = f.n;
      sendInst(f.mesh, f.n);
    }
  }

  // ---- Animals in 3D: sheep and bears (other units stay art billboards) ----
  // One model per animal for both views: the 2D draws project these (SHEEP, BEAR in render-units). Named pivots are
  // posed by animateAnimal. (ax/ah/ar: art px — x forward, y down from the anchor, feet at y = 5 — × UNIT_SCALE → local
  // x forward, y up, z across.)
  const ax = (x, k = 1) => x * UNIT_SCALE * k / PX, ah = (y, k = 1) => (5 - y) * UNIT_SCALE * k / HPX, ar = (r, k = 1) => r * UNIT_SCALE * k / PX;
  const blobGeos = new Map();
  function blob(parent, col, x, y, z, rx, ry = rx, rz = rx, res = null){ // an outlined ellipsoid; res: [around, up] fixed segments (else by POLY)
    const sw = res ? res[0] : segs(12), sh = res ? res[1] : segs(9);
    const gk = sw * 100 + sh; let geo = blobGeos.get(gk);                             // one shared unit sphere per resolution (never disposed)
    if (!geo) blobGeos.set(gk, geo = new THREE.SphereGeometry(1, sw, sh));
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
    for (const o of parent.children.slice(n0)) { delete o.userData.hullGeo; o.name = o.name || 'eye'; } // eyes carry no outline (named: a dead animal's close, deathPose)
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
    for (let i = 0; i < 12; i++) { // a ring of puffs standing out of the fleece — a scalloped edge, not a smooth ball
      const a = i / 12 * 2 * Math.PI + 0.26, up = i % 2 ? 0.05 : -0.01;
      blob(body, wool, Math.cos(a) * 0.235, cy + up, Math.sin(a) * 0.19, 0.07 + (i % 3) * 0.008).name = 'puff';
    }
    SHEEP.hips.forEach(([x, z], i) => { // (SHEEP, render-units: hung high inside the fleece, so the stride swings wide)
      const leg = pivot(body, x, SHEEP.hipY, z, 'leg' + i);
      pole(leg, SHEEP.legCol, [0, 0, 0], [0, -SHEEP.leg, 0], 0.02);
      blob(leg, SHEEP.hoof, 0, -SHEEP.leg - 0.01, 0, 0.026, 0.02, 0.024);
    });
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
  // a row of spikes down the spine, two membrane wings on bones. The flame (hidden till it breathes) rides the jaw.
  const DRAGON3D = { body: DRAGON_COL.body, dark: DRAGON_COL.plate, belly: DRAGON_COL.belly, membrane: DRAGON_COL.membrane, horn: DRAGON_COL.horn, eye: DRAGON_COL.eye, glow: DRAGON_COL.glow };   // (render-units: one palette for both views)
  let dragonPlateGeo = null, dragonClawGeo = null;
  // leg bones (thigh, shin) and the knee's bend: hind knees forward (+1), fore back (−1); a little longer than the hip's
  // height, so standing they're a touch bent
  // A body as ONE skin: rings along a line of stations that runs through its joints (each station set in its own
  // pivot: centre c, heading t, half-height ry toward n — the heading turned a quarter up — half-width rz, and `arc`,
  // how far round from its underside the second colour reaches), round-capped at both ends. The rings are laid again
  // from the pivots every frame (pose), so the skin bends at a joint instead of two pieces meeting there. Two meshes
  // over the same vertices, never two shells — nothing overlaps to flicker — and one outline round the whole.
  function liveSkin(root, col, colUnder, runs){
    const R = Math.max(8, segs(14) & ~1), H = 3, rings = [];
    const ring = (pv, c, t, ry, rz, arc) => rings.push({ pv, c, n: new THREE.Vector3(-t.y, t.x, 0), ry, rz, arc });
    const flat = runs.flatMap(r => r.st.map(q => ({ pv: r.pivot, ...q })));
    const cap = (q, dir, opening) => { for (let j = 0; j < H; j++) { const f = (opening ? H - j : j + 1) / H * Math.PI / 2;
      ring(q.pv, q.c.clone().addScaledVector(q.t, dir * Math.min(q.ry, q.rz) * Math.sin(f)), q.t, q.ry * Math.cos(f), q.rz * Math.cos(f), q.arc); } };
    cap(flat[0], -1, true);
    for (const q of flat) ring(q.pv, q.c, q.t, q.ry, q.rz, q.arc);
    cap(flat[flat.length - 1], 1, false);
    const P = new Float32Array(rings.length * R * 3), all = [], top = [], bot = [];
    for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < R; k++) {
      const A = i * R + k, B = i * R + (k + 1) % R, C2 = (i + 1) * R + (k + 1) % R, D = (i + 1) * R + k, quad = [A, B, D, B, C2, D];
      all.push(...quad); (-Math.cos((k + 0.5) / R * Math.PI * 2) > Math.cos(Math.min(rings[i].arc, rings[i + 1].arc)) ? bot : top).push(...quad); }
    const pos = new THREE.BufferAttribute(P, 3), geo = own(new THREE.BufferGeometry()); geo.setAttribute('position', pos); geo.setIndex(all); geo.computeVertexNormals();
    const part = (idx, m) => { const q = own(new THREE.BufferGeometry()); q.setAttribute('position', pos); q.setAttribute('normal', geo.attributes.normal); q.setIndex(idx);
      const o = new THREE.Mesh(q, m); o.frustumCulled = false; o.userData.live = true; root.add(o); };
    part(top, mat(col)); if (bot.length) part(bot, mat(colUnder)); part(all, hullMat);                 // (the outline: the same skin, pushed out along its normals)
    const mats = new Map(), rel = pv => { let m = mats.get(pv); if (m) return m; m = new THREE.Matrix4();   // the pivot's frame in root's
      for (let o = pv; o !== root; o = o.parent) { o.updateMatrix(); m.premultiply(o.matrix); } mats.set(pv, m); return m; };
    // At rest (now): each ring in root's frame, and each pivot's rest frame undone — a pivot then carries its rings
    // by how far it has turned since. Round a joint the rings go over gradually from the parent's turn to the
    // child's (w, half at the joint: a pipe's elbow): the parent's tilt where they stand, the child's swing about the
    // joint itself (J: the child pivot's origin). So the skin bends through an arc, keeps its girth, never folds
    // through itself — and nothing behind the joint rises as what is past it drops.
    const rest = new Map(), Z3 = new THREE.Vector3(0, 0, 1); let len = 0;
    rings.forEach((q, i) => { const M0 = rel(q.pv); if (!rest.has(q.pv)) rest.set(q.pv, M0.clone().invert());
      q.c0 = q.c.clone().applyMatrix4(M0); q.n0 = q.n.clone().transformDirection(M0); q.z0 = Z3.clone().transformDirection(M0);
      if (i) len += q.c0.distanceTo(rings[i - 1].c0); q.s = len; });
    const under = (o, p) => { for (let x = o.parent; x && x !== root.parent; x = x.parent) if (x === p) return true; return false; };
    rings.forEach((q, i) => { if (!i || rings[i - 1].pv === q.pv) return;                              // a joint: between rings i−1 and i
      const p = rings[i - 1], sj = (p.s + q.s) / 2, zone = 2 * Math.max(p.ry, p.rz, q.ry, q.rz), kid = under(p.pv, q.pv) ? p.pv : q.pv, par = kid === p.pv ? q.pv : p.pv;
      const J0 = new THREE.Vector3().setFromMatrixPosition(rel(kid));
      for (const r of rings) { const d = Math.abs(r.s - sj) / zone; if (d >= 1 || (r.pv !== kid && r.pv !== par) || (r.w && d > r.wd)) continue;
        const u = r.pv === kid ? (1 + d) / 2 : (1 - d) / 2;                                              // 0 the parent's turn … ½ at the joint … 1 the child's
        r.a = par; r.b = kid; r.w = Math.max(1e-6, u * u * (3 - 2 * u)); r.wd = d; r.swing = r.pv === kid; r.J0 = J0; r.d0 = r.c0.clone().sub(J0); } });
    const D = new Map(), turn = pv => { let m = D.get(pv); if (!m) { const M = rel(pv).clone().multiply(rest.get(pv)); D.set(pv, m = { M, q: new THREE.Quaternion().setFromRotationMatrix(M) }); } return m; };
    const c = new THREE.Vector3(), n = new THREE.Vector3(), z = new THREE.Vector3(), qt = new THREE.Quaternion();
    return () => { mats.clear(); D.clear();
      rings.forEach((q, i) => {
        if (q.w) { const A = turn(q.a); qt.copy(A.q).slerp(turn(q.b).q, q.w);
          if (q.swing) c.copy(q.d0).applyQuaternion(qt).add(n.copy(q.J0).applyMatrix4(A.M)); else c.copy(q.c0).applyMatrix4(A.M);
          n.copy(q.n0).applyQuaternion(qt); z.copy(q.z0).applyQuaternion(qt); }
        else { const A = turn(q.pv); c.copy(q.c0).applyMatrix4(A.M); n.copy(q.n0).applyQuaternion(A.q); z.copy(q.z0).applyQuaternion(A.q); }
        for (let k = 0; k < R; k++) { const a = k / R * Math.PI * 2, u = q.ry * Math.cos(a), w = q.rz * Math.sin(a), o = (i * R + k) * 3;
          P[o] = c.x + n.x * u + z.x * w; P[o + 1] = c.y + n.y * u + z.y * w; P[o + 2] = c.z + n.z * u + z.z * w; } });
      pos.needsUpdate = true; geo.computeVertexNormals(); };
  }
  const poseDragonSkins = model => { for (const pose of model.getObjectByName('body').userData.skins) pose(); };
  function dragonModel(){
    const C = DRAGON3D, g = new THREE.Group(), body = pivot(g, 0, 0, 0, 'body');
    if (!dragonClawGeo) { dragonClawGeo = new THREE.ConeGeometry(1, 1, 6).translate(0, 0.5, 0); dragonClawGeo.userData.kept = true; } // a claw: base at its root, tip +y
    if (!dragonPlateGeo) { dragonPlateGeo = new THREE.ConeGeometry(1, 1, 3).translate(0, 0.5, 0).scale(1, 1, 0.35); dragonPlateGeo.userData.kept = true; }
    const plate = (par, x, y, z, h, lean = -0.35) => { const m = new THREE.Mesh(dragonPlateGeo, mat(C.dark)); m.position.set(x, y, z); m.scale.set(h * 0.55, h, h * 0.55); m.rotation.z = lean; m.userData.hullGeo = dragonPlateGeo; par.add(m); };
    // a spike standing on a surface point with normal (nx, ny), swept back toward the tail
    const spike = (par, x, y, nx, ny, h, sweep = DRAGON_SWEEP) => plate(par, x - nx * 0.03, y - ny * 0.03, 0, h, Math.atan2(-nx, ny) + sweep);
    // The skin's stations. along: n+1 of them on the smooth line through pts (in a pivot's plane), radii by rAt(u) →
    // [ry, rz], headed the way the line runs (dir 1) or back along it (−1: a tail joint, listed tip-first).
    const V = (x, y) => new THREE.Vector3(x, y, 0), ease = u => u * u * (3 - 2 * u), UNDER = 1.25;
    const line = pts => new THREE.CatmullRomCurve3(pts.map(([x, y]) => V(x, y)));
    const along = (path, n, u0, u1, rAt, arc, dir = 1, len = true) => Array.from({ length: n + 1 }, (_, k) => { const u = u0 + (u1 - u0) * k / n, [ry, rz] = rAt(u);
      return { c: len ? path.getPointAt(u) : path.getPoint(u), t: (len ? path.getTangentAt(u) : path.getTangent(u)).multiplyScalar(dir), ry, rz, arc }; });
    const round = (r0, r1) => u => { const r = r0 + (r1 - r0) * ease(u); return [r, r]; };
    // legs, jointed: a muscled thigh from the hip (leg i) to the knee, a shin to the ankle, a flat foot — posed by
    // placing the foot on the ground (animateAnimal: dragonLegs). Hind 0/1 heavier. Each leg one skin, haunch to ankle.
    const legRuns = [];
    [[-0.45, -0.29], [-0.45, 0.29], [0.36, -0.27], [0.36, 0.27]].forEach(([x, z], i) => {
      const hind = i < 2, L = DRAGON_LEG[hind ? 'hind' : 'fore'], leg = pivot(body, x, 0.62, z, 'leg' + i);
      const knee = pivot(leg, 0, -L.th, 0, 'knee'); knee.userData.leg = L;
      const fl = L.hock ? Math.hypot(...L.hock) : 0, hock = fl ? pivot(knee, 0, -L.sh, 0, 'hock') : null;          // a hind leg's long foot, hock to ankle
      const k = hind ? 1 : 0.8, down = (y, ry, rz) => ({ c: V(0, y), t: V(0, -1), ry, rz, arc: 0 });            // (headed down: its rings lie flat)
      // its top a broad flat muscle inside the flank, swelling out of it lower down: the leg grows from the body's side
      const run = [{ pivot: leg, st: [down(0.15, 0.16 * k, 0.07 * k), down(0.05, 0.2 * k, 0.125 * k), down(-0.05, 0.2 * k, 0.15 * k), down(-0.14, 0.175 * k, 0.145 * k), down(-L.th * 0.62, 0.133 * k + 0.012, 0.118 * k + 0.012), down(-L.th + 0.05, hind ? 0.112 : 0.097, hind ? 0.108 : 0.094)] },
        { pivot: knee, st: [down(-0.05, hind ? 0.108 : 0.094, hind ? 0.105 : 0.092), down(-L.sh * 0.5, hind ? 0.095 : 0.085, hind ? 0.09 : 0.082), down(-L.sh + (fl ? 0.04 : 0.05), fl ? 0.085 : 0.066, fl ? 0.082 : 0.066)] }];
      if (hock) run.push({ pivot: hock, st: [down(-0.04, 0.082, 0.08), down(-fl * 0.5, 0.072, 0.07), down(-fl + 0.05, 0.066, 0.066)] });
      const ankle = pivot(hock || knee, 0, hock ? -fl : -L.sh, 0, 'ankle');
      // the foot: the leg's skin runs on through the ankle, round the heel, into a broad palm; three toes hinge at
      // its front ('toes': flat on the ground as the heel lifts, curled in the air — dragonStride), a claw on each
      const on = (x, y, tx, ty, ry, rz) => ({ c: V(x, y), t: V(tx, ty).normalize(), ry, rz, arc: 0 }), w = hind ? 1 : 0.92;
      run.push({ pivot: ankle, st: [on(-0.025, -0.015, 1, -1, 0.062, 0.07 * w), on(0.0, -0.05, 1, 0, 0.05, 0.085 * w), on(0.06, -0.054, 1, 0, 0.046, 0.1 * w), on(DRAGON_TOE_BASE + 0.01, -0.06, 1, 0, 0.036, 0.095 * w)] });
      legRuns.push(run);
      const toes = pivot(ankle, DRAGON_TOE_BASE, -0.062, 0, 'toes');
      for (const z of [-1, 0, 1]) { const toe = new THREE.Group(), len = z ? 1 : 1.15; toe.position.set(-0.01, 0, z * 0.06 * w); toe.rotation.y = -z * 0.38; toes.add(toe);
        blob(toe, C.body, 0.055 * len, 0, 0, 0.075 * len, 0.034, 0.04);
        const cl = new THREE.Mesh(dragonClawGeo, mat(C.horn)); cl.userData.hullGeo = dragonClawGeo;
        cl.position.set(0.115 * len, 0.004, 0); cl.rotation.z = -Math.PI / 2 - 0.42; cl.scale.set(0.03, 0.105, 0.03); toe.add(cl); }
    });
    // tail: three jointed segments tapering down and back to a spade; neck up to the head — pivots only: the skin is laid over them below
    const TAIL = [[[0, 0], [-0.3, -0.05], [-0.6, -0.16]], [[0, 0], [-0.3, -0.09], [-0.6, -0.2]], [[0, 0], [-0.28, -0.02], [-0.55, 0.02]]], TAIL_R = DRAGON_TAIL_R;
    const tail = pivot(body, -0.8, 0.74, 0, 'tail'), tail2 = pivot(tail, -0.6, -0.16, 0, 'tail2'), tail3 = pivot(tail2, -0.6, -0.2, 0, 'tail3'), tails = [tail, tail2, tail3];
    const spade = pivot(tail3, -0.55, 0.02, 0, 'spade');
    const sp = new THREE.Mesh(dragonPlateGeo, mat(C.dark)); sp.scale.set(0.2, 0.42, 0.12); sp.rotation.z = Math.PI / 2 + 0.05; sp.userData.hullGeo = dragonPlateGeo; spade.add(sp);
    const neck = pivot(body, 0.62, 0.95, 0, 'neck');
    const head = pivot(neck, 0.5, 0.78, 0, 'head');
    // the trunk's stations along its line (dragonTrunk, render-units: shared with the 2D art), tail root to neck root
    const trunkSt = (n, u0, u1) => Array.from({ length: n + 1 }, (_, k) => { const q = dragonTrunk(u0 + (u1 - u0) * k / n); return { c: V(q.x, q.y), t: V(q.tx, q.ty), ry: q.ry, rz: q.rz, arc: UNDER }; });
    const HEAD = DRAGON_HEAD;   // skull, then a long wedge of a snout
    const headR = u => { const f = u * (HEAD.length - 1), i = Math.min(HEAD.length - 2, Math.floor(f)), q = f - i; return [HEAD[i][2] + (HEAD[i + 1][2] - HEAD[i][2]) * q, HEAD[i][3] + (HEAD[i + 1][3] - HEAD[i][3]) * q]; };
    // one skin, tail tip to snout: pale underneath from the tail to the throat
    const spine = [...tails.map((pv, k) => ({ pivot: pv, st: along(line(TAIL[k]), segs(6), 1, 0.15, round(TAIL_R[k], TAIL_R[k + 1]), UNDER, -1) })).reverse(),
      { pivot: body, st: trunkSt(segs(30), 0.04, 0.97) },
      { pivot: neck, st: along(line(DRAGON_NECK), segs(12), 0.1, 1, round(0.23, 0.12), UNDER) },
      { pivot: head, st: along(line(HEAD), segs(10), 0, 1, headR, 0, 1, false) }];
    body.userData.skins = [liveSkin(body, C.body, C.belly, spine), ...legRuns.map(r => liveSkin(body, C.body, C.belly, r))];
    // the spikes down the spine (dragonSpikeRow: one evenly spaced row), each stood on the skin's top line in its own
    // part's pivot: down the back of the neck, along the back, out the tail
    { const top = (k, st, up) => st.map(q => ({ k, x: q.c.x - q.t.y * q.ry * up, y: q.c.y + q.t.x * q.ry * up, nx: -q.t.y * up, ny: q.t.x * up }));
      const par = { neck, body, tail0: tail, tail1: tail2, tail2: tail3 };
      for (const q of dragonSpikeRow([...top('neck', along(line(DRAGON_NECK), 60, 1, DRAGON_NECK_FROM, round(0.23, 0.12), 0), 1), ...top('body', trunkSt(100, DRAGON_BACK_TO, 0), 1),
        ...tails.flatMap((pv, k) => top('tail' + k, along(line(TAIL[k]), 50, 0, 1, round(TAIL_R[k], TAIL_R[k + 1]), 0), -1))])) spike(par[q.k], q.x, q.y, q.nx, q.ny, q.h, q.k === 'neck' ? DRAGON_NECK_SWEEP : DRAGON_SWEEP); }
    for (const z of [-1, 1]) {
      blob(head, C.dark, 0.17, 0.105, z * 0.115, 0.085, 0.02, 0.035);                       // brow ridge
      const eye = blob(head, C.eye, 0.21, 0.062, z * 0.13, 0.045, 0.024, 0.018); eye.name = 'eye';
      tube(head, C.horn, [-0.05, 0.11, z * 0.09], [-0.22, 0.24, z * 0.13], [-0.36, 0.42, z * 0.16], 0.03);   // horn swept back and up
    }
    const jaw = pivot(head, 0.08, -0.12, 0, 'jaw');
    blob(jaw, C.glow, 0.16, 0.02, 0, 0.14, 0.03, 0.05);                                    // the furnace in its throat
    blob(jaw, DRAGON_COL.dark, 0.23, -0.025, 0, 0.23, 0.05, 0.075);                        // the lower jaw, a shade darker than the hide (the 2D art's)
    // the fire's root: nested cones out of the mouth (+x), glowing where they overlap, no outline
    const flame = pivot(jaw, 0.5, 0.02, 0, 'flame');
    flame.visible = false;
    for (const side of [1, -1]) dragonWing(body, side);
    poseDragonSkins(g);
    return g;
  }
  // A wing, built as a bat's: bones shoulder → elbow → wrist, four fingers fanning from the wrist, and one membrane
  // stretched between them and the hip — the flank panel (shoulder, elbow, wrist, last finger, hip) and the panels
  // between the fingers, scalloped at their edges. The membrane is rebuilt each frame from where the bones are
  // (poseDragonWing), so it can't come loose. All in the wing's own plane: x chord (back −), y span (out), z its
  // normal; 'fold' turns that plane out of the flank.
  // The membrane's triangles (joint names; F3 a fingertip, M2 a scallop point, R1 a point on the web's edge, C2 a
  // panel's middle). A finger gap is four facets round its middle, which billows out of the plane, so the wing is a
  // stretched skin, lit facet by facet.
  const WING_PANELS = DRAGON_WING.LK.length, FL = 'F' + (WING_PANELS - 1), WEB = Array.from({ length: DRAGON_WING.WEB }, (_, k) => 'R' + k),
    // (the arm's web, fanned from the elbow: wrist, the last finger, round its scooped edge to the flank, the shoulder —
    // then the hand's panels between the fingers)
    WING_TRIS = [...['W', FL, ...WEB, 'B', 'S'].map((k, i, a) => i ? ['E', a[i - 1], k] : null).filter(Boolean), ...Array.from({ length: WING_PANELS - 1 }, (_, k) => { const a = 'F' + k, m = 'M' + k, b = 'F' + (k + 1), c = 'C' + k;
    return [['W', a, c], [a, m, c], [m, b, c], [b, 'W', c]]; }).flat()];
  let dragonBoneGeo = null;
  function dragonWing(body, side){
    const C = DRAGON3D, w = pivot(body, 0.1, 1.04, 0.25 * side, side > 0 ? 'wingL' : 'wingR');
    const fold = pivot(w, 0, 0, 0, 'fold'); fold.rotation.x = side * Math.PI / 2;
    const n = WING_TRIS.length * 3, pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    const gm = new THREE.BufferGeometry(); gm.setAttribute('position', pos); gm.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const gh = new THREE.BufferGeometry(); gh.setAttribute('position', pos); gh.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); // the outline's push directions
    const mem = new THREE.Mesh(gm, mat(C.membrane, true)); mem.frustumCulled = false; mem.renderOrder = 2; fold.add(mem);
    dragonHullDS = dragonHullDS || (HULL_MATS.add(dragonHullDS = screenHull(new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, depthWrite: false }), HULL, 1.5)), dragonHullDS);
    const hull = new THREE.Mesh(gh, dragonHullDS); hull.frustumCulled = false; fold.add(hull);
    // bones that taper to their far ends (arm, forearm, a finger each)
    if (!dragonBoneGeo) { dragonBoneGeo = new THREE.CylinderGeometry(0.22, 0.5, 1, 8); dragonBoneGeo.userData.kept = true; }
    const stick = (geo, col, r) => { const b = new THREE.Mesh(geo, mat(col)); b.userData.hullGeo = geo; b.userData.hullW = Math.min(HULL, r * 0.6); b.userData.r = r; fold.add(b); return b; };
    const bones = [0.04, 0.034, ...DRAGON_WING.LK.map((_, k) => 0.024 - k * 0.002)].map(r => stick(dragonBoneGeo, C.dark, r));
    const knob = blob(fold, C.dark, 0, 0, 0, 0.042);                                        // the wrist knuckle
    w.userData.wing = { pos, gm, gh, bones, knob, side, hull, mem, lag: 0, ang: null };
    for (const o of [hull, mem, knob, ...bones]) o.userData.live = true;              // (re-laid every frame: bakeRigid leaves them be)
  }
  let dragonHullDS = null; const _wv = {};
  // Lay the wing out for fold fd (0 spread … 1 folded): joints from the blended angles, then the membrane's facets
  // between them, the outline pushed out from the wing's middle, the bones set end to end. lag: the wing's tips
  // trailing behind its swing (out of its plane, more the farther from the wrist).
  function poseDragonWing(w, fd, tuck = 0, lag = 0){
    const d = w.userData.wing, J = dragonWingJoints(fd, tuck, d.side), { S, E, W } = J, pt = { S, E, W, B: J.B }, nF = J.F.length; // (render-units: shared with the 2D art)
    const trail = p => [p[0], p[1], p[2] + d.side * lag * Math.hypot(p[0] - W[0], p[1] - W[1])];
    J.F.forEach((p, k) => { pt['F' + k] = trail(p); }); J.M.forEach((p, k) => { pt['M' + k] = trail(p); }); J.R.forEach((p, k) => { pt['R' + k] = trail(p); });
    for (let k = 0; k < nF - 1; k++) { const q = [pt['F' + k], pt['M' + k], pt['F' + (k + 1)], W];   // each panel's middle, billowed (flat when folded)
      pt['C' + k] = [0, 1, 2].map(c => q.reduce((a, p) => a + p[c], 0) / 4 - (c === 2 ? d.side * 0.07 * (1 - J.e) : 0)); }
    let cx = 0, cy = 0, m = 0; for (const k in pt) if (k[0] !== 'C' && k[0] !== 'M') { cx += pt[k][0]; cy += pt[k][1]; m++; } cx /= m; cy /= m;
    const P3 = d.pos.array, N = d.gh.attributes.normal.array; let i = 0;
    for (const tri of WING_TRIS) for (const k of tri) { const p = pt[k]; P3[i] = p[0]; P3[i + 1] = p[1]; P3[i + 2] = p[2];
      const nx = p[0] - cx, ny = p[1] - cy, nl = Math.hypot(nx, ny) || 1; N[i] = nx / nl; N[i + 1] = ny / nl; N[i + 2] = 0; i += 3; }
    d.pos.needsUpdate = true; d.gh.attributes.normal.needsUpdate = true; d.gm.computeVertexNormals();
    d.hull.renderOrder = 1; d.mem.renderOrder = 2;                                                // (addHulls' union pass levels every mesh: the outline must go first)
    const set = (b, a, c) => { _wv.a = _wv.a || new THREE.Vector3(); _wv.d = _wv.d || new THREE.Vector3(); _wv.a.set(a[0], a[1], a[2]); _wv.d.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const L = _wv.d.length() || 1e-4; b.scale.set(2 * b.userData.r, L, 2 * b.userData.r); b.position.copy(_wv.a).addScaledVector(_wv.d, 0.5); b.quaternion.setFromUnitVectors(_wv.y = _wv.y || new THREE.Vector3(0, 1, 0), _wv.d.normalize()); };
    set(d.bones[0], S, E); set(d.bones[1], E, W); for (let k = 0; k < nF; k++) set(d.bones[2 + k], W, pt['F' + k]);
    d.knob.position.set(W[0], W[1], W[2]);
  }
  // Pose an animal from its state (viewer-only). A four-beat walk — hind,
  // fore, other hind, other fore — with each leg lifting on its forward
  // swing and a bob at every footfall; the phase advances by the distance
  // actually covered (a.moved) over the stride 4·L·sin A — a foot is down for
  // half the cycle while it sweeps its whole arc (2·L·sin A), so the body must
  // cover twice that per cycle for planted feet not to slide. a.gait eases
  // in/out, so legs settle when it stops.
  const GAIT = { sheep: SHEEP, bear: { A: 0.45, L: 0.28, lift: 0.05, bob: 0.02 }, dragon: { A: 0.6, L: 0.5, lift: 0.12, bob: 0.03 } }; // (the dragon: long, slow strides — a heavy, unhurried walk; DRAGON_STRIDE in render-units matches)
  const LEG_PHASE = [0, 0.5, 0.25, 0.75].map(f => f * 2 * Math.PI); // legs 0/1 hind, 2/3 fore
  let _dv = null;
  // A model's named pivot, found once and kept on it: getObjectByName walks the whole model, and the per-frame posers asked
  // a dozen times a model a frame. (A pivot is never renamed or replaced in a model's life.)
  const namedParts = new WeakMap();   // (not on userData: three deep-copies that through JSON on a clone)
  function namedPart(model, name){ let P = namedParts.get(model); if (!P) namedParts.set(model, P = new Map()); let o = P.get(name);
    if (o === undefined) { o = model.getObjectByName(name) || null; P.set(name, o); } return o; }
  function animateAnimal(model, e, a, dt){
    const G = GAIT[e.utype], b = namedPart(model, 'body'), neck = namedPart(model, 'neck'), idp = e.id || 0;
    const legs = [0, 1, 2, 3].map(i => namedPart(model, 'leg' + i));
    if (e.utype === 'dragon') dragonGaitStep(e, a, a.moved, dt, G.L * Math.sin(G.A));   // (its pivots step too)
    else if (e.utype !== 'bear' && e.utype !== 'sheep') { a.gait += ((a.moved > 1e-4 ? 1 : 0) - a.gait) * Math.min(1, dt * 8);
      a.phase += a.moved / (4 * G.L * Math.sin(G.A)) * 2 * Math.PI; }
    const look = 0.35 * Math.sin(aTick * 0.013 + idp) ** 3 * (1 - a.gait); // now and then a slow look round
    const bob = G.bob * Math.abs(Math.sin(2 * a.phase)) * a.gait;
    let reach = 0; // bear pounce: fore legs reach, hind brace
    if (e.utype === 'sheep') {
      // sheepAnim (render-units, shared with the 2D art): the trot, breathing, the look round, grazing
      const P = sheepAnim(e, a, dt, a.moved, aTick);
      b.position.y = P.bob; b.scale.y = 1 + P.breath;
      neck.rotation.z = P.neck; neck.rotation.y = P.look;
      legs.forEach((l, i) => { l.userData.y0 ??= l.position.y; l.rotation.z = P.legs[i].ang; l.position.y = l.userData.y0 + P.legs[i].up; });
      return;
    } else if (e.utype === 'dragon') {
      // A huge, heavy beast: its pose comes from dragonAnim (render-units, shared with the 2D art) — here set on the
      // model, with the dust and the ground's shake at its footfalls and slam, and smoke from its nostrils.
      const P = dragonAnim(e, a, dt), head = namedPart(model, 'head');
      b.scale.set(1 + P.chest * 0.35, 1 + P.chest, 1 + P.chest * 0.8);
      b.rotation.set(P.roll, P.yaw, P.pitch);
      b.position.set(P.bodyX, P.bodyY + bob * 0.4, P.bodyZ);
      neck.rotation.z = P.neck; neck.rotation.y = P.neckY;
      head.rotation.z = P.head; head.rotation.x = P.headX;
      namedPart(model, 'jaw').rotation.z = -P.jaw;
      for (const eye of head.children.filter(o => o.name === 'eye')) { eye.userData.sy ??= eye.scale.y; eye.scale.y = eye.userData.sy * (1 - 0.92 * P.eyeShut); }
      ['tail', 'tail2', 'tail3'].forEach((n, k) => { const j = namedPart(model, n); j.rotation.y = P.tail[k]; j.rotation.z = P.tailZ[k]; });
      namedPart(model, 'spade').rotation.y = P.spade;
      const carry = dragonWingCarry(P);                                                  // (render-units: how they're carried, shared with the 2D art)
      for (const [nm, sd] of [['wingL', 1], ['wingR', -1]]) { const w = namedPart(model, nm), d = w.userData.wing;
        // the tips trail behind the wing's swing: its turn rate, eased
        const v = d.ang === null || !dt ? 0 : (carry.ang - d.ang) / dt; d.ang = carry.ang; d.lag += (Math.max(-0.35, Math.min(0.35, v * 0.12)) - d.lag) * Math.min(1, dt * 7);
        poseDragonWing(w, carry.fd, P.sl, d.lag);
        w.rotation.set(-sd * carry.ang, 0, carry.pitch); }
      const fl = namedPart(model, 'flame');   // (the mouth: where the fire leaves it)
      dragonFire(model, fl, P.flame, fxDt, P.fly || 0, typeof dragonFireAim === 'function' ? dragonFireAim(e) : null);
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
      namedPart(model, 'jaw').rotation.z = -0.7 * P.jaw;
      legs.forEach((l, i) => { l.userData.y0 ??= l.position.y; l.position.y = l.userData.y0; l.rotation.z = P.legs[i].ang; l.scale.y = P.legs[i].len; });
      return;
    }
    // Each leg: half the cycle planted, its foot sweeping back at an even pace (it keeps pace with the ground),
    // half swinging forward through the air.
    if (e.utype === 'dragon') { dragonLegs(model, a, legs, reach, G); poseDragonSkins(model); return; }
    legs.forEach((l, i) => {
      if (l.userData.y0 === undefined) l.userData.y0 = l.position.y;
      const q = (((a.phase + LEG_PHASE[i] - Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let x, up = 0;                                                                   // x: the foot, −1 (back) … 1 (ahead)
      if (q < Math.PI) x = 1 - 2 * q / Math.PI; else { const u = q / Math.PI - 1; x = -Math.cos(u * Math.PI); up = Math.sin(u * Math.PI); }
      l.rotation.z = Math.asin(Math.sin(G.A) * x) * a.gait + (i < 2 ? -0.35 : 0.45) * reach + (a.lie ? (i < 2 ? -1.3 : 1.3) * a.lie : 0); // (a lying dragon tucks its legs)
      l.position.y = l.userData.y0 + G.lift * up * a.gait;
    });
  }
  // The dragon's fire: a stream of puffs blown from the jaws along the head's line, each on its own in the model's
  // surroundings (its parent: the world) — flying on and slowing, swelling, cooling from white-hot through orange and
  // red to smoke, rising as it thins. So the jet bends as the head swings and hangs a moment after the blast.
  let FIRE_RAMP = null, _f0 = null, _f1 = null;
  // Models with fire still in the air, and the frame each was last tended: a dragon that isn't posed this frame (off
  // screen, out of range, flown on) still has its puffs burn out (updateUnits) — else they hung where it left them.
  const burning = new Set(); let fireFrame = 0;
  let _fT = null;
  function dragonFire(model, mouth, flame, dt, fly = 0, aim = null){
    const F = model.userData.fire || (model.userData.fire = { puffs: [], due: 0 }), host = model.parent;
    F.seen = fireFrame; burning.add(model);
    FIRE_RAMP = FIRE_RAMP || ['#fff2b0', '#ffc94a', '#ff8a1e', '#d8381a', '#6a2a20', '#33302e'].map(c => new THREE.Color(c));
    if (flame > 0 && host) { _f0 = _f0 || new THREE.Vector3(); _f1 = _f1 || new THREE.Vector3(); model.updateMatrixWorld(true);
      host.worldToLocal(mouth.localToWorld(_f0.set(0, 0, 0))); host.worldToLocal(mouth.localToWorld(_f1.set(1, 0, 0))); _f1.sub(_f0).normalize();
      // (aloft it pours the fire down: a bigger, steeper jet that splashes on the ground)
      // (…aimed where the sim burns: dragonFireAim, js/wildlife.js — the ground ahead, or a building's walls; and thrown
      // just that far, so it breaks on the spot instead of carrying on through it)
      let reach = 0;
      if (fly > 0) { const hl = Math.hypot(_f1.x, _f1.z) || 1, S = aim ? aim.s : 3.4, H = aim ? aim.h : 0; _fT = _fT || new THREE.Vector3();
        if (aim && aim.dx != null) _fT.set(model.position.x + aim.dx * S, H, model.position.z + aim.dy * S); else _fT.set(model.position.x + _f1.x / hl * S, H, model.position.z + _f1.z / hl * S);   // (on its target: dragonAimAt)
        _fT.sub(_f0); reach = _fT.length(); _fT.normalize(); _f1.lerp(_fT, fly).normalize(); }
      // A flame-thrower's jet: each puff flies STRAIGHT and fast, small and white-hot, for its reach (the aim's
      // distance; on the ground, the breath's) — a stream — and only then, where it lands, breaks into rolling fire.
      const far = reach > 0 && fly > 0.5 ? reach : 2.6;
      for (F.due += dt * 150 * flame * (1 + 0.4 * fly); F.due >= 1; F.due--) { const hot = Math.random() < 0.3, j = () => (Math.random() - 0.5) * 2, sp = far / (0.14 + Math.random() * 0.05);
        const m = new THREE.Mesh(unitSphere(), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: hot ? THREE.AdditiveBlending : THREE.NormalBlending }));
        m.position.copy(_f0).addScaledVector(_f1, Math.random() * sp * dt); m.renderOrder = hot ? 6 : 5; m.frustumCulled = false; host.add(m);   // (spread along the frame's travel: no gaps in the stream)
        F.puffs.push({ m, hot, age: 0, land: 0, gone: 0, reach: far * (0.9 + Math.random() * 0.2), sp, life: hot ? 0.3 : 0.6 + Math.random() * 0.25, grow: (hot ? 0.45 : 0.7 + Math.random() * 0.35) * (1 + 0.5 * fly),
          v: new THREE.Vector3(_f1.x + j() * 0.035, _f1.y + j() * 0.03, _f1.z + j() * 0.035).multiplyScalar(sp) }); } }
    const sm = x => x * x * (3 - 2 * x);
    for (let i = F.puffs.length - 1; i >= 0; i--) { const p = F.puffs[i]; p.age += dt; const u = p.age / p.life;
      if (u >= 1 || !p.m.parent) { if (p.m.parent) p.m.parent.remove(p.m); p.m.material.dispose(); F.puffs.splice(i, 1); continue; }
      p.m.position.addScaledVector(p.v, dt);
      let r, tl = 0;
      if (!p.land) { p.gone += p.sp * dt; r = (p.hot ? 0.06 : 0.085) + 0.08 * Math.min(1, p.gone / p.reach);   // (the stream widens a little along its length)
        if (p.gone >= p.reach || p.m.position.y < r) {                                              // it lands: breaks up and rolls out
          p.land = p.age; const an = Math.random() * Math.PI * 2, k = p.sp * 0.1; p.v.multiplyScalar(0.12); p.v.x += Math.cos(an) * k; p.v.z += Math.sin(an) * k; p.v.y = Math.abs(p.v.y) * 0.3 + 0.35; } }
      else { p.v.multiplyScalar(Math.max(0, 1 - 3.2 * dt)); p.v.y += 0.5 * dt; tl = Math.min(1, (p.age - p.land) / Math.max(0.05, p.life - p.land));
        r = 0.16 + p.grow * 0.55 * sm(Math.min(1, tl * 1.5)); }
      p.m.scale.setScalar(r);
      if (p.m.position.y < r * 0.4) { p.m.position.y = r * 0.4; if (p.v.y < 0) p.v.y *= -0.25; }      // along the ground, never through it
      const f = Math.min(FIRE_RAMP.length - 1.001, p.land ? 0.6 + tl * (p.hot ? 1.8 : FIRE_RAMP.length - 1.6) : 0.3), k = Math.floor(f);
      p.m.material.color.copy(FIRE_RAMP[k]).lerp(FIRE_RAMP[k + 1], f - k); p.m.material.opacity = (p.hot ? 0.8 : 0.9) * Math.min(1, (1 - tl) * 2.5); }
  }
  function quenchDragonFire(model){ const F = model.userData.fire; if (!F) return; for (const p of F.puffs) { if (p.m.parent) p.m.parent.remove(p.m); p.m.material.dispose(); } F.puffs.length = 0; }
  // The dragon's legs: each foot's spot is found — under the hip on the ground, swept back through the stance, lifted
  // and brought forward on the swing — and the hip and knee solved to reach it (two-bone IK in the leg's plane). So
  // the feet stay planted as the heavy body sinks and rolls over them. The foot rolls: heel up at toe-off, toes down
  // through the swing. Rearing, the fore feet paw the air; lying (a.lie) the legs blend to a resting pose splayed
  // beside the body — forelegs out in front like a sphinx's, hind legs folded knee-forward.
  let _lw = null, _qa = null, _qb = null, _qc = null, _ea = null;
  function dragonLegs(model, a, legs, reach, G, lie = a.lie || 0, i0 = 0){
    const body = model.getObjectByName('body'), ck = a.dr ? a.dr.ck : 0; model.updateMatrixWorld(true);
    _lw = _lw || new THREE.Vector3();
    legs.forEach((l, j) => { const i = j + i0;
      const knee = l.getObjectByName('knee'), ankle = l.getObjectByName('ankle'), L = knee.userData.leg, hind = i < 2, side = Math.sign(l.position.z);
      const lv = a.lieF !== undefined ? (hind ? a.lieH : a.lieF) : lie;                  // (waking, the forelegs stand first: dragonAnim)
      const { x, up, roll, toe, heel } = dragonStride(a.phase, i);                       // (render-units: the stride, shared with the 2D art)
      l.getWorldPosition(_lw); _lw.y = DRAGON_FOOT + (G.lift * 1.8 * up + heel) * a.gait; body.worldToLocal(_lw);
      ankle.getObjectByName('toes').rotation.z = toe * a.gait * (1 - lv);
      let tx = _lw.x - l.position.x + x * G.L * Math.sin(G.A) * a.gait, ty = _lw.y - l.position.y;
      if (!hind && reach > 0.2) { const pw = ck * 5.5 + (side > 0 ? 0 : Math.PI);     // rearing: the fore feet paw the air, alternately
        const px = 0.2 + 0.14 * Math.sin(pw), py = -0.3 + 0.1 * Math.cos(pw), w = Math.min(1, (reach - 0.2) * 2);
        tx += (px - tx) * w; ty += (Math.max(ty, py) - ty) * w; }
      const T = DRAGON_TUCK[hind ? 'hind' : 'fore'], [hip, kn, fa] = dragonLegPose(L, T, tx, ty, lv), hock = l.getObjectByName('hock');
      l.rotation.set(-side * T.out * lv, 0, hip); l.position.y = l.userData.y0 ??= l.position.y;
      knee.rotation.set(hind ? -side * 0.7 * lv : 0, 0, kn);                            // lying, the hind shin swings out to the side: the ankle and foot sit beside the thigh, not tucked under it
      // The foot, set in the body's frame whatever the leg's splay: flat, rolling through the step; lying, its toes turned
      // out to the side — the hind ones well out, so the foot sits beside the folded shin, not inside it (the leg's own
      // splay rolled the sole onto its edge)
      _qa = _qa || new THREE.Quaternion(); _qb = _qb || new THREE.Quaternion(); _qc = _qc || new THREE.Quaternion(); _ea = _ea || new THREE.Euler(0, 0, 0, 'YZX');
      l.updateMatrix(); knee.updateMatrix();
      _qa.copy(l.quaternion).multiply(knee.quaternion).invert();
      _qb.setFromEuler(_ea.set(0, side * (hind ? 0.5 : 0.35) * lv, roll * a.gait * (1 - lv)));
      // (a hind leg's long foot: set in the body's frame too, at its own angle; the ankle then undoes that)
      if (hock) { _qc.setFromEuler(_ea.set(0, 0, fa)); hock.quaternion.copy(_qa).multiply(_qc); _qa.copy(_qc).invert(); _qb.setFromEuler(_ea.set(0, side * 0.5 * lv, roll * a.gait * (1 - lv))); }
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
    dragonFire(model, null, 0, 0.016);   // (its last breath's puffs burn out)
    poseDragonSkins(model);
  }
  // ---- Characters in 3D (design stage: __povCharMock) ----
  // One kit for every unit, from the 2D rig's numbers (drawBodyLayer /
  // soldierEquip): art px, x forward, y down from the ground
  // point, z lateral — the same ax/ah/ar mapping as the animals.
  // Characters are drawn upright in the art (billboard-true), so heights use PX, not the iso HPX.
  const chh = (y, k = 1) => (5 - y) * UNIT_SCALE * k / PX;
  const SKIN = HUMAN_COL.skin, HAIR = HUMAN_COL.hair, LEG = HUMAN_COL.leg, BOOT = HUMAN_COL.boot, STEEL = '#a7abb0', GOLD = '#daa520'; // (HUMAN_COL: render-units, both views)
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
  // The LEGO clip hand: a C open at +x around the z axis; its band is rb thick, hzT tall on the thumb jaw, hzF on the
  // fingers' jaw (fs: +1 = the +y side), blending round the closed back; the jaw tips rounded off. The thumb sits at the
  // +z end of the fist (a fist's thumb and index lead; +z: the hold's dir, toward the tool's head)
  // (resolution follows POLY against the game's 0.6: the full rig keeps CLIP_NA × CLIP_NS, a light one far fewer)
  let CLIP_NA = 12, CLIP_NS = 6;
  // Heads, hair and helmets: round at any detail (it's what you look at) — a far unit's light rig a little coarser.
  const HEAD_RES_FULL = [14, 10], HEAD_RES_LOW = [10, 7];
  let HEAD_RES = HEAD_RES_FULL;
  function clipGeo(R, rb, hzT, hzF, fs){
    const k = Math.min(1, POLY / 0.6), NA = Math.max(9, Math.round(CLIP_NA * k)), NS = Math.max(4, Math.round(CLIP_NS * k));
    const gap = Math.PI * 0.5, pos = [], idx = [], sq = (c, e) => Math.sign(c) * Math.pow(Math.abs(c), e);
    for (let i = 0; i <= NA; i++) { const u = i / NA, th = gap / 2 + u * (2 * Math.PI - gap), c = Math.cos(th), sn = Math.sin(th);
      const t = Math.max(0, Math.min(1, (fs * sn + 0.5) / 1)), hz = hzT + (hzF - hzT) * t * t * (3 - 2 * t);
      const e = Math.min(u, 1 - u) * NA / 3, tip = e >= 1 ? 1 : Math.sqrt(Math.max(0, 1 - (1 - e) * (1 - e)));   // the last 3 rings close the jaw
      const zc = (1 - t * t * (3 - 2 * t)) * (hzF - hzT) * 0.85;   // the thumb's jaw up at the fist's leading end
      for (let j = 0; j <= NS; j++) { const ph = j / NS * 2 * Math.PI, rr = R + rb * tip * sq(Math.cos(ph), 0.7), z = zc + hz * tip * sq(Math.sin(ph), 0.7);
        pos.push(rr * c, rr * sn, z); } }
    for (let i = 0; i < NA; i++) for (let j = 0; j < NS; j++) { const a = i * (NS + 1) + j, b = a + NS + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  // A LEGO hand on point H: a C-clip open away from the wrist (endM: where the forearm ends); holding something, its
  // hole is on the grip and along the item (gax), else upright. side: which hand (the fingers' jaw mirrors left/right).
  const clipGeos = new Map();
  function legoHand(U, H, B, gax, endM, side){
    const v = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], nz = a => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };
    const f = nz(v(H, B)), up = [0.6, 0.8, 0], fu = up[0] * f[0] + up[1] * f[1] + up[2] * f[2], uu = nz(v(up, f.map(x => x * fu)));
    const r = ar(1.4), R = r * 0.92, X = new THREE.Vector3(...nz(v(H, endM))), Z = new THREE.Vector3(...(gax || uu));
    const Y = new THREE.Vector3().crossVectors(Z, X).normalize(); X.crossVectors(Y, Z);
    // the fingers' jaw by the hand, never by the pose: a swing turning the clip can't swap the thumb over
    // (the clip's shape is the hand's own — its side and the detail — so made once each and shared, never disposed, as
    // blobGeos: every pose sampled made its hands anew)
    const ck = side + ':' + POLY; let geo = clipGeos.get(ck); if (!geo) clipGeos.set(ck, geo = clipGeo(R, r * 0.36, r * 0.42, r * 1.05, -side));
    const m = new THREE.Mesh(geo, mat(SKIN));
    m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z)); m.position.set(...H); m.userData.hullGeo = geo; U.add(m);
  }
  const ARM_U = 4.9, ARM_F = 4.6; // art px: upper arm, forearm — every pose keeps the hand's reach within their sum
  function human(g, tc, o = {}){
    const Y = o.y || 0; // lift (a rider sits on the horse)
    const P = (x, y, z = 0) => [ax(x), chh(y) + Y, ar(z)];
    // Seen through its own eyes only the arms, hands and what they hold show (as in any first-person game): every
    // other body part is tagged here and collapses in the fp pose (rigPose).
    const fpTag = (grp, n, self) => (self ? [grp] : grp.children.slice(n)).forEach(o => o.traverse(c => { c.userData.fpHide = true; }));
    const g0 = g.children.length;
    // Legs: a tube from inside the hip down to the boot (astride: bowed out over the barrel).
    if (o.riding) for (const s of [-1, 1]) { // thigh curving out round the barrel, shin down the flank to the stirrup (rider() seats this on the horse); riderLeg
      const lg = riderLeg(s, o.riding);
      tube(g, LEG, P(...lg.hip), P(...lg.ctrl), P(...lg.foot), ar(1.15)); // short cartoon legs, as standing
      blob(g, BOOT, ...P(...lg.boot), ar(1.8), ar(1), ar(1.3));
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
      blob(U, armorMat(o.armor, o.metal || FORGE_STEEL[1], tc), ...P(0, -6), ar(4.6), ar(5), ar(4.2)).userData.body = 'torso';
    } else blob(U, tc, ...P(0, -6), ar(4.6), ar(5), ar(4.2)).userData.body = 'torso'; // torso
    fpTag(U, u0);
    let hn = H.children.length;
    blob(H, SKIN, ...P(0, -14), ar(4), ar(4), ar(4), HEAD_RES).userData.body = 'head'; // head (round at any detail: it's what you look at)
    if (o.hat !== 'great') eyes(H, ...P(0, -14), ar(4), ar(4), ar(4), 1, 0.12, 0.35, ar(0.5));
    if (ART_PROTO && o.hat !== 'great') { // prototype: a mouth and brows, the painted faces' character (no outline, as the eyes)
      const c = V3(P(0, -14)), R = ar(4), on = (dx, dy, dz) => c.clone().addScaledVector(new THREE.Vector3(dx, dy, dz).normalize(), R * 0.97), n0 = H.children.length;
      tube(H, '#7a3f2c', on(1, -0.3, -0.3).toArray(), on(1.05, -0.52, 0).toArray(), on(1, -0.3, 0.3).toArray(), ar(0.24));   // a small smile
      for (const s of [-1, 1]) blob(H, '#5a3d28', ...on(1, 0.5, s * 0.36).toArray(), ar(0.22), ar(0.2), ar(0.62));        // level brows
      for (const m of H.children.slice(n0)) delete m.userData.hullGeo;
    }
    fpTag(H, hn);
    for (const s of [-1, 1]) { // arms: an upper arm and a forearm of fixed length (ARM_U, ARM_F), one bendy tube
      const shA = [0, -8, s * (o.dress ? 3.4 : 3.9)], hand = local((o.hands && o.hands[s > 0 ? 1 : 0]) || [1, -2.4, s * 5.6]);
      if (o.dress && hand[0] < 3.5 && hand[1] > -9 && s * hand[2] > 0) hand[2] = s * Math.max(s * hand[2], 6.7); // hands at her sides hang clear of the skirt
      // The elbow (two-bone IK): where the two lengths meet, bent toward the pole —
      // out and down, a little back (clear of the torso); a hand reaching across the body blends it
      // forward, so the arm wraps round the chest (continuous: no flicker). o.elbows overrides.
      const eo = o.elbows && o.elbows[s > 0 ? 1 : 0]; let E = eo && local(eo);   // (an entry may be null: that arm's elbow solved)
      if (E && o.dress) E[2] += s * 1.2;
      const D = hand.map((v, i) => v - shA[i]), d = Math.hypot(...D), n = D.map(v => v / d);
      if (!E) {
        const cross = Math.max(0, Math.min(1, (1.5 - s * hand[2]) / 5)), pole = [-0.35 + 1.4 * cross, 0.5, s * (1.6 - 0.7 * cross)], pd = pole[0] * n[0] + pole[1] * n[1] + pole[2] * n[2];
        const q = pole.map((v, i) => v - pd * n[i]), qL = Math.hypot(...q) || 1;
        // a near hand shortens the arm a little (cartoon give) so it keeps a soft bend, never a folded one
        const Lu = Math.min(ARM_U, Math.max(3.2, d * 0.56)), a = Math.min(d, d / 2), h = Math.sqrt(Math.max(0, Lu * Lu - a * a));
        E = shA.map((v, i) => v + n[i] * a + q[i] / qL * h);
      }
      let bend = E.map((v, i) => 2 * v - (shA[i] + hand[i]) / 2);    // the hose passes through the elbow
      if (armProbe) armProbe.push({ s, ctl: [shA, bend, hand], d, dress: !!o.dress });   // dev: __povArmCheck
      const a0 = U.children.length;
      // A hand on one of o.holds (lines the hands grip: { at: art point | atM: model point, dir: model dir, open?: model dir
      // the clip opens to, hand?: 0 | 1 | [0, 1] — the hands the pose puts on it, always snapped; else any hand near it })
      // snaps onto it, the clip's hole along it. The forearm runs into the clip's back (as thick as it): one piece, no seam.
      let gax = null, Hm = P(...hand), endM = Hm, best = null;
      { const B = P(...bend), RH = ar(1.4);
        for (const h of o.holds || []) { const mine = h.hand == null ? null : [].concat(h.hand).includes(s > 0 ? 1 : 0); if (mine === false) continue;
          const Lp = h.atM ? (U === g ? h.atM : V3(h.atM).applyMatrix4(toU).toArray()) : P(...local(h.at)), d = V3(h.dir).transformDirection(toU).toArray(), k = Hm.reduce((a, v, i) => a + (v - Lp[i]) * d[i], 0);
          const c = Lp.map((v, i) => v + d[i] * k), dist = Math.hypot(...c.map((v, i) => v - Hm[i]));
          if ((mine || dist < ar(2.6)) && (!best || dist < best.dist)) best = { c, d, dist, open: h.open, h }; }
        let wf;   // the wrist's way out: from the forearm's end toward the ring's centre
        if (best && best.h.roll) { gax = best.d; Hm = best.c;   // a fist fixed round its handle: its back's side turns with the tool
          const R = best.h.roll[s > 0 ? 1 : 0], d = V3(best.h.dir).normalize(), e = V3(best.h.edge), n = new THREE.Vector3();
          e.addScaledVector(d, -e.dot(d)).normalize(); n.crossVectors(d, e);
          wf = e.multiplyScalar(R[0]).addScaledVector(n, R[1]).transformDirection(toU).toArray(); }
        else if (best) { gax = best.d; Hm = best.c;
          const fw = best.open ? V3(best.open).transformDirection(toU).toArray() : Hm.map((v, i) => v - B[i]), fd = fw.reduce((a, v, i) => a + v * gax[i], 0);
          // a grip along the forearm leaves the wrist's side unsteady: a constant lean (the wrist below the grip) keeps it
          // continuous — a switch to a fallback side flips the hand between frames
          const fwl = Math.hypot(...fw), up = [0, 1, 0].map((v, i) => v - gax[1] * gax[i]);
          const fp = fw.map((v, i) => v - fd * gax[i] + 0.35 * fwl * up[i]), fl = Math.hypot(...fp) || 1; wf = fp.map(v => v / fl); }
        else { const d = Hm.map((v, i) => v - B[i]), l = Math.hypot(...d) || 1; wf = d.map(v => v / l); } // (an empty hand: the ring on the hand point, as a holding one — arms keep the pose's length)
        endM = Hm.map((v, i) => v - wf[i] * RH * 1.2);   // (its round end sunk into the clip's back: one piece; a handle hides the overlap)
        if (best && best.h.roll) { // a fist fixed on its handle: the elbow drawn back along the wrist's line, so the forearm runs straight into it
          const k = UNIT_SCALE / PX, wr = [endM[0] / k, 5 - (endM[1] - Y) * HPX / UNIT_SCALE, endM[2] / k], wa = [wf[0] / k, -wf[1] * HPX / UNIT_SCALE, wf[2] / k], wl = Math.hypot(...wa) || 1;
          const E2 = E.map((v, i) => v + (wr[i] - wa[i] / wl * ARM_F * 0.8 - v) * 0.4);
          bend = E2.map((v, i) => 2 * v - (shA[i] + wr[i]) / 2); } }
      const emptyDangling = !best && hand[1] > -5; // hand dangling at waist/hips without a tool/weapon/hold
      const forcedHide = o.fpArmHide && o.fpArmHide.includes(s);
      const hideArm = forcedHide || emptyDangling;   // (an arm raised to a load on the shoulder stays: it holds it up in view)
      tube(U, SKIN, P(...shA), P(...bend), endM, ar(1.05));
      tube(U, tc, P(...shA), P(...bend), P(...hand), ar(1.45), 0, 0.22);    // the puffy sleeve: the tube's first stretch
      // first person shows active forearms; empty dangling or overhead arms collapse (fpHide)
      if (hideArm) {
        for (let i = 0; i < 6; i++) fpTag(U.children[a0 + i], 0, true);
      } else {
        U.children[a0].userData.fpForearm = true;
        U.children[a0].userData.fpSide = s;
        for (const i of [1, 3, 4, 5]) fpTag(U.children[a0 + i], 0, true);
      }
      legoHand(U, Hm, P(...bend), gax, endM, s);
      if (hideArm) fpTag(U.children[U.children.length - 1], 0, true);
      if (o.swingArm === s) for (const c of U.children.slice(a0)) c.traverse(q => { q.userData.fpSwing = true; });   // first person: this arm alone swings (rigPose)
    }
    const hat = o.hat; hn = H.children.length;
    if (hat === 'hair') blob(H, HAIR, ...P(-0.6, -15.6), ar(3.9), ar(3.2), ar(4.1), HEAD_RES); // (hair and helmets: the head's resolution, or its round skin shows through)
    if (hat === 'long') { // straight long hair: a smooth cap over the crown to the brow, and one curtain
      // falling from the brow to the shoulders all round, open at the front for the face.
      const hm = mat(HAIR, true), R = ar(4.35);
      const cap = new THREE.Mesh(own(new THREE.SphereGeometry(R, 20, 10, 0, 2 * Math.PI, 0, 1.2)), hm);
      cap.position.set(...P(-0.2, -14)); cap.userData.hullGeo = cap.geometry; H.add(cap);
      const top = chh(-14) + Y + R * Math.cos(1.2), bot = chh(-9.4) + Y, gap = 0.95;              // to the shoulders, not past them
      const cur = new THREE.Mesh(own(new THREE.CylinderGeometry(R * Math.sin(1.2), ar(4.4), top - bot, 20, 1, true, Math.PI / 2 + gap, 2 * Math.PI - 2 * gap)), hm);
      cur.position.set(ax(-0.2), (top + bot) / 2, 0); cur.userData.hullGeo = cur.geometry; H.add(cur);
    }
    if (hat === 'hood') blob(H, tc, ...P(-0.8, -16), ar(4.4), ar(3), ar(4.4), HEAD_RES); // a cap over the crown and back, the face left clear
    if (hat === 'spiked') { blob(H, '#b9bec6', ...P(-0.3, -15.8), ar(4.4), ar(3.6), ar(4.4), HEAD_RES); const sp = new THREE.Mesh(own(new THREE.ConeGeometry(ar(0.9), ar(3.4), 8)), mat('#b9bec6')); sp.position.set(...P(-0.3, -20.6)); sp.userData.hullGeo = sp.geometry; H.add(sp); }
    if (o.feather) { // Fletching's tell: a tall light-team plume pinned upright in the cap's crown, leaning back, a quill up the middle
      const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.quadraticCurveTo(-2.2, 3.6, -1.1, 7.6); sh.quadraticCurveTo(-0.1, 9.4, 1.4, 7.9); sh.quadraticCurveTo(1.7, 3.6, 0.9, 0.2);
      const geo = own(new THREE.ExtrudeGeometry(sh, { depth: 0.5, bevelEnabled: false, curveSegments: 6 }).translate(0, 0, -0.25).scale(ar(1), ar(1), ar(1)));
      const f = new THREE.Mesh(geo, mat(lightOf(tc))); f.position.set(...P(-1.2, -18.2)); f.rotation.set(o.flutter ? o.flutter[1] : 0, 0, 0.25 + (o.flutter ? o.flutter[0] : 0)); f.userData.hullGeo = geo; f.userData.hullW = HULL * 0.5; H.add(f); // o.flutter [lean, twist]
      pole(f, '#00000055', [ar(0.1), ar(0.4), 0], [ar(0.1), ar(7.4), 0], ar(0.12), 'line'); }
    if (hat === 'kettle') { blob(H, '#8f8a7d', ...P(0, -16), ar(3.9), ar(2.8), ar(3.9), HEAD_RES); blob(H, '#8f8a7d', ...P(0, -15.2), ar(5.6), ar(0.7), ar(5.6), HEAD_RES); }
    if (hat === 'norman') { blob(H, '#a8adb3', ...P(-0.3, -15.6), ar(4.5), ar(3.8), ar(4.5), HEAD_RES); blob(H, GOLD, ...P(-0.3, -15.2), ar(4.6), ar(0.9), ar(4.6), HEAD_RES); pole(H, '#a8adb3', P(4.2, -16), P(4.3, -12.5), ar(0.7)); }
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
  // The lines a soldier's hands grip (human's o.holds): the weapon's shaft, the bow's stave and the arrow at the string,
  // the shield's bar (the clip opening toward the shield)
  function soldierHolds(p, eq, bar, riding = false, poseFn = null, key = ''){   // poseFn(t), key: the action's pose over its cycle (a fixed grip)
    const hs = [];
    if (p.weapon) { // the weapon hand on its shaft; the other too when the pose puts it on the shaft (a spear's front hand)
      const w = V3(at(...p.weapon.hand)), d = V3(p.weapon.dir).normalize(), o = V3(at(...p.hands[0])).sub(w), off = o.addScaledVector(d, -o.dot(d)).length();
      const two = off < ar(1.5), e = p.weapon.edge;   // a blade: the fist fixed round its grip through the swing (gripRoll)
      hs.push({ at: p.weapon.hand, dir: p.weapon.dir, hand: two ? [0, 1] : 1,
        ...(e && poseFn && { edge: e, roll: gripRoll(key + two, t => { const q = poseFn(t); return { hands: q.hands, grip: q.weapon.hand, dir: q.weapon.dir, edge: q.weapon.edge || e }; }, two) }) }); }
    if (p.bow) { hs.push({ at: p.bow.grip, dir: [0, 1, 0], hand: 0 });   // the bow hand on the stave; the string hand on the arrow, while it holds one
      const g = at(...p.bow.grip), q = at(...p.bow.pull); if (p.bow.arrow || p.bow.fetched) hs.push({ at: p.bow.pull, dir: g.map((v, i) => v - q[i]), hand: 1 }); }
    if (bar && p.shieldHand) hs.push({ at: p.shieldHand, dir: [0, 1, 0], open: shieldFace(eq.shield, riding) });
    return hs;
  }
  // which way a held shield faces (model): a footman's forward, a rider's out over the horse's left flank
  const shieldFace = (kind, riding) => riding ? [Math.sin(RIDER_SHIELD_TURN), 0, -Math.cos(RIDER_SHIELD_TURN)] : kind === 'round' ? [1, 0, 0] : [Math.cos(0.3), 0, Math.sin(0.3)];
  // A shield hung from the bar its hand grips: the bar on the hand point H (model), the face toward F, two pegs to the boards
  function barShield(g, kind, H, F, tc){
    const round = kind === 'round', d = ar(round ? 2.1 : 1.6), y0 = round ? 0 : ar(0.5), k = round ? 0 : 2;
    const sh = round ? roundShield(g, [H[0] + F[0] * d, H[1] - y0, H[2] + F[2] * d], tc) : kiteShield(g, [H[0] + F[0] * d, H[1] - y0, H[2] + F[2] * d], tc);
    sh.rotation.y = round ? Math.atan2(-F[2], F[0]) : Math.atan2(F[0], F[2]);                      // (round faces its +x, the kite its +z)
    const pt = (y, z) => [0, y0 + y, 0].map((v, i) => i === k ? z : v);
    for (const y of [-1.9, 1.9]) pole(sh, '#5c3d24', pt(ar(y), -d), pt(ar(y), -d * 0.15), ar(0.45));
    pole(sh, '#5c3d24', pt(-ar(2.2), -d), pt(ar(2.2), -d), ar(0.7));
    return sh;
  }
  // The 2D sword in the round: a flat blade (parallel edges tapering to a
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
    // the back is the slab's own bottom cap, bare wood (both views) — a separate plane just behind it z-fought into a
    // white/wood flicker. Extrude's cap group holds the bottom cap's triangles first, then the top's (the face).
    const cap = geo.groups[0], half = cap.count / 2;
    geo.groups[0] = { start: cap.start, count: half, materialIndex: 2 }; geo.groups.push({ start: cap.start + half, count: half, materialIndex: 0 });
    const m = new THREE.Mesh(geo, [mat('#f5f5f0'), mat('#7a5230'), mat(SHIELD_BACK)]); m.position.set(...at3); m.userData.hullGeo = geo; g.add(m);
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
    cm.position.set(...H(-0.6, -6.2)); cm.scale.set(1, r(4.45), r(4.8)); cm.userData.hullGeo = cloth; cm.userData.fpHide = true; g.add(cm);   // (not seen from the saddle: a blue slab under the view)
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
    if (pose.bridle) { const nb = own(new THREE.TorusGeometry(r(1.95), r(0.32), 6, 18).rotateY(Math.PI / 2)), m = new THREE.Mesh(nb, mat(REIN)); m.position.set(r(5.3), -r(0.2), 0); m.userData.hullGeo = nb; head.add(m); } // the noseband the reins hang from
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
    const r = new THREE.Group(), strike = pose === 'strike';
    const hand = strike ? [9, -9, 6.5] : [6.5, -7, 6];
    const off = shield ? RIDER_SHIELD : [4.5, -6, -2.5];                         // shield grip, or the reins
    human(r, tc, { hat, riding: 1, hands: [off, hand] });
    sword(r, at(...hand), 0, strike ? [0.93, -0.3, 0.2] : [0.5, 0.84, 0.2]);
    if (shield) { const s = shieldOf({ shieldHand: off }, 'kite', true); kiteShield(r, at(...s.c), tc).rotation.y = s.th; }   // up and forward on the left
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
  // The trebuchet (render-units' trebParts, the 2D's own shape), ×1.5: art px x forward, y up, z across → world.
  // timber's inner edges: a dark brown, not the black ink (the silhouette's hull stays black)
  let _woodInk = null; const woodInk = () => _woodInk || (_woodInk = new THREE.LineBasicMaterial({ color: 0x3a2716 }));
  function trebModel(tc, pose = {}){
    const g = new THREE.Group(), f = ax(1, 1.5), P = v => v.map(c => c * f), root = g;
    // live (a set-up stage, trebLive moves them): the arm and the weight each in a group of its own, the straps kept rods
    const sub = {}; if (pose.live) for (const n of ['arm', 'cw']) { sub[n] = new THREE.Group(); sub[n].name = 'treb_' + n; sub[n].userData.live = true; root.add(sub[n]); }
    for (const q0 of trebParts(tc, pose)) { const q = q0, g = sub[q.g] || root;
      if (pose.live && q.strap) { const m = pole(root, q.col, P(q.rod[0]), P(q.rod[1]), q.r * f); m.name = 'treb_strap'; m.userData.live = true; m.userData.z = q.rod[0][2] * f; continue; }
      if (q.box) { const [x0, y0, z0, x1, y1, z1] = P(q.box); boxAt(g, topped(q.col, q.top), x0, z0, x1, z1, y0, y1, 'hull'); }
      else if (q.rod) pole(g, q.col, P(q.rod[0]), P(q.rod[1]), q.r * f);
      else if (q.prism) { const Q = q.prism.map(P), ctr = Q.reduce((a, v) => a.map((c, i) => c + v[i] / 8), [0, 0, 0]);   // its six faces from its corners (x·4 + y·2 + z)
        const faces = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]].map(ix => { const loop = ix.map(n => Q[n]);
          const fc = loop.reduce((a, v) => a.map((c, i) => c + v[i] / 4), [0, 0, 0]); return { loop, out: fc.map((c, i) => c - ctr[i]), holes: [] }; });
        solid(g, q.col, faces, q.col === tc ? {} : { line: woodInk() }); }   // (timber in brown ink; the team's weight in black)
      else if (q.ball) blob(g, q.col, ...P(q.ball), q.r * f, q.r * f, (q.rz || q.r) * f);
      else if (q.wheel) { const wg = new THREE.Group(); wg.position.set(...P(q.wheel)); wg.rotation.set(q.tilt || 0, 0, q.roll); g.add(wg);   // (tilt: a wreck's wheel tipped flat)
        wheel(wg, 0, 0, 0, q.r * f, q.w * f, '#33261a', '#5a4630');
        blob(wg, '#a8adb3', 0, 0, Math.sign(q.wheel[2]) * q.w * f / 2, 0.9 * f, 0.9 * f, 0.35 * f); }   // (its iron hub, on the outer face: the 2D's)
    }
    return root;
  }
  // A set-up stage's model (trebModel live, built at stage s0) moved to s: the arm turned on its axle, the weight slid,
  // each strap re-laid from the arm's tail to the weight's top (trebPack's, as trebParts lays them)
  function trebLive(obj, s0, s){
    const L = obj.userData.trebLive || (obj.userData.trebLive = { arm: obj.getObjectByName('treb_arm'), cw: obj.getObjectByName('treb_cw'), straps: [] });
    if (!L.straps.length) obj.traverse(o => { if (o.name === 'treb_strap') L.straps.push(o); });
    const f = ax(1, 1.5), H = TREB_AXLE * f, k0 = trebPack(s0), k = trebPack(s), d = k.arm - k0.arm;
    if (L.arm) { const c = Math.cos(d), sn = Math.sin(d); L.arm.rotation.z = d; L.arm.position.set(H * sn, H - H * c, 0); }   // (about the axle, (0, H))
    if (L.cw && k.cw && k0.cw) L.cw.position.set((k.cw[0] - k0.cw[0]) * f, (k.cw[1] - k0.cw[1]) * f, 0);
    if (!_tv1) { _tv1 = new THREE.Vector3(); _tv2 = new THREE.Vector3(); _tv3 = new THREE.Vector3(); }
    if (L.straps.length && k.cw) { const ca = Math.cos(k.arm), sa = Math.sin(k.arm), tail = [-TREB_ARM[1] * ca * f, (TREB_AXLE - TREB_ARM[1] * sa) * f];
      for (const m of L.straps) { const a = _tv1.set(tail[0], tail[1], m.userData.z), b = _tv2.set(k.cw[0] * f, k.cw[1] * f, m.userData.z), dv = b.sub(a), len = dv.length();
        m.position.copy(a).addScaledVector(dv, 0.5); m.scale.y = len; m.quaternion.setFromUnitVectors(_tv3.set(0, 1, 0), dv.normalize()); } }
  }
  let _tv1, _tv2, _tv3;
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
  // The trade cart (×1.32; render-units' cartRig2D projects this same model): an open team-walled bed on two spoked
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
    // The ox (×1.2): heavy barrel, shoulder hump, stocky tube legs stepping
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
  // A fist keeps its place round a handle (only the wrist bends, it never rolls round the grip): the side its back
  // faces, in the tool's own frame (dir, edge), fixed per action and hand. The two wrists sit either side of the handle
  // (side to side, not one over the other): the arms' mean reach turned ±80° round the handle, each out to its own side
  const gripRolls = new Map();
  function gripRoll(key, pose, pair = true){   // pair false: one hand on it, its wrist toward the arm's mean reach
    let r = gripRolls.get(key); if (r) return r;
    const d = new THREE.Vector3(), e = new THREE.Vector3(), n = new THREE.Vector3(), arm = new THREE.Vector3();
    let a = 0, b = 0, ez = 0, nz = 0;
    for (let i = 0; i < 16; i++) { const P = pose(i / 16);
      d.set(...P.dir).normalize(); e.set(...P.edge); e.addScaledVector(d, -e.dot(d)).normalize(); n.crossVectors(d, e); ez += e.z; nz += n.z;
      for (const hi of [0, 1]) { const h = P.hands[hi]; arm.set(h[0], -(h[1] + 8) * PX / HPX, h[2] - (hi ? 3.9 : -3.9)).normalize(); a += arm.dot(e); b += arm.dot(n); } }   // shoulder → hand (art → model axes)
    const th = Math.atan2(b, a), A = pair ? 80 * Math.PI / 180 : 0, side = q => Math.cos(q) * ez + Math.sin(q) * nz;   // (side: + = the right hand's, +z)
    const p = th + A, m = th - A, [left, right] = side(p) >= side(m) ? [p, m] : [m, p];   // (the wrist's way out points back toward its arm: the right fist's wrist on the left of the handle keeps the arms uncrossed)
    r = [[Math.cos(left), Math.sin(left)], [Math.cos(right), Math.sin(right)]];
    gripRolls.set(key, r); return r;
  }
  // a handle's grip end (rig px), back far enough to run through the fist; barrowHandle: that point in the pusher's
  // body frame (animFrame sets the rig at x 4.7 art px, half the body's bob up, ×1.25)
  const BARROW_H0 = [0.3, 9.62, 3.21];
  const barrowHandle = (z, bodyY) => { const K = v => v * UNIT_SCALE / PX; return [ax(4.7) + 1.25 * K(BARROW_H0[0]), bodyY * 0.5 + 1.25 * K(BARROW_H0[1]) - bodyY, z * 1.25 * K(BARROW_H0[2])]; };
  // The Wheelbarrow / Heavy Plow rig (render-units' barrowRig2D draws it in 2D): handles from the
  // villager's hands (9.2px up, ±3.1) forward to a wheel 22px ahead. The barrow
  // carries a wooden tray and the load in it; the plow swaps the tray for a
  // steel share cutting the soil. World px along +x, heights up from the ground.
  function barrowRig(g, kind, what){
    const b = new THREE.Group(), K = v => v * UNIT_SCALE / PX, wood = WOOD.plankL + '|planks'; g.add(b);
    b.scale.setScalar(1.25); b.position.x = K(1.8) * (1 - 1.25); // cartoon-big, scaled about the ground under the grips (the grips rise to 11.5)
    for (const z of [-1, 1]) pole(b, WOOD.beam, [K(BARROW_H0[0]), K(BARROW_H0[1]), z * K(BARROW_H0[2])], [K(22), K(3.6), z * K(1.6)], K(0.6)); // handles running to the axle ends, either side of the wheel
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
    human(g, tc, { hat: 'hair', hands: [[6.5, -6.5, -3.9], [6.5, -6.5, 3.9]], holds: [-1, 1].map((z, i) => ({ atM: barrowHandle(z, 0), dir: [20.2, -5.6, -z * 1.5], hand: i })) });
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
  // (LOAD_SIT, CARRY_HANDS: render-units — the carry is shared with the 2D)
  // the load held up on the palms: each fist open up into it, thumbs in toward each other
  const CARRY_HOLDS = CARRY_HANDS.map((h, i) => ({ at: h, dir: [0, 0, -Math.sign(h[2])], open: [0, 1, 0], hand: i }));
  const carrier = (tc, what) => { // the load resting on the head, hands up steadying it at the sides
    const g = new THREE.Group(), hs = CARRY_HANDS;
    human(g, tc, { hat: 'hair', hands: hs, holds: CARRY_HOLDS });
    load(g, what, at(0.3, -21.2)); return g;
  };
  // ---- Animation mock-up: poses from a phase t in [0,1) ----
  // walk: each foot planted and sliding back under the moving body through
  // its stance half, then lifting and swinging forward; the arms swing
  // opposite the legs; the body bobs twice a stride. chop: the hands travel
  // an arc out in front of the chest on the tool side — a slow wind-up, a
  // fast strike — the axe along the arc's radius (the arms' extension).
  const walkPose = villagerWalkPose;                                             // (render-units: one walk for both views)
  const easeC = u => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, u)))) / 2;
  const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
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
  // idle: breathing, the weight shifting, a slow look round.
  const idlePose = villagerIdlePose;
  // (runPose: render-units — the flee is shared with the 2D)
  // (villagerDeathPose, DIE: render-units — the death is shared with the 2D)
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
  const HEAD_REACH = 10 + GRIP_OUT;
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
  // Gear by age and the Blacksmith lines, shared with the 2D (soldierEquip):
  // helmet and shield by age; the torso by the armor line (tunic → scale →
  // chain); weapon steel by the attack line; the archer's fletching pin and
  // Castle-age quiver.
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
      m = new THREE.MeshLambertMaterial({ map: tex }); m.userData.armor = { kind, metal }; armorMats.set(key, m); tcSwaps.set(m, t => armorMat(kind, metal, t));
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
    pole(g, ARROW_SHAFT, N.toArray(), tip.toArray(), ar(0.35), 'line');
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
    for (const z of [-0.8, 0.8]) { pole(q, ARROW_SHAFT, [0, ar(3.6), ar(z)], [0, ar(5.6 + z * 0.25), ar(z)], ar(0.35), 'line'); if (fletched) blob(q, lightOf(tc), 0, ar(5.6 + z * 0.25), ar(z), ar(0.9)); } // shafts peeking out; the tech's light-team fletching
  }
  // One posed foot soldier (lab + game). Death uses the villager's staged fall,
  // the weapon (and shield) dropped beside the body.
  function soldierFrame(g, body, ut, kind, t, eq, tc, opt, who){   // eq.civ: a villager with the soldier's weapon (who: its hair and dress)
    const hat = eq.helmet === 'hood' ? 'hood' : eq.helmet;
    // the plume flutters: swaying at rest, streaming back on the march, whipping as the arrow's loosed
    const fl = kind === 'walk' ? [0.45 + 0.15 * Math.sin(4 * Math.PI * t), 0.25 * Math.sin(2 * Math.PI * t)] : kind === 'attack' && t > 0.75 ? [0.2 + 0.45 * Math.exp(-(t - 0.75) * 12) * Math.sin((t - 0.75) * 60), 0.3 * Math.sin((t - 0.75) * 40)] : [0.14 * Math.sin(4 * Math.PI * t), 0.2 * Math.sin(2 * Math.PI * t + 1)];
    const dress = eq.civ ? { ...who } : { hat, armor: eq.torso, metal: eq.metal, feather: eq.feather, flutter: fl };
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
    const swingArm = ut === 'militia' && eq.shield ? 1 : 0;   // first person: with a shield up, only the sword arm swings
    const barShieldOn = ut === 'militia' && eq.shield;   // (the shield hangs from a bar the clip holds)
    const fpArmHide = ut === 'militia' && !eq.shield ? [-1] : null;
    human(body, tc, { ...dress, hands: p.hands, elbows: p.elbows, torso: p.torso, headYaw: p.headYaw, feet: p.feet, swingArm, fpArmHide, holds: soldierHolds(p, eq, barShieldOn, false, kind === 'attack' && ut === 'militia' ? q => SOLDIER_POSE[ut](kind, q, eq) : null, ut + kind + !!eq.shield) });
    if (ut === 'militia') { const n0 = body.children.length; weaponTag(body, () => sword(body, at(...p.weapon.hand), eq.weapon, p.weapon.dir, p.weapon.edge));
      if (swingArm) for (const c of body.children.slice(n0)) c.traverse(q => { q.userData.fpSwing = true; });
      if (barShieldOn) weaponTag(body, () => barShield(body, eq.shield, at(...p.shieldHand), shieldFace(eq.shield), tc)); }
    if (ut === 'spearman') weaponTag(body, () => spearAt(body, at(...p.weapon.hand), p.weapon.dir, eq.metal));
    if (ut === 'archer') { const b = weaponTag(body, () => drawnBow(body, at(...p.bow.grip), at(...p.bow.pull), p.bow.draw));
      if (p.bow.arrow) arrowAt(body, b.P.toArray(), V3(at(...p.bow.grip)).sub(b.P).toArray(), eq.feather, tc);
      else if (p.bow.fetched) arrowAt(body, at(...p.bow.pull), V3(at(...p.bow.grip)).sub(V3(at(...p.bow.pull))).toArray(), eq.feather, tc);
      if (eq.quiver) { const q0 = body.children.length; quiver(body, tc, eq.feather); body.children.slice(q0).forEach(c => c.traverse(o => { o.userData.fpHide = true; })); } }
  }
  // ---- Cavalry: scout, knight ----
  // (the horse's gaits: horseGait, js/render-units.js — one gait for both views)
  const HORSE_COAT = { scout: ['#8b5a2b', '#3f2810', '#6e4520'], knight: ['#e9e6de', '#9a948a', '#b3ada1', '#b8b2a6'] };
  const REIN = '#4a2f1c';
  // Where the reins meet the noseband (cavalry frame, model): horseKit's head turned by the gait's nod, either side of the muzzle
  // and the path each rein takes back up the cheeks and over the crest beside the mane, where they meet for the one rein hand (clear of head and neck)
  function bitPoints(gait){
    const k = 1.35, a = -0.55 - (gait.nod || 0), c = Math.cos(a), sn = Math.sin(a), B = gait.bob || 0, P0 = [ax(10, k), chh(-14 - B, k)];
    const head = (lx, ly) => [P0[0] + ar(lx, k) * c - ar(ly, k) * sn, P0[1] + ar(lx, k) * sn + ar(ly, k) * c];
    return [-1, 1].map(z => ({ bit: [...head(5.3, -0.6), z * ar(2, k)], cheek: [...head(1.4, 0.8), z * ar(2.55, k)], neck: [ax(6.2, k), chh(-13.4 - B, k), z * ar(1.6, k)] }));
  }
  function riderFig(tc, eq, kind, t, gait = {}, bare = false){ // bare: no sword or shield (dropped) // rider()'s seat and kit, with gear by age and an animated sword arm
    const r = new THREE.Group(), o = riderPose(kind, t, eq, gait), { hand, dir, edge } = o.weapon;   // (render-units: shared with the 2D)
    const barShieldOn = !bare && eq.shield;   // (the shield hangs from a bar the clip holds)
    // the reins, from the bit to the rein fist (the shield fist on a knight); without a shield they run through the clip
    const org = [ax(-0.8), (20 - 6) * UNIT_SCALE / PX + (gait.riderLift || 0), 0], bits = gait.reins && bitPoints(gait).map(q => Object.fromEntries(Object.entries(q).map(([n, p]) => [n, p.map((v, i) => v - org[i])]))), fist = at(...o.hands[0]);
    const holds = bare ? null : soldierHolds({ ...o, shieldHand: o.hands[0] }, eq, barShieldOn, true, kind === 'attack' ? q => riderPose(kind, q, eq, {}) : null, 'rider' + kind + !!eq.shield);   // (the off hand sits apart with a shield: its own grip roll)
    if (bits && holds && !eq.shield) holds.push({ at: o.hands[0], dir: [0, 1, 0] });   // (an upright fist, open toward the bit: the reins leave through the gap)
    human(r, tc, { hat: eq.helmet, armor: eq.torso, metal: eq.metal, riding: o.riding, hands: o.hands, elbows: o.elbows, torso: o.torso, holds });
    // each rein, taut: up the cheek and over the crest, then to the fist (two cubics sharing the tangent at the neck — straight back
    // along it, no sideways lean: that pulled the far rein into the head)
    if (bits) for (const b of bits) { const T = V3(fist).sub(V3(b.neck)).setZ(0).normalize(), L1 = V3(b.neck).distanceTo(V3(b.bit)) * 0.35, L2 = V3(fist).distanceTo(V3(b.neck)) * 0.35;
      tube(r, REIN, b.bit, b.cheek, b.neck, ar(0.3), 0, 1, V3(b.neck).addScaledVector(T, -L1).toArray());
      tube(r, REIN, b.neck, V3(b.neck).addScaledVector(T, L2).toArray(), fist, ar(0.3), 0, 1, V3(fist).addScaledVector(V3(fist).sub(V3(b.neck)).normalize(), -L2).toArray()); }
    if (!bare) weaponTag(r, () => sword(r, at(...hand), eq.weapon, dir, edge));
    if (barShieldOn) weaponTag(r, () => barShield(r, eq.shield, at(...o.hands[0]), shieldFace(eq.shield, true), tc));
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
      const age = t * DIE_LAB.life, { skel, life } = DIE_LAB, cl = v => Math.max(0, Math.min(1, v));
      const h = chh(-6.2, 1.35), rideY = (20 - 6) * UNIT_SCALE / PX, land = [ax(-0.8) + 0.25, -0.72];   // barrel centre height; where the rider ends up
      const tg = new THREE.Group(); tg.userData.fade = age < skel ? 1 : cl((life - age) / 1500); g.add(tg);
      droppedItem(tg, age, [6.5, -21, 6.8], it => sword(it, [0, ar(2.7), 0], eq.weapon, [0, 1, 0]), [0.2, 0, 0.98], 0.3);   // from the sword hand, the right
      if (eq.shield) { const F = [0.15, 0, -0.99]; droppedItem(tg, age, [1, -20.5, -9], it => { if (eq.shield === 'kite') kiteShield(it, [0, ar(8.5), 0], tc).rotation.y = Math.atan2(-F[0], -F[2]); else roundShield(it, [0, ar(4.8), 0], tc).rotation.y = Math.atan2(F[2], -F[0]); }, F, 0.35); }
      if (age < skel) {
        const st = easeC(age / 300), u = cl((age - 250) / 550);
        let rot = (Math.PI / 2.1) * u * u; if (age > 800 && age < 1100) rot *= 1 + 0.07 * Math.sin((age - 800) / 300 * Math.PI);
        const kick = age > 900 && age < 1700 ? Math.max(0, Math.sin((age - 900) / 110 * Math.PI)) * (1 - (age - 900) / 800) : 0;
        const roll = new THREE.Group(); g.add(roll); roll.rotation.set(-rot, 0, -0.2 * st * (1 - u));              // pitched nose-down in the stumble, then over onto its −z flank
        const pose = { legs: [0, 1, 2, 3].map(i => i < 2 ? [-2.2 * u, 1.4 * kick * (i ? 0.6 : 1)] : [-1.8 * st * (1 - u) + 2.2 * u, 1.8 * st * (1 - u)]), bob: -1.4 * st * (1 - u) - 0.8 * u, nod: 0.5 * st, tail: 0.4 * kick };
        horseKit(roll, coat, mane, legC, tc, muzzle || legC, pose);
        roll.position.y = 0.12 * Math.sin(Math.min(rot, Math.PI / 2));
        // The rider leaves the saddle as the horse goes down: an arc off its falling side, turning over to land on his back.
        const v = cl((age - 150) / 650), rf = riderFig(tc, eq, 'die', v, {}, true); g.add(rf);
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
    horseKit(g, coat, mane, legC, tc, muzzle || legC, { ...gait, bridle: true });
    const lift = gait.bob * (kind === 'gallop' ? 0.55 : 0.85) * 1.35 * UNIT_SCALE / PX, r = riderFig(tc, eq, kind, t, { ...gait, reins: true, riderLift: lift }); r.position.y += lift; g.add(r); // the rider absorbs part of the horse's rise
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
    const g = new THREE.Group(), body = new THREE.Group(), tc = opt.tc || '#2d6bd1', who = female ? { hat: 'long', dress: 'tunic' } : { hat: 'hair' }; g.add(body);
    if (opt.unit === 'tradecart') { const cl = v => Math.max(0, Math.min(1, v)); let pose = { load: opt.load !== false };
      pose.tail = 0.7 * Math.sin(2 * Math.PI * t) * Math.max(0, Math.sin(Math.PI * t * 1)) + 0.25 * Math.sin(6 * Math.PI * t); // a lazy swish, now and then a flick
      if (kind === 'walk') pose = { ...pose, roll: 2 * Math.PI * t / 6, step: t, tail: 0.35 * Math.sin(4 * Math.PI * t) }; // one ox stride = a sixth of a wheel turn (its three spokes repeat every 60°)
      if (kind === 'die') { const age = t * DIE_LAB.life; g.add(cartModel(tc, { load: opt.load !== false, wreck: { age, weathered: age >= DIE_LAB.skel } })); g.userData.fade = age < DIE_LAB.skel ? 1 : cl((DIE_LAB.life - age) / 1500); // the sack spills only if it died loaded
        addHulls(g, true); fadeTo(g, g.userData.fade); return g; }
      g.add(cartModel(tc, pose)); addHulls(g, true); return g; }
    if (opt.unit === 'trebuchet') { // the game's pose rides opt.eq; the lab's comes from the action and its phase
      const eq = opt.eq, lab = kind === 'setup' ? { s: t < 0.45 ? t / 0.45 : t < 0.55 ? 1 : (1 - t) / 0.45 } :   // (setup: unpacking, a beat set up, packing again — as lab2d's loop)
         kind === 'attack' ? trebShot(t) : kind === 'walk' ? { s: 0 } : { s: 1, stone: true };
      const game = eq && (eq.p != null ? trebShot(eq.p) : { s: eq.s, stone: eq.s >= 1, live: !!eq.live });
      if (kind === 'die') { const age = t * DIE_LAB.life; g.add(trebModel(tc, { wreck: { age, weathered: age >= DIE_LAB.skel } })); // its collapse (trebWreck), weathered at the bones stage, then gone
        g.userData.fade = age < DIE_LAB.skel ? 1 : Math.max(0, Math.min(1, (DIE_LAB.life - age) / 1500)); addHulls(g, true); fadeTo(g, g.userData.fade); return g; }
      const pose = { ...(game || lab), roll: kind === 'walk' ? 2 * Math.PI * t / 4 : 0 };   // (walking: t is a quarter turn, its spokes' repeat)
      g.add(trebModel(tc, pose)); addHulls(g, true); return g; }
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
    if (opt.unit && SOLDIER_POSE[opt.unit]) { const eq = opt.eq || soldierEquip(opt.unit, 0, 0, 0, false); soldierFrame(g, body, opt.unit, kind, t, eq, tc, opt, who);
      addHulls(g, true); g.traverse(o => { if (o.userData.fade != null) fadeTo(o, o.userData.fade); }); return g; }
    const person = (p, holds) => human(body, tc, { ...who, hands: p.hands, elbows: p.elbows, torso: p.torso, headYaw: p.headYaw, feet: p.feet, holds });
    if (kind === 'walk' || kind === 'barrow' || kind === 'plow') { const p = walkPose(kind === 'plow' ? t : t); body.position.y = p.bob * UNIT_SCALE / PX;
      const push = kind !== 'walk', grips = [[6.5, -6.5, -3.9], [6.5, -6.5, 3.9]];
      // Walking with a tool: it rests on the right shoulder, held near the butt, the head behind; the other arm swings.
      const shoulder = kind === 'walk' && HELD, sh = [2.4, -9.2, 5.3];
      human(body, tc, { ...who, feet: p.feet, hands: push ? grips : shoulder ? [p.hands[0], sh] : p.hands, torso: kind === 'plow' ? { lean: 0.14 } : undefined,
        holds: push ? grips.map((gp, i) => ({ atM: barrowHandle(i ? 1 : -1, body.position.y), dir: [20.2, -5.6, -Math.sign(gp[2]) * 1.5], hand: i })) : shoulder ? [{ at: sh, dir: [-0.62, 0.76, 0.14] }] : undefined });   // (barrowRig's handles)
      if (shoulder) tool(body, HELD, at(...sh), [-0.62, 0.76, 0.14], { out: 4.4 }, [0, 0.3, 1]);
      if (push) { const r = barrowRig(g, kind, kind === 'barrow' && opt.load !== null ? LD : null); r.position.set(ax(4.7), body.position.y * 0.5, 0); } } // its grips out in front of the belly; load null: it rolls back empty
    if (kind === 'chop') { const p = chopPose(t); person(p, [{ at: p.grip, dir: p.dir, edge: p.edge, roll: gripRoll('chop', chopPose), hand: [0, 1] }]); tool(body, 'axe', at(...p.grip), p.dir, { out: GRIP_OUT, double: UP.double }, p.edge); }
    const work = { mine: ['pick', minePose], split: ['axe', splitPose], build: ['mallet', buildPose], farm: ['scythe', mowPose] }[kind];
    if (work) { const p = work[1](t); person(p, [{ at: p.grip, dir: p.dir, edge: p.edge, roll: gripRoll(kind, work[1]), hand: [0, 1] }]); tool(body, work[0], at(...p.grip), p.dir, { out: GRIP_OUT, mow: kind === 'farm', bright: UP.bright, double: UP.double }, p.edge); }
    if (kind === 'saw') { const p = sawPose(t);
      // turned across the front (local +x, the blade → world −z), then rolled about
      // the blade line so the frame tips back toward the villager and the teeth face the trunk
      const w = new THREE.Group(), roll = new THREE.Group(); body.add(w); w.add(roll);
      const sg = bowSaw(roll); sg.position.set(0, -chh(SAW_Y), 0);
      roll.position.y = chh(SAW_Y); roll.rotation.x = -SAW_TIP;
      w.rotation.y = Math.PI / 2; w.position.set(ax(SAW_X), 0, ar(SAW_Z - p.off));
      // both fists on the frame's top bar: its crown (bowSaw's at(11.5, −11)), along the saw, in the body's frame
      for (const o of [w, roll, sg]) o.updateMatrix();
      const M = w.matrix.clone().multiply(roll.matrix).multiply(sg.matrix), top = V3(at(11.5, -11)).applyMatrix4(M), along = new THREE.Vector3(1, 0, 0).transformDirection(M);
      const ah = at(...p.hands[0]), bh = at(...p.hands[1]), toB = along.clone().multiplyScalar(Math.sign(along.dot(V3(bh).sub(V3(ah)))) || 1);   // (thumbs toward each other along the bar)
      person(p, [{ atM: top.toArray(), dir: toB.toArray(), hand: 0 }, { atM: top.toArray(), dir: toB.clone().negate().toArray(), hand: 1 }]); }
    if (kind === 'carry') { const p = walkPose(t), lift = p.bob * UNIT_SCALE / PX; body.position.y = lift;
      human(body, tc, { ...who, feet: p.feet, hands: CARRY_HANDS, holds: CARRY_HOLDS });
      load(body, LD, at(0.3, -18.1 - LOAD_SIT[LD])).rotation.x = 0.08 * Math.sin(4 * Math.PI * t); }
    if (kind === 'forage') { const p = foragePose(t); person(p); if (p.berry) blob(body, '#cc3344', ...at(p.berry[0] + 0.8, p.berry[1] - 0.6, p.berry[2]), ar(1.1)); }
    if (kind === 'butcher' || kind === 'fight') { const p = (kind === 'fight' ? fightPose : butcherPose)(t); person(p, [{ at: p.knife, dir: kind === 'fight' ? p.kdir : p.kdir.map(v => -v), hand: 1 }]); /* (the butcher's ice-pick grip: the blade out of the little finger's end) */ knife(body, at(...p.knife), p.kdir); }
    if (kind === 'repair') { const p = repairPose(t); person(p, [{ at: p.grip, dir: p.dir, edge: p.edge, roll: gripRoll('repair', repairPose), hand: 1 }]); tool(body, 'mallet', at(...p.grip), p.dir, {}, p.edge); }
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
    unitKinds: { villager: null, militia: ['idle', 'walk', 'attack', 'die'], spearman: ['idle', 'walk', 'attack', 'die'], archer: ['idle', 'walk', 'attack', 'die'], scout: ['idle', 'walk', 'gallop', 'attack', 'die'], knight: ['idle', 'walk', 'gallop', 'attack', 'die'], ram: ['idle', 'walk', 'attack', 'die'], trebuchet: ['idle', 'walk', 'setup', 'attack', 'die'], tradecart: ['idle', 'walk', 'die'] },
    equip: soldierEquip,
    // Animals: built once, posed live by animateAnimal from a stand-in entity (their game path), one action at phase t.
    animals: { sheep: ['idle', 'walk', 'graze', 'die'], bear: ['idle', 'walk', 'attack', 'die'], dragon: ['sleep', 'wake', 'idle', 'walk', 'roar', 'breathe', 'die'] },
    animal: (kind, tc = VIL_TC, poly = 1) => { const p0 = POLY; POLY = poly; try { const g = ANIMAL_MODELS[kind](tc); addHulls(g, true); return g; } finally { POLY = p0; } },
    poseAnimal: (g, kind, action, t) => {
      g.position.set(0, 0, 0); g.rotation.set(0, 0, 0);
      if (action === 'die') { if (kind === 'dragon') dragonDeath(g, t * 3000); else deathPose(g, kind, t * 3000); return; }
      const walk = action === 'walk', att = action === 'attack' || action === 'roar' || action === 'breathe';
      // (wake: asleep, woken, and settling again, on a loop)
      const e = { utype: kind, id: 1, awake: action === 'wake' ? t > 0.2 && t < 0.8 : action !== 'sleep', path: walk ? [{ x: 0, y: 0 }] : [], target: att ? -1 : null, eatingGrass: action === 'graze',
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
    model: (btype, age = 0) => { teamAge = teamAge || [0, 0]; teamAge[1] = age; const b = BLDGS[btype], g = new THREE.Group();   // dev: a finished model, raw (overlap checks)
      MODELS[btype](g, { id: -1, type: 'building', btype, x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h, team: 1, complete: true, hp: 1, maxHp: 1, buildProgress: 1, buildTime: 1, gateProgress: 0 }); return { g, hull: HULL_MATS }; },
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
    // A finished building exactly as the map draws it at full health (refreshModel: the model, its outline shells, baked).
    finished: (btype, age = 0) => { teamAge = teamAge || [0, 0]; teamAge[1] = age; const b = BLDGS[btype], g = new THREE.Group();
      const e = { id: -1, type: 'building', btype, x: -b.w / 2, y: -b.h / 2, w: b.w, h: b.h, team: 1, complete: true, hp: 1, maxHp: 1, buildProgress: 1, buildTime: 1, gateProgress: 0 };
      MODELS[btype](g, e); addHulls(g); bakeStill(g); return g; },
    buildingTypes: [...Object.keys(MODELS), 'WALL', 'SWALL', 'GATE', 'SGATE'],
    kinds: ['idle', 'walk', 'flee', 'carry', 'barrow', 'chop', 'saw', 'mine', 'farm', 'plow', 'forage', 'butcher', 'build', 'repair', 'drop', 'fight', 'die'],
    frame: animFrame,
    // the same frame at the game's detail: poly 0.6 = a near unit (the rig), POLY_LOW = a far one (rig LOD)
    framePoly: (poly, ...a) => { const p0 = POLY; POLY = poly; try { return animFrame(...a); } finally { POLY = p0; } },
    POLY_GAME: 0.6, get POLY_LOW(){ return POLY_LOW; },   // (a getter: POLY_LOW is declared further down this closure)
    // the prop builders (icons.html poses tech and resource icons from them): the game's own parts, nothing new
    kit: () => ({ mat, blob, tube, pole, ball, round, rock, boxAt, tool, sword, spear, bow, roundShield, kiteShield, bowSaw, knife, flag, pennant,
      load, arrowAt, drawnBow, quiver, barrowRig, horseKit, wallModel, wallArms, addHulls, own, V3, ax, ar, chh, HANDLE, TOOL_STEEL, STEEL, GOLD, MODELS }),
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
      const root = new THREE.Group(); root.add(g); g.rotation.y = Math.PI / 2; root.position.set(ax(10) + 0.52, 0, 0); // lying on its side the body sits a hip-height off its origin: its back toward the villager, under the hands
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
    [0, 1, 2, 3].forEach(i => { const l = namedPart(model, 'leg' + i); l.rotation.z = (i < 2 ? -0.45 : 0.45) * p; l.position.y = l.userData.y0 ?? l.position.y; });
    const neck = namedPart(model, 'neck'); neck.rotation.set(0.25 * p, 0, -0.35 * p);
    model.traverse(o => { if (o.name === 'eye') o.visible = false; });                 // dead: the eyes close
    const jaw = namedPart(model, 'jaw'); if (jaw) jaw.rotation.z = -0.25 * p;
  }
  // A carcass being harvested (its hp is the food left, 100 → 0): the legs go
  // first, then the wool is pulled off bit by bit — the side facing up first — until only the simple
  // skeleton remains. The bones are built inside the body on the first dead
  // frame, so they roll with the fallen sheep.
  const carcassBones = new WeakMap();   // (a kept carcass model keeps its bones: made once a model)
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
    return { face, legs, puffs, sk, band: model.getObjectByName('band'), core: model.getObjectByName('core'), skull };
  }
  function harvestPose(model, bones, left){
    const wool = Math.max(0, Math.min(1, (left - 0.12) / 0.88)), bare = left < 0.12;
    bones.puffs.forEach((p, i) => { p.visible = i >= Math.round(bones.puffs.length * (1 - wool)); });
    bones.legs.forEach(o => { o.visible = left > 0.9; }); // the legs go first
    for (const o of [bones.core, ...bones.face]) o.visible = !bare;
    bones.band.visible = wool > 0.5;
    bones.sk.visible = bare; bones.skull.visible = bare;
  }


  // A cartoon bone lying flat: a shaft with a pair of round knobs at each end.
  function cartoonBone(g, a, b, r, col = '#e8e0cc'){
    pole(g, col, a, b, r);
    const d = V3(b).sub(V3(a)), n = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(r * 1.05);
    for (const e of [a, b]) for (const k of [-1, 1]) blob(g, col, e[0] + n.x * k, e[1], e[2] + n.z * k, r * 1.55);
  }
  // The ox's bones, sized from the ox itself (×1.2: barrel ±8px long,
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
      if (world && _uFr.fr) { _uFr.s.center.set(c.x + 0.5, 0.3, c.y + 0.5); if (!_uFr.fr.intersectsSphere(_uFr.s)) continue; } // (off screen: no model — a battlefield's dead outnumber the living in view)
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
    const ut = c.utype, mil = MIL3D.has(ut), opt = mil ? { unit: ut, eq: ut === 'ram' || ut === 'tradecart' || ut === 'trebuchet' ? null : soldierGear(c), noBlood: true } : { noBlood: true };
    if (ut === 'tradecart') opt.load = (c.carrying || 0) > 0;                  // the corpse keeps the load it died with
    const bones = age >= CORPSE_SKEL, lab = bones ? DIE_LAB.skel + 10 : Math.min(age, 1800), step = bones ? -1 : Math.floor(lab / 50);
    r.x = c.x + 0.5; r.z = c.y + 0.5;                                              // (where it lies: the rig's detail follows the distance, as a living unit's)
    if (RIG_UNITS(ut)) rigPose(r, 'die', lab / DIE_LAB.life, c.female, opt, teamColor(c.team), DIE_LAB.life / 50, false, null, true); // 50ms steps, blended
    else { const key = vilKey('die', step, c.female, opt), fr = vilFrame(key, 'die', (bones ? lab : step * 50) / DIE_LAB.life, c.female, opt, r);
      if (fr) useVilFrame(r, key, fr, teamColor(c.team)); }
    const cx = c.x + 0.5, cz = c.y + 0.5, fw = [Math.cos(-r.yaw), Math.sin(-r.yaw)];
    if (r.obj) { r.obj.position.set(cx, 0, cz); r.obj.rotation.y = r.yaw; if (bones) fadeTo(r.obj, Math.max(0, Math.min(1, (CORPSE_LIFE - age) / 3000))); }
    // The pool spreads from under his back (he falls backward: behind the feet), drying brown.
    // the pool: under his back (he falls backward), under the fallen horse (it rolls onto its −z flank, carrying the body over), none for the ram
    const cav = ut === 'scout' || ut === 'knight', side = [Math.sin(-r.yaw), -Math.cos(-r.yaw)];               // the model's −z in world
    const back = ax(12), hz = chh(-6.2, 1.35);
    r.blood.position.set(cav ? cx + side[0] * hz : cx - fw[0] * back, -HULL * 1.5, cav ? cz + side[1] * hz : cz - fw[1] * back);
    bloodPool(r.blood, age, cav ? 900 : DIE.land * 0.8, ar(cav ? 12 : 8.5)); if (isWoodVehicle(c)) r.blood.visible = false; // wrecks don't bleed
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
  // A cut sheaf's shape, made once and shared (its own materials only: each fades on its own)
  let sheafGeo = null;
  function cutSheaf(x, z, away){
    if (!sheafGeo) { const px = 1 / PX, H = 6 / HPX, st = [], hd = [], up = new THREE.Vector3(0, 1, 0);
      for (const k of [-1, 0, 1]) { const hk = H * (k ? 0.78 : 1), s = k * 2.5 * px * Math.SQRT1_2, dir = new THREE.Vector3(s, hk, -s), L = dir.length(), q = new THREE.Quaternion().setFromUnitVectors(up, dir.normalize());
        st.push([s / 2, hk / 2, -s / 2, 0.028, L, 0.028, q]); hd.push([s + dir.x * 0.035, hk + dir.y * 0.035, -s + dir.z * 0.035, 0.05, 0.09, 0.05, q]); }
      sheafGeo = [boxBatch(st, 'rod'), boxBatch(hd, 'ball')]; for (const gg of sheafGeo) gg.userData.own = false; }
    const g = new THREE.Group();
    g.add(new THREE.Mesh(sheafGeo[0], mat('#c9a227').clone())); g.add(new THREE.Mesh(sheafGeo[1], mat('#e8c84a').clone()));
    g.position.set(x, 0.03, z); scene.add(g);
    // tips over toward `away` (world xz angle): about the horizontal axis square to it
    sheaves.push({ g, axis: new THREE.Vector3(Math.sin(away), 0, -Math.cos(away)), age: 0 });
  }
  function updateSheaves(dt){
    for (let i = sheaves.length - 1; i >= 0; i--) { const s = sheaves[i]; s.age += dt;
      const u = Math.min(1, s.age / 0.45); s.g.quaternion.setFromAxisAngle(s.axis, (Math.PI / 2 - 0.1) * u * u * (s.age > 0.45 && s.age < 0.6 ? 1 - 0.06 * Math.sin((s.age - 0.45) / 0.15 * Math.PI) : 1));
      const f = Math.max(0, Math.min(1, (2.2 - s.age) / 0.8));
      for (const m of s.g.children) { m.material.transparent = f < 1; m.material.opacity = f; }
      if (s.age > 2.2) { scene.remove(s.g); for (const m of s.g.children) m.material.dispose(); sheaves.splice(i, 1); } }
  }
  // Wheat that gives way: stalks and heads bend away from any unit standing
  // among them (wheatPushers, set each frame) and spring back as it moves on.
  const wheatPushers = { value: null }; // WHEAT_PUSH × Vector4 [x, z, strength, radius], made in initShared
  const wheatMats = new Map(), WHEAT_PUSH = 16;
  function wheatMat(){
    const col = 'vc'; let m = wheatMats.get(col);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
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
  // Non-indexed geometries ([geo, colour] each) as one, the colour per vertex; the sources are freed.
  function tintJoin(list){
    let n = 0; for (const [g] of list) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3), c = new THREE.Color(); let o = 0;
    for (const [g, hex] of list) { const k = g.attributes.position.count; c.set(hex);
      pos.set(g.attributes.position.array, o * 3); nrm.set(g.attributes.normal.array, o * 3);
      for (let i = 0; i < k; i++) col.set([c.r, c.g, c.b], (o + i) * 3);
      o += k; g.dispose(); }
    const geo = own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }
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
  // The mining camp's shaft house (MCAMP, Feudal on). Its live parts are 'anim' groups (animateModels).
  const fireMats = new Map(), fireMat = col => fireMats.get(col) || fireMats.set(col, new THREE.MeshBasicMaterial({ color: col })).get(col);
  const animPart = (o, f) => { o.name = 'anim'; o.userData.anim = f; return o; };
  function shaftHouse(g, e){
    const { b0, wH, Yr, Yc, rc, ho, H, wr, wy, po, lo, hi } = SHAFT, TW = '#b89868', grp = () => new THREE.Group();
    const cx = e.x + SHAFT.cx, cz = e.y + SHAFT.cz, hw = SHAFT.hw, X0 = cx - hw, X1 = cx + hw, Z0 = cz - hw, Z1 = cz + hw;
    boxAt(g, '#a89f8e|rough', X0 - 0.03, Z0 - 0.03, X1 + 0.03, Z1 + 0.03, 0, b0);                       // the stone floor
    const pr = 0.022, bt = 0.044;   // open all round: four corner posts, a ring of beams under the eaves
    for (const px of [X0 + pr, X1 - pr]) for (const pz of [Z0 + pr, Z1 - pr]) boxAt(g, TW, px - pr, pz - pr, px + pr, pz + pr, b0, wH - 0.04);
    for (const [a0, c0, a1, c1] of [[X0, Z0, X1, Z0 + bt], [X0, Z1 - bt, X1, Z1], [X0, Z0 + bt, X0 + bt, Z1 - bt], [X1 - bt, Z0 + bt, X1, Z1 - bt]]) boxAt(g, TW, a0, c0, a1, c1, wH - 0.04, wH);
    // the roof: hipped up to the collar, an open timber box round the shaft's way out
    const sk = frustumFaces(cx, cz, (hw + SHAFT.ov) * Math.SQRT2, rc * Math.SQRT2, Yr - wH, 4, 0, false).filter(q => Math.abs(q.out[1]) < 0.5);
    for (const q of sk) q.loop = q.loop.map(([px, py, pz]) => [px, py + wH, pz]);
    solid(piece(g), teamColor(e.team) + '|shingles', sk);
    const hd = piece(g), cf = boxFaces(cx - rc, cz - rc, cx + rc, cz + rc, Yr - 0.03, Yc);   // the head-frame: one drop-in
    solid(hd, TW + '|planks', [cf.x0, cf.x1, cf.z0, cf.z1], { T: rc - ho, depth: rc - ho, top: 0 });
    const lb = 0.105, lt = 0.07, leg = (sx, sz, y) => { const r = lb + (lt - lb) * (y - Yc) / (H - Yc); return [cx + sx * r, y, cz + sz * r]; };
    const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]], yb = (Yc + H) / 2;
    for (const [sx, sz] of cs) pole(hd, TW, leg(sx, sz, Yc), leg(sx, sz, H), 0.022);
    cs.forEach(([sx, sz], i) => { const [tx, tz] = cs[(i + 1) % 4]; pole(hd, TW, leg(sx, sz, yb), leg(tx, tz, yb), 0.014); });   // (one brace ring)
    boxAt(hd, TW + '|planks', cx - 0.1, cz - 0.1, cx + 0.1, cz + 0.1, H, H + 0.035);                        // the cap
    for (const s of [-1, 1]) boxAt(hd, TW, cx - 0.025, cz + s * 0.035, cx + 0.025, cz + s * 0.065, H + 0.035, wy + 0.02);   // bearing blocks, the axle through them
    pole(hd, '#3a3027', [cx, wy, cz - 0.075], [cx, wy, cz + 0.075], 0.012);
    if (!e.complete) return;
    boxAt(g, '#14110e', cx - po, cz - po, cx + po, cz + po, b0, b0 + 0.003, false);      // the pit
    // its fire: a breathing glow, flames licking up, smoke rising through the tower
    const glow = new THREE.Mesh(own(new THREE.PlaneGeometry(po * 1.2, po * 1.2).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ color: '#ff8a2a' }));
    glow.position.set(cx, b0 + 0.005, cz); g.add(animPart(glow, (o, t) => { const k = 0.6 + 0.4 * Math.sin(t * 0.08) * Math.sin(t * 0.031); o.material.color.setRGB(1, 0.3 + 0.3 * k, 0.06 * k); }));
    for (const [dx, dz, fh, col, ph] of [[-0.05, -0.03, 0.09, '#ff7a1a', 0], [0.05, 0.04, 0.11, '#ffb02e', 2], [0, 0, 0.15, '#ffd44a', 4], [-0.03, 0.05, 0.08, '#ff7a1a', 1], [0.05, -0.05, 0.08, '#ff7a1a', 3]]) {
      const fl = new THREE.Mesh(own(new THREE.ConeGeometry(0.036, 1, 6).translate(0, 0.5, 0)), fireMat(col)); fl.position.set(cx + dx, b0, cz + dz);
      g.add(animPart(fl, (o, t) => { o.scale.y = fh * (0.75 + 0.25 * Math.sin(t * 0.21 + ph) + 0.12 * Math.sin(t * 0.47 + ph * 2)); }));
    }
    (g.userData.smoke = g.userData.smoke || []).push([cx, b0 + 0.14, cz]);
    // the wheel turns as its rope winds: the bucket up out of the pit to under the cap, a pause, back down
    const wg = animPart(grp(), (o, t) => { o.rotation.z = -shaftLift(t) * (hi - lo) / wr; }); wg.position.set(cx, wy, cz); hd.add(wg);   // (in the head-frame: they go with it)
    const rim = new THREE.Mesh(own(new THREE.TorusGeometry(wr, 0.02, 6, 24)), mat('#a08058')); rim.userData.hullGeo = rim.geometry; wg.add(rim);
    for (const an of [0, Math.PI / 2]) pole(wg, '#c8a87a', [-Math.cos(an) * wr, -Math.sin(an) * wr, 0], [Math.cos(an) * wr, Math.sin(an) * wr, 0], 0.013);
    const lift = animPart(grp(), (o, t) => { const y = lo + shaftLift(t) * (hi - lo); o.children[0].position.y = y; o.children[1].position.y = y + 0.1; o.children[1].scale.y = wy - wr - y - 0.1; });
    lift.position.set(cx, 0, cz); hd.add(lift);
    const bk = grp(); lift.add(bk); round(bk, '#5c4430', 0, 0, 0.055, 0.062, 0, 0.1, 10, true, '#e8b90f');
    const rope = grp(); lift.add(rope); pole(rope, '#3a3027', [0, 0, 0], [0, 1, 0], 0.005);
    g.traverse(o => { if (o.userData.anim) o.userData.anim(o, 0); });   // (posed at rest: a site or a damaged camp stands still)
  }
  function campHut(g, e, wallCol, roofCol){
    const s = 20 / 32, wallH = 14 / HPX, box = [e.x + 1 - s, e.y, e.x + 1, e.y + s];
    if (e.id < 0) patch(g, '#8a7252|soil', e.x, e.y, e.x + 1, e.y + 1); // drawCampClearing: packed dirt over the whole tile (in the world: the ground's own)
    const f = boxFaces(...box, 0, wallH);
    if (!e.complete || e.openTop) delete f.top;                       // (a site: open till its roof goes on; a damaged one, open under it)
    f.x1.holes.push(hole('x1', box, 0.5, SILL, s / 4, 8 / HPX));
    solid(g, wallCol, Object.values(f));
    // 'peaked' block roof: in the art's projection its apex sits roofH + bhh
    // (8 + 10px) above the wall top — a pyramid on the block's own corners.
    // (Dark: a thatched hip, the turned straw roof on four sides over the block's corners)
    const dark = ageOf(e) === 0, rise = (dark ? 24 : 18) / HPX;
    if (dark) thatchCone(piece(g), (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, (box[2] - box[0]) * Math.SQRT1_2 + 0.07, wallH - 0.05, rise + 0.05, 4, Math.PI / 4);
    else pyramid(piece(g), roofCol, ...box, wallH, rise);
    if (e.complete) pennant(g, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, wallH + rise, teamColor(e.team));   // (the apex: eave + rise + wallH − eave)
  }

  // A building is some 50 parts (and as many outline shells): 50+ draw calls each, most of a crowded view's. Its still
  // parts are merged by material (bakePose, as the cached poses) into a handful; what moves — flags, the mill's
  // sails, a stable's horses — is lifted out first and put back as it was (its outline shells ride with it: children).
  // An animal is ~50 draw calls (every blob and its outline shell), posed by its named pivots (body, legs, neck, head,
  // tail). Under each pivot, the unnamed rigid pieces (and their shells) merge by material in the pivot's own frame,
  // so they still move with it; anything named (a puff, an eye, a band) stays its own mesh for the code that finds it.
  // (The dragon keeps its parts: its wings' membranes are rebuilt live.)
  function bakeRigid(g, loose = null, merge = false){ // loose: names that may merge too (a living sheep's wool puffs: only a carcass is plucked)
    const plain = o => (!o.name || (loose && loose.has(o.name))) && !o.userData.live && (o.isMesh || o.isLineSegments) && !Array.isArray(o.material) && o.children.every(plain); // (live: moved or reshaped every frame on its own)
    const nodes = []; g.traverse(o => { if (!o.isMesh && !o.isLineSegments) nodes.push(o); });
    for (const n of nodes) {
      const parts = n.children.filter(c => c.isMesh && plain(c));
      if (parts.length < 2) continue;
      const tmp = new THREE.Group(); for (const c of parts) { n.remove(c); tmp.add(c); }   // (tmp at identity: the parts keep their frame in n)
      const baked = bakePose(tmp, merge);
      tmp.traverse(o => { if (o !== tmp && o.geometry && o.geometry.userData.own && !o.geometry.userData.kept) o.geometry.dispose(); });
      for (const c of baked.children.slice()) { if (c.geometry && c.geometry.userData.baked) c.geometry.userData.own = true; n.add(c); }
    }
  }
  const SHEEP_LOOSE = new Set(['puff']);
  // An animal at the game's detail (as a unit's rig: 0.6) — the lab's full detail made a sheep 12k triangles, most of it
  // twenty wool puffs; the outlines follow the same spheres.
  function animalModel(kind, tc){ const p0 = POLY; POLY = 0.6; try { return ANIMAL_MODELS[kind](tc); } finally { POLY = p0; } }
  function bakeStill(g){
    const live = []; g.traverse(o => { if (o.name === 'flag' || o.name === 'sails' || o.name === 'pennant' || o.name === 'portcullis' || o.name === 'cloth' || o.name === 'plate' || o.name === 'hoist' || o.name === 'anim') live.push(o); else if (o.name === 'horseNeck' && o.parent && o.parent !== g) live.push(o.parent); });
    const lift = live.filter(o => !live.some(p => p !== o && p.getObjectById(o.id)));   // (outermost only)
    g.updateMatrixWorld(true);
    const hold = new THREE.Group(); hold.updateMatrixWorld(true);
    // (a moving part merged too: round its own pivots — a horse's neck, head, tail — or whole, as the sails that only turn)
    for (const o of lift) { hold.attach(o); if (o.name === 'cloth' || o.name === 'plate') continue; if (o.name === 'sails' || o.name === 'portcullis') bakeWhole(o); else if (o.name === 'hoist' || o.name === 'anim') o.children.forEach(c => bakeRigid(c, null, true)); else bakeRigid(o, null, true); }   // (a hoist: its rope and its log, each moving on its own)
    bakeWhole(g);
    for (const o of lift) g.attach(o);
  }
  // A finished building's still parts never move: their matrices made once, not recomposed by three every frame (a town
  // is hundreds of them). Its moving parts (bakeStill's live ones, a horse) keep updating, under their frozen parents.
  const LIVE_PARTS = new Set(['flag', 'sails', 'pennant', 'portcullis', 'cloth', 'plate', 'hoist', 'anim']);
  function freezeStill(g){
    const f = o => { if (LIVE_PARTS.has(o.name) || o.children.some(c => c.name === 'horseNeck')) return;
      o.matrixAutoUpdate = false; o.updateMatrix(); o.children.forEach(f); };
    f(g); g.updateMatrixWorld(true);
  }
  function bakeWhole(g){
    const baked = bakePose(g, true);
    g.traverse(o => { if (o !== g && o.geometry && o.geometry.userData.own && !o.geometry.userData.kept) o.geometry.dispose(); });
    for (const c of g.children.slice()) g.remove(c);
    for (const c of baked.children.slice()) { if (c.geometry && c.geometry.userData.baked) c.geometry.userData.own = true; g.add(c); } // (own: dropSolid frees it)
  }
  // (models the same in every age: an age-up re-keyed every farm and market, rebuilt for nothing)
  const AGELESS = new Set(['FARM', 'MARKET']);
  function refreshModel(e){
    const hurt = isHurt(e);
    const key = (AGELESS.has(e.btype) ? '-' : ageOf(e)) + ':' + teamColor(e.team) + ':' + (e.w || 0) + 'x' + (e.h || 0) + ':' + (e.complete ? 1 : 0) + (hurt ? ':hurt' : '')
      + (e.btype === 'FARM' ? ':' + farmStandingLive(e).map(Number).join('') : e.btype === 'HOUSE' ? ':' + (houseFlush(e) || []).map(Number).join('') : '');
    let rec = solids.get(e.id);
    // (a standing farm whose crop alone changed: the crop's geometry is swapped, the model stays)
    if (rec && rec.crop && rec.key !== key && e.complete && !hurt && !rec.site && !rec.dmg && rec.key.slice(0, rec.key.lastIndexOf(':')) === key.slice(0, key.lastIndexOf(':'))) {
      if (rec.crop.geometry.userData.crop) cropSync(e, rec.crop.geometry);
      else { rec.crop.geometry.dispose(); rec.crop.geometry = farmCrop(e); const c = centerOf(e); levelGeo(rec.obj, c.x, c.y); }   // (the first change since its bake merged it: a crop of its own)
      rec.key = key; }
    if (!rec || rec.key !== key) {
      if (bldSpent > BLD_MS) { bldLeft = true; return; }   // (as refreshWall)
      const tb = performance.now();
      if (rec) { if (rec.site && e.complete) siteDone(e); dropSolid(rec); }
      const g = new THREE.Group();
      MODELS[e.btype](g, hurt ? { ...e, openTop: true } : e); g.userData.bid = e.id; // (the world view's click picks it by this; a damaged one open under its roof)
      footPlate(g, e);
      addHulls(g);
      if (e.complete && !hurt) { bakeStill(g); const c = centerOf(e); levelGeo(g, c.x, c.y); freezeStill(g); }   // (a site, or a damaged one, stays in parts: constructionSite reads each wall's depth)
      scene.add(g);
      const flags = [], horses = [];
      g.traverse(o => {
        if (o.name === 'flag') flags.push(o);
        if (o.name === 'horseNeck') horses.push({ neck: o, head: o.getObjectByName('horseHead'), tail: o.parent.getObjectByName('horseTail'), seed: o.parent.userData.horseSeed });
      });
      const pennants = [], cloths = [], hoists = [], anims = []; g.traverse(o => { if (o.name === 'anim') anims.push(o); if (o.name === 'pennant') pennants.push(o); if (o.name === 'cloth') cloths.push(o); if (o.name === 'hoist') hoists.push(o); });
      rec = { obj: g, key, cloths, crop: e.btype === 'FARM' ? g.children.find(c => c.material === wheatMat()) : null, sails: g.getObjectByName('sails'), flags, horses, pennants, hoists, anims, smoke: g.userData.smoke, trainees: (g.userData.trainees || []).map(t => ({ ...t, obj: null, key: '' })), roof: e.complete && g.userData.roof ? g.userData.roof.map(p => ({ ...p, obj: null, key: '' })) : null, yard: g.userData.yard ? g.userData.yard.map(p => ({ ...p, obj: null, key: '' })) : null, portcullis: g.getObjectByName('portcullis'), team: e.team, age: ageOf(e) };
      if (!e.complete) { const b = BLDGS[e.btype]; rec.site = constructionSite(g, e.x, e.y, e.w || b.w, e.h || b.h, !OPEN_SITE.has(e.btype)); rec.siteOf = e.id; }
      else if (hurt) { const b = BLDGS[e.btype]; rec.dmg = buildingDamage(g, e.x, e.y, e.w || b.w, e.h || b.h); rec.dmg.jump(Math.min(DMG_FROM, e.hp / e.maxHp)); }
      solids.set(e.id, rec);
      bldSpent += performance.now() - tb;
    }
  }
  const OPEN_SITE = new Set(['MARKET', 'FARM']); // open ground (a plaza, a field): no scaffold, the stalls / crops just come up
  // a finished building hurt enough to show it (a farm is worn out, not broken)
  const isHurt = e => e.complete && e.btype !== 'FARM' && e.hp < e.maxHp * DMG_FROM;
  // ---- A construction site: the finished model rising from the ground (cut at the build height, never squashed — the
  // roof, windows and door keep their shape), inside a scaffold whose work deck rides
  // the cut. g: a finished, baked model; its footprint (x0, z0, w, h). Returns { set(progress 0..1) }.
  let siteWood = null;
  const SITE_LIVE = new Set(['flag', 'flagPole', 'pennant', 'sails', 'millShaft', 'goods', 'plate', 'hoist', 'anim']); // a site's parts with their own life: never merged
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
  // By SHAPE: the same wall on another tile is the same slabs, moved (the strips' grid, COL, divides a tile, so it
  // moves with them) — a town of one kind of house under fire cuts its walls once, not once a house.
  const thickCache = new Map();
  function thickGeo(faces, D, nMats, jag = false, wallSpec = null){
    if (faces.some(f => f.smooth)) return thickGeoMake(faces, D, nMats, jag, wallSpec);
    let ox = Infinity, oz = Infinity; for (const f of faces) for (const p of f.loop) { if (p[0] < ox) ox = p[0]; if (p[2] < oz) oz = p[2]; }
    ox = Math.floor(ox); oz = Math.floor(oz);
    const r = v => Math.round(v * 1e4), at = p => r(p[0] - ox) + ',' + r(p[1]) + ',' + r(p[2] - oz);
    const key = D + '|' + nMats + '|' + jag + '|' + (wallSpec ? wallSpec.top : '') + '|' + faces.map(f => f.loop.map(at).join(';') + '>' + f.out.join(',') + '>' + (f.mat || 0) + (f.cut ? 'c' : '') + (f.lining ?? '') + '>' + (f.holes || []).map(h => at(h.at) + ':' + r(h.w) + ':' + r(h.h)).join(';')).join('/');
    let g = thickCache.get(key);
    if (!g) { const sh = p => [p[0] - ox, p[1], p[2] - oz];
      thickCache.set(key, g = thickGeoMake(faces.map(f => ({ ...f, loop: f.loop.map(sh), holes: (f.holes || []).map(h => ({ ...h, at: sh(h.at) })) })), D, nMats, jag, wallSpec)); }
    return g.clone().translate(ox, 0, oz);
  }
  function thickGeoMake(faces, D, nMats, jag, wallSpec){
    const buckets = Array.from({ length: nMats }, () => []), body = wallBody(faces, D);
    const UP = new THREE.Vector3(0, 1, 0);
    // s: each corner's slide (rising 1 per unit: wallBody.slide) — a site presses it down along that
    // lin: a wall back's lining (its material above the deck: the slicing below sends it there), -1 none
    // floor: a cut storey's cap's foot (its cap shows only past it: see the site shader), -1 none
    const put = (b, p0, p1, p2, want, clip, nf, inside = 0, s = [UP, UP, UP], lin = -1, floor = -1) => {
      const n = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0));
      if (n.lengthSq() < 1e-14) return;
      if (n.dot(want) < 0) { n.negate(); [p1, p2] = [p2, p1]; s = [s[0], s[2], s[1]]; }
      n.normalize();
      [p0, p1, p2].forEach((q, i) => b.push(q, nf ? nf(q) : n, clip + 2 * inside + 4 * (lin + 1), s[i], floor));        // (clipOnly | inner face << 1 | lining+1 << 2)
    };
    const top = Math.max(...faces.flatMap(f => f.loop.map(p => p[1])));
    // (a thick wall's back above its deck is outdoors, lit as the finished one's; only below it the inside, in shade — a
    // merlon's back was dark)
    const deckY = wallSpec ? body.deckY : -Infinity;
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
      const cl = f.cut ? 1 : 0;   // (cut: a site cuts this wall at its build line, not pressing it down — a storey over another's)
      const holes = wall ? (f.holes || []).map(h => { const c = to2(V3(h.at)); return [[c.x - h.w / 2, c.y], [c.x + h.w / 2, c.y], [c.x + h.w / 2, c.y + h.h], [c.x - h.w / 2, c.y + h.h]].map(q => new THREE.Vector2(...q)); }) : [];
      const all = contour.concat(...holes), tris = THREE.ShapeUtils.triangulateShape(contour, holes);
      if (!wall) { for (const [i0, i1, i2] of tris) put(b, to3(all[i0]), to3(all[i1]), to3(all[i2]), n, 1); continue; }
      // the inner face straight in (level), not along a leaning wall's tilted facing: both faces keep every height, so a
      // tapered wall's (the mill's) inner rim rises in step with its outer one
      const nh = new THREE.Vector3(n.x, 0, n.z).normalize(), inset = p => body.inset(p, nh), back = n.clone().negate();
      const sd = v.clone().divideScalar(v.y);   // (a leaning wall presses down along its lean: its cut stays on it, exact)
      const nf = f.smooth ? q => f.smooth(q).clone() : null, nb = f.smooth ? q => f.smooth(q.clone().addScaledVector(nh, D)).clone().negate() : null;
      const tB = wallSpec ? buckets[wallSpec.top] : b, lin = wallSpec ? f.lining ?? f.mat ?? 0 : -1;   // (the solid's top, its back's lining: as the finished one's)
      const S = p => body.slide(p, sd);
      for (const [i0, i1, i2] of tris) { const A = to3(all[i0]), B = to3(all[i1]), C = to3(all[i2]), s3 = [S(A), S(B), S(C)];
        put(b, A, B, C, n, cl, nf, 0, s3); put(b, inset(A), inset(B), inset(C), back, cl, nb, 1, s3, lin); }
      // face → inset quads: along the outline (facing out, in the face's plane) and round each opening (facing into it)
      const quad = (bb, a, c, w, ins, clp = cl, floor = -1) => { const sa = S(a), sc = S(c); put(bb, a, c, inset(c), w, clp, null, ins, [sa, sc, sc], -1, floor); put(bb, a, inset(c), inset(a), w, clp, null, ins, [sa, sc, sa], -1, floor); };
      const foot = Math.min(...pts.map(p => p.y));
      for (let k = 0; k < contour.length; k++) { const a = pts[k], c = pts[(k + 1) % pts.length], w = body.outward(contour, k, u, v), sh = body.shared(a, c);
        // (a shared edge is inside the body — a corner, a storey's foot — but a storey's top seam is its cap while it rises)
        if (sh && (Math.abs(a.y - c.y) > 1e-6 || w.y < 0.5)) continue;
        // its top: pressed down to the build line as its cap — a cut wall's too (cut, it was gone: the wall stood open),
        // from its own foot up. Rising, it is the wall's own cut; a ruin's is its broken top (the solid's, a rim's planks).
        if (w.y >= 0.5) quad(sh || !jag ? b : tB, a, c, w, 0, 0, cl && foot > 1e-4 ? foot : -1);
        else quad(w.y < -0.5 ? b : tB, a, c, w, 0); }
      for (const h of holes) { const loop = h.map(to3), hc = loop[0].clone().add(loop[2]).multiplyScalar(0.5);   // (an opening's sides: in the shade too)
        for (let k = 0; k < 4; k++) { const a = loop[k], c = loop[(k + 1) % 4]; quad(b, a, c, hc.clone().sub(a.clone().add(c).multiplyScalar(0.5)), 1); } }
    }
    // Sliced into thin horizontal bands: pressing a triangle's upper corners straight down is exact only for one that
    // doesn't reach far past the build height (a long diagonal one — round a window, up a gable — would open a gap).
    const geo = new THREE.BufferGeometry(), pos = [], nrm = [], clip = [], inside = [], slide = [], BAND = jag ? 0.04 : 0.015, COL = 0.1; // (a broken top needn't be as fine as a rising one)
    const cut = (poly, y, keepAbove, ax = 'y') => { const out = [];              // a convex polygon's part above / below y (along ax)
      const lo = (a, c) => a.p[ax] < c.p[ax] || (a.p[ax] === c.p[ax] && (a.p.x < c.p.x || (a.p.x === c.p.x && a.p.y < c.p.y)));
      for (let k = 0; k < poly.length; k++) { const a = poly[k], c = poly[(k + 1) % poly.length], ia = keepAbove ? a.p[ax] >= y : a.p[ax] <= y, ic = keepAbove ? c.p[ax] >= y : c.p[ax] <= y;
        if (ia) out.push(a);
        if (ia !== ic) { const [e0, e1] = lo(a, c) ? [a, c] : [c, a], f = (y - e0.p[ax]) / (e1.p[ax] - e0.p[ax]); // (from its lower end, whichever side asks: the same point)
          out.push({ p: e0.p.clone().lerp(e1.p, f), n: e0.n.clone().lerp(e1.n, f).normalize(), s: e0.s.clone().lerp(e1.s, f) }); } }
      return out; };
    // a polygon diced on the world grid along ax (step st): its pieces
    const dice = (polys, ax, st) => polys.flatMap(poly => { if (poly.length < 3) return [];
      const vs = poly.map(v => v.p[ax]), lo = Math.min(...vs), hi = Math.max(...vs), k0 = Math.floor(lo / st + 1e-6), k1 = Math.ceil(hi / st - 1e-6);
      if (k1 - k0 <= 1) return [poly];
      const out = []; for (let k = k0; k < k1; k++) { const q = cut(cut(poly, Math.max(lo, k * st), true, ax), Math.min(hi, (k + 1) * st), false, ax); if (q.length >= 3) out.push(q); }
      return out; });
    // (each piece to its material's run: a back above the deck goes to its lining's)
    const outs = buckets.map(() => ({ pos: [], nrm: [], clip: [], inside: [], slide: [], floor: [] }));
    buckets.forEach((b, m) => {
      for (let k = 0; k < b.length; k += 15) {
        const tri = [0, 5, 10].map(d => ({ p: b[k + d], n: b[k + d + 1], s: b[k + d + 3] })), cl = b[k + 2] & 1, ins = (b[k + 2] >> 1) & 1, lin = (b[k + 2] >> 2) - 1, fl = b[k + 4];
        const ys = tri.map(v => v.p.y), lo = Math.min(...ys), hi = Math.max(...ys);
        // (on one grid for the whole building: neighbours split a shared edge at the same heights, so no crack opens along it)
        const k0 = Math.floor(lo / BAND + 1e-6), k1 = Math.max(k0 + 1, Math.ceil(hi / BAND - 1e-6));
        // (a flat one: nothing to slice — kept whole)
        const bands = (cl || hi - lo < 1e-6 ? [[lo, hi]] : Array.from({ length: k1 - k0 }, (_, i) => [Math.max(lo, (k0 + i) * BAND), Math.min(hi, (k0 + i + 1) * BAND)]).filter(([y0, y1]) => y1 - y0 > 1e-7))
          .flatMap(([y0, y1]) => y0 < deckY - 1e-7 && deckY < y1 - 1e-7 ? [[y0, deckY], [deckY, y1]] : [[y0, y1]]);   // (split at the deck)
        for (const [y0, y1] of bands) {
          // a thick wall's back above its deck (or with none) is outdoors: lit, and in its lining — below, the inside
          const out = ins && lin >= 0 && (y0 + y1) / 2 > deckY, o = outs[out ? lin : m], pIns = out ? 0 : ins;
          const band = bands.length > 1 ? cut(cut(tri, y0, true), y1, false) : tri;
          for (const poly of jag && !cl ? dice(dice([band], 'x', COL), 'z', COL) : [band])
          for (let q = 1; q + 1 < poly.length; q++) for (const v of [poly[0], poly[q], poly[q + 1]]) { o.pos.push(v.p.x, v.p.y, v.p.z); o.nrm.push(v.n.x, v.n.y, v.n.z); o.clip.push(cl); o.inside.push(pIns); o.slide.push(v.s.x, v.s.y, v.s.z); o.floor.push(fl); }
        }
      }
    });
    let start = 0;
    const app = (to, from) => { for (let i = 0; i < from.length; i++) to.push(from[i]); };   // (no spread: a big building's run would overflow the call stack)
    const floor = [];
    for (const [m, o] of outs.entries()) { const c = o.pos.length / 3; app(pos, o.pos); app(nrm, o.nrm); app(clip, o.clip); app(inside, o.inside); app(slide, o.slide); app(floor, o.floor); geo.addGroup(start, c, m); start += c; }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('clipOnly', new THREE.Float32BufferAttribute(clip, 1));
    geo.setAttribute('inside', new THREE.Float32BufferAttribute(inside, 1));
    geo.setAttribute('slide', new THREE.Float32BufferAttribute(slide, 3));
    geo.setAttribute('capFloor', new THREE.Float32BufferAttribute(floor, 1));
    return geo;
  }
  // A site's walls' inner feet (where their insides meet the ground: the inside's outline) and all their feet, in world xz.
  function innerFeet(o){
    o.updateMatrixWorld(true);
    const P = o.geometry.attributes.position, In = o.geometry.attributes.inside, v = new THREE.Vector3(), pts = [], all = [];
    for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld); if (v.y < 1e-3) { all.push([v.x, v.z]); if (In.getX(i) > 0.5) pts.push([v.x, v.z]); } }
    return { pts, all };
  }
  // a flat convex fan over points (xz) at height y, facing up
  function hullFan(ps, y){ ps = ps.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], hi = [];
    for (const p of ps) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (const p of ps.slice().reverse()) { while (hi.length > 1 && cr(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    const hull = lo.slice(0, -1).concat(hi.slice(0, -1)), pos = [];
    if (hull.length < 3) return null;
    for (let k = 1; k + 1 < hull.length; k++) for (const q of [hull[0], hull[k + 1], hull[k]]) pos.push(q[0], y, q[1]);
    const geo = own(new THREE.BufferGeometry()); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => i % 3 === 1 ? 1 : 0), 3)); return geo; }
  // The ground a site's walls enclose, in their shade: the walls' inner feet (convex hull), a dark film just above the grass.
  let _floorMat = null, _floorDepthMat = null;
  function floorShade(o, jag){
    const { pts, all } = innerFeet(o);
    if (pts.length < 3) return null;
    const geo = hullFan(pts, 0.004), under = hullFan(all, 0.002); if (!geo) return null;   // (the twin a hair lower: at one height their two triangulations z-fought, the shade flickering)
    _floorMat = _floorMat || new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 1 - SITE_SHADE, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }); // (single pass: a see-through two-sided material is otherwise drawn twice, recompiled each time)
    // its twin writes depth only, drawn first, over the walls' whole footprint: the ground blocks nothing, so without it an
    // outline shell's floor shows black through the open top
    _floorDepthMat = _floorDepthMat || new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, _floorMat);
    if (jag) { const d = new THREE.Mesh(under || geo, _floorDepthMat); d.renderOrder = -0.5; m.add(d); }   // (the twin: under the walls too; a damaged building's only — a site's walls start pressed flat onto it and fought it)
    return m;
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
    // (a damaged gate's door (keepWhole) stays whole and unmerged: the moving part that shows it opening — only the pillars break)
    const walk = (o, f) => { if (isPiece(o) || (jag && o.userData.keepWhole)) return; f(o); for (const c of o.children) walk(c, f); };
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
    const built = new Map(), level = standsLevel(entitiesById.get(g.userData.bid)) ? { value: new THREE.Vector2(x0 + w / 2, z0 + h / 2) } : null;
    const cutMat = m => { let c = built.get(m); if (c) return c;
      c = m.clone(); c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey;
      if (m.isLineBasicMaterial) c.clippingPlanes = [below];                           // (ink: cut at the top, not pressed onto it)
      else { const ob = m.onBeforeCompile, key = m.customProgramCacheKey.call(m), lit = !!m.isMeshLambertMaterial && !m.flatShading;
        c.onBeforeCompile = (sh, r) => { if (ob) ob.call(c, sh, r); sh.uniforms.siteY = siteY; sh.uniforms.siteJag = siteJag;
          // the top: level while building; broken (siteJag: how far it dips, by a smooth noise along the walls) when damaged
          sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float clipOnly; attribute float inside; attribute vec3 slide; attribute float capFloor; uniform float siteY; uniform float siteJag; varying float vSiteY; varying float vClip; varying vec3 vSiteW; varying float vInside; varying float vSiteTop; varying float vCapFloor;\n' + SITE_NOISE)
            .replace('#include <begin_vertex>', `#include <begin_vertex>
              {
                #ifdef USE_INSTANCING
                  mat4 siteM = modelMatrix * instanceMatrix;
                #else
                  mat4 siteM = modelMatrix;
                #endif
                vec4 sw = siteM * vec4(transformed, 1.0); vSiteY = sw.y; vClip = clipOnly;
                vCapFloor = capFloor < -0.5 ? -1e9 : (siteM * vec4(transformed.x, capFloor, transformed.z, 1.0)).y;   // (a cut storey's cap: its foot)
                float sy = siteJag > 0.0 ? max(0.0, siteY - siteJag * siteN(sw.xz * 3.2)) : siteY; vSiteTop = sy;
                #ifndef SITE_HULL
                  if (clipOnly < 0.5 && sw.y > sy) { sw.xyz -= slide * (sw.y - sy); transformed = (inverse(siteM) * sw).xyz; }
                #endif
                vSiteW = sw.xyz; vInside = inside; }`);
          // a surface pressed flat onto the top (found per pixel, so a wall's side is never touched) is lit and patterned as a top
          sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float siteY; varying float vCapFloor; uniform float siteJag; varying float vSiteY; varying float vClip; varying vec3 vSiteW; varying float vInside; varying float vSiteTop;\n' + SITE_NOISE)
            .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
              // (the broken top found per pixel: a cut part's top read off its corners was straight across a deck while the
              // walls round it broke ragged — the deck overhung them)
              float siteTopPx = siteJag > 0.0 ? max(0.0, siteY - siteJag * siteN(vSiteW.xz * 3.2)) : siteY;
              if (vClip > 0.5 && vSiteY > siteTopPx + 1e-4) discard;
              if (siteY <= vCapFloor + 1e-4) discard;   // (a cut storey's cap: not till the build passes its foot — below, the storey under it caps)
              #ifdef SITE_HULL
                if (vSiteW.y > siteTopPx) discard;   // an outline: cut at the broken top (pressed, it laid a black sheet over it)
              #endif
              // (a cut part's inside — a beam's, a box's — seen through its open top, is its cut: drawn as a top, it reads filled
              // at the build line; a wall has a real cap there. Not the outline shell's: it is drawn from its back faces.)
              bool siteCap = vClip > 0.5 && !gl_FrontFacing;
              #ifdef SITE_HULL
                siteCap = false;
              #endif
              bool sitePressed = siteCap || (vSiteW.y >= vSiteTop - 1e-4 && (siteJag > 0.0 || abs(normalize(cross(dFdx(vSiteW), dFdy(vSiteW))).y) > 0.98));`)
            .replace('abs(normalize(vWNrm))', 'abs(sitePressed ? vec3(0.0, 1.0, 0.0) : normalize(vWNrm))')
            // the inside of the walls (and of its openings) in the walls' shade
            .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  if (vInside > 0.5 && !sitePressed) gl_FragColor.rgb *= SITE_SHADE;');
          if (lit) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  if (sitePressed) normal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);'); };
        c.onBeforeCompile.fow = !!(ob && ob.fow);                        // (a source already fog-patched: not patched again — a double patch won't compile)
        c.customProgramCacheKey = () => key + (jag ? ':siteJ' : ':site');
        c.defines = { ...(c.defines || {}), SITE_SHADE: SITE_SHADE.toFixed(3) };
        if (HULL_MATS.has(m)) c.defines.SITE_HULL = '';
        // a lintel pressed down faces down: from above it must still close its opening's slot
        if (!HULL_MATS.has(m)) c.side = THREE.DoubleSide; }
      if (INTERIOR_MATS.has(m) || (HULL_MATS.has(m) && !jag)) c.visible = false;     // (no bold outline on an open, half-built shell: the finished building gets it; a damaged one keeps its own, pressed down with its broken walls)
      if (level) levelMat(c, level);
      built.set(m, c); return c; };
    // every mesh of a site says what it is (the site shader reads these; an unset attribute reads garbage)
    const mark = geo => { const n = geo.attributes.position.count;
      for (const k of ['clipOnly', 'inside']) if (!geo.attributes[k]) geo.setAttribute(k, new THREE.Float32BufferAttribute(new Float32Array(n), 1));
      if (!geo.attributes.capFloor) geo.setAttribute('capFloor', new THREE.Float32BufferAttribute(new Float32Array(n).fill(-1), 1));
      if (!geo.attributes.slide) geo.setAttribute('slide', new THREE.Float32BufferAttribute(new Float32Array(n * 3).map((_, i) => i % 3 === 1 ? 1 : 0), 3)); }; // (straight down)
    const swap = (o, f) => { if (!o.material) return;
      if (o.isMesh && o.userData.siteCut && !o.geometry.userData.siteCut) {   // (its own copy: a box's geometry is shared)
          // (a part laid over the walls: cut at the build line, not pressed flat onto their top)
        o.geometry = own(o.geometry.clone()); o.geometry.userData.siteCut = true; o.geometry.setAttribute('clipOnly', new THREE.Float32BufferAttribute(new Float32Array(o.geometry.attributes.position.count).fill(1), 1)); }
      if (o.isMesh) mark(o.geometry);
      if (Array.isArray(o.material) && o.material.length === 6) o.material = o.material.map((m, i) => i === 2 ? o.material[0] : m); // (a box: its body on top)
      o.material = Array.isArray(o.material) ? o.material.map(f) : f(o.material); o.userData.siteOwn = true; };
    const set0 = [];
    for (const c of g.children) if (isPiece(c)) { const b = new THREE.Box3().setFromObject(c); set0.push({ obj: c, y0: c.position.y, base: b.min.y, top: b.max.y, at: null }); }
    const floors = [];
    for (const c of g.children) walk(c, o => { if (!o.isMesh || !o.userData.slab) return; o.geometry = own(o.userData.slab(jag));
      const rl = o.children.find(k => k.userData.rims); if (rl) rl.geometry = own(new THREE.BufferGeometry().setFromPoints(o.userData.slabRims()));
      floors.push(floorShade(o, jag)); });
    for (const f of floors) if (f) g.add(f);
    for (const c of g.children.slice()) walk(c, o => swap(o, cutMat));
    // a part that starts above the build height isn't there yet (a cap on the walls, a beam higher up) — pressing it down
    // would lay it over the open top
    const later = []; g.updateMatrixWorld(true);
    for (const c of g.children) walk(c, o => { if (o.isMesh && !o.userData.siteCut && !HULL_MATS.has([].concat(o.material)[0]) && o.parent && !o.parent.isMesh) {   // (siteCut: shown cut, from the start)
      const y0 = mb.setFromObject(o, true).min.y; if (y0 > 0.02) later.push([o, y0]); } });
    const setRing = y => { siteY.value = y; for (const [o, y0] of later) o.visible = y > y0 + 0.005; };
    // the rest, merged by material (as a finished building): what comes and goes on its own (pieces, parts above the
    // build line, flags, goods, a horse, the floor shade) is lifted out first and put back as it was
    { const keep = new Set([...set0.map(q => q.obj), ...later.map(([o]) => o), ...floors.filter(Boolean)]);
      g.traverse(o => { if (SITE_LIVE.has(o.name) || o.userData.keepWhole) keep.add(o); else if (o.name === 'horseNeck' && o.parent && o.parent !== g) keep.add(o.parent); });
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
      const inLive = o => { for (let p = o; p && p !== g; p = p.parent) if (SITE_LIVE.has(p.name) || p.userData.keepWhole || keepL.has(p) || p.name === 'horseNeck') return true; return false; }; // (part of something with its own life)
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
        if (level) levelMat(c, level);
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
    // (taken over: refreshBuildings won't drop it — so what stands about it goes now: the yard's trainees, a roof's archers)
    if (rec && rec.dmg) { solids.delete(e.id); g = rec.obj; d = rec.dmg; g.userData.bid = null;
      for (const t of (rec.trainees || []).concat(rec.roof || [], rec.yard || [])) dropVillager(t); rec.trainees = rec.roof = rec.yard = null; }
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
  // A TC's garrisoned villagers up on the keep (render-units' roofCrew: where each stands, walking, aiming), posed here
  // with a bow, each its own villager's look; they loose as the sim spawns the volley (MIL_IMPACT.archer)
  function roofArchers(rec){
    const e = entitiesById.get(rec.obj.userData.bid); if (!e) return;
    const R = roofCrew(e), cd = e.atkCooldown || 0, ph = ((1 - cd / BUILDING_RELOAD + MIL_IMPACT.archer) % 1 + 1) % 1;
    const opt = { unit: 'archer', eq: { ...soldierEquip('archer', 0, 0, 0, false), civ: true } }, tc = teamColor(rec.team);   // (villagers as they are, a bow in hand)
    rec.roof.forEach((r, i) => {
      const f = R.figs[i];
      if (!f) { if (r.rig || r.obj) { dropVillager(r); r.rig = null; r.obj = null; r.key = ''; } return; }
      const v = entitiesById.get(e.garrison[i]), kind = f.moving ? 'walk' : R.firing ? 'attack' : 'idle';
      const t = f.moving ? (f.walk / 0.6) % 1 : R.firing ? (ph + i * 0.04) % 1 : (aTick * 0.004 + i * 0.37) % 1;
      rigPose(r, kind, t, !!(v && v.female), opt, tc);
      if (r.obj) { r.obj.position.set(f.x + 0.5, R.down ? 0 : r.y, f.y + 0.5);   // (down: on the ground inside the broken keep)
        r.obj.rotation.y = -f.hd; r.obj.visible = rec.obj.visible; }
    });
  }
  // A Castle's garrison up its towers (with a bow, loosing with its volleys: roofArchers') and in its yard, and the
  // portcullis lifting for them (render-units' castleYard: where each stands and walks)
  function yardWalkers(rec){
    const e = entitiesById.get(rec.obj.userData.bid); if (!e) return;
    const Y = castleYard(e), tc = teamColor(rec.team), cd = e.atkCooldown || 0, ph = ((1 - cd / BUILDING_RELOAD + MIL_IMPACT.archer) % 1 + 1) % 1;
    const bow = { unit: 'archer', eq: { ...soldierEquip('archer', 0, 0, 0, false), civ: true } }, plain = {};
    if (rec.portcullis) rec.portcullis.position.y = Y.gate * 18 / HPX;
    rec.yard.forEach((r, i) => {
      const f = Y.list[i];
      if (!f) { if (r.rig || r.obj) { dropVillager(r); r.rig = null; r.obj = null; r.key = ''; } return; }
      if (f.top) rigPose(r, Y.firing ? 'attack' : 'idle', Y.firing ? (ph + i * 0.04) % 1 : (aTick * 0.004 + i * 0.37) % 1, f.female, bow, tc);
      else rigPose(r, f.moving ? 'walk' : 'idle', f.moving ? (f.walk / WALK_TILES.walk) % 1 : (aTick * 0.004 + i * 0.37) % 1, f.female, plain, tc);
      if (r.obj) { r.obj.position.set(Y.ox + f.u + 0.5, f.top ? CASTLE_TOP / HPX : 0, Y.oy + f.v + 0.5); r.obj.rotation.y = -f.hd; r.obj.visible = rec.obj.visible; }
    });
  }
  function animateModels(dt){
    animateFalls(dt);
    const t = aTick * 0.13;
    for (const rec of solids.values()) {
      if (rec.sails) rec.sails.rotation.z += dt * 0.9;
      if (rec.smoke && !rec.site && !rec.dmg && rec.obj.visible && (rec.smokeT = (rec.smokeT || Math.random()) - dt) <= 0) { // chimney smoke (the 2D's drawChimneySmoke)
        rec.smokeT = 0.55 + Math.random() * 0.3; for (const [x, y, z] of rec.smoke) chimneyPuff(x, y, z); }
      if (rec.hoists && rec.obj.visible && !rec.site && !rec.dmg) for (const h of rec.hoists) { const L = hoistLength(h.userData, aTick);   // (the lumber camp's log, up and down)
        namedPart(h, 'hoistRope').scale.y = L; namedPart(h, 'hoistLog').position.y = -L; }
      if (rec.anims && rec.anims.length && rec.obj.visible && !rec.site && !rec.dmg) for (const o of rec.anims) o.userData.anim(o, aTick);   // (the mining camp's wheel, bucket and fire)
      if (rec.pennants) for (const p of rec.pennants) p.rotation.y = 0.35 * Math.sin(t * 0.9 + p.userData.phase) + 0.12 * Math.sin(t * 2.3 + p.userData.phase * 2); // (swinging in the wind)
      if (rec.site) { const be = entitiesById.get(rec.siteOf); if (be) rec.site.set((be.buildProgress || 0) / be.buildTime); }
      if (rec.dmg && rec.obj.visible) { const fe = entitiesById.get(rec.obj.userData.bid); if (fe) rec.dmg.set(fe.hp / fe.maxHp); rec.dmg.tick(dt); } // (its damage by its health)
      if (rec.door) { // gates slide their door up as they open (read-only)
        const ge = entitiesById.get(rec.doorOf);
        // (out of sight it stays as it was left: an enemy's gate doesn't work in the fog)
        if (!ge || buildingFogLevel(ge) === 2) rec.door.position.y = ge ? (ge.gateProgress || 0) * 26 / HPX : 0;
      }
      if (rec.flags && rec.obj.visible) for (const f of rec.flags) { // the art's travelling wave, a ripple down its height too, shaded as it folds
        const pos = f.geometry.attributes.position, rest = f.geometry.userData.rest, L = f.userData.len, H = f.userData.hgt || 1, fs = f.userData.s || 1, ph = f.userData.phase || 0;
        for (let i = 0; i < pos.count; i++) {
          const u = Math.max(0, rest[3 * i] / L), v = Math.max(0, -rest[3 * i + 1] / H), a = t + ph;   // (u out from the staff, v down from its top)
          pos.setZ(i, (Math.sin(a - u * 4.2) * 0.07 + Math.sin(a * 0.63 - u * 7) * 0.02 + Math.sin(a * 1.4 - u * 5 + v * 2.4) * 0.012) * u * fs);
          pos.setY(i, rest[3 * i + 1] - (0.05 * u * u + 0.012 * u * v) * fs);   // (the free corner hangs a touch lower)
        }
        pos.needsUpdate = true; f.geometry.computeVertexNormals();
      }
      if (rec.trainees) for (const tr of rec.trainees) { // the spearman's thrust on the pose cache (villagerPose's idiom), facing the dummy
        const opt = { unit: 'spearman', eq: soldierEquip('spearman', rec.age, 0, 0, false) }, ph = ((aTick * 0.026 + tr.seed) % 1 + 1) % 1, step = Math.floor(ph * VIL_STEPS);
        rigPose(tr, 'attack', ph, false, opt, teamColor(rec.team));
        if (tr.obj) { tr.obj.position.set(tr.x, 0, tr.z); tr.obj.rotation.y = tr.yaw; }
      }
      if (rec.roof) roofArchers(rec);
      if (rec.yard) yardWalkers(rec);
      if (rec.horses) for (const h of rec.horses) {
        // Each horse on its own ~11s cycle: head up (a slow bob), then down to
        // graze a few seconds, nibbling; the tail swishes throughout.
        const sec = aTick / 30 + h.seed * 11, gp = horseGrazePose(aTick / 30, h.seed);   // (the cycle the 2D yard shares)
        h.neck.rotation.z = gp.neck;
        h.head.rotation.z = gp.head;
        h.tail.rotation.x = gp.tail;
        h.tail.rotation.z = 0.08 * Math.sin(sec * 1.1);
      }
    }
  }

  // A model takes time to make — a site's or a damaged building's a frame or several (their walls are cut into real
  // slabs) — and its shaders more to compile, so they are never made in a burst: a frame makes models (new, or a
  // standing one's next state: a town under fire turns damaged one building a frame, not all in one) until BLD_MS is
  // spent, and drawFrame comes back for the rest (bldLeft). With nothing to make in view, one a pass of the buildings
  // known BEYOND it is made, hidden, its shaders compiled in the background: a view that jumps or flies to another
  // town finds it built. (A match's first frames make everything at once.)
  // BLD_MS a frame for building models; LOAD_MS while the view is still filling in (what's in view first, nearest first)
  // lastLoad: the frame the view last had models still to build — the warm-up (warmStep) waits a second past it, not to
  // compete with a view filling in
  let bldLeft = false, bldSpent = 0, BLD_MS = 3, lastLoad = 0; const BLD_IDLE_MS = 3, LOAD_MS = 10, PREBUILD_MAX = 600;
  // A match's start (its first frames, behind the fade): every kind of building is made once as a site and once
  // damaged, and thrown away — the first of a kind is the costly one (its walls' slabs are cut, then kept by shape:
  // thickGeo; its shaders compiled), and it would otherwise be met mid-battle, the frame a building is first hit.
  // …and again for an age a team reaches (its buildings change shape), one kind a frame (warmStep): all at once it
  // would be the stall it is there to prevent.
  const warmQueue = [], warmedKinds = new Set();
  function prewarmShapes(){
    // (only the kinds that stand, each once an age: one first built later is warmed then — drawFrame calls this now and again)
    const have = new Set(); for (const e of entities) if (e.type === 'building') have.add(e.btype);
    for (let t = 0; t < NUM_TEAMS; t++) { const age = (teamAge && teamAge[t]) || 0;
      for (const btype of have) { const b = BLDGS[btype], k = age + ':' + btype; if (!b || !MODELS[btype] || warmedKinds.has(k) || isWallBtype(btype) || isGateBtype(btype) || btype === 'FARM') continue;
        warmedKinds.add(k); for (const hurt of [false, true]) warmQueue.push({ btype, hurt, team: t, age }); } }
    // a farm: its wheat's shaders, as a site and standing (each its own program) — the first is sown mid-game
    const fk = ((teamAge && teamAge[myTeam]) || 0) + ':FARM';
    if (!warmedKinds.has(fk)) { warmedKinds.add(fk); for (const whole of [false, true]) warmQueue.push({ btype: 'FARM', hurt: false, whole, team: myTeam, age: (teamAge && teamAge[myTeam]) || 0 }); }
  }
  // Compile what g will draw with, off the frame (parallel where the GPU can): its materials fog-patched first, as they
  // will be at their first draw (fowPatch, on render) — compiled unpatched, the warm-up made programs nothing uses.
  const fowAll = g => { if (fowU.value) g.traverse(o => { for (const m of [].concat(o.material || [])) if (m && m.onBeforeCompile && !m.onBeforeCompile.fow) fowPatch(m); }); };
  function warmCompile(g){
    fowAll(g);
    return renderer.compileAsync ? renderer.compileAsync(g, camera, scene) : Promise.resolve();
  }
  function warmStep(){
    const q = warmQueue.shift(); if (!q || ((teamAge && teamAge[q.team]) || 0) !== q.age) return;
    const { btype, hurt } = q, b = BLDGS[btype];
    const e = { id: -9, type: 'building', btype, x: 2, y: 2, w: b.w, h: b.h, team: q.team, complete: hurt || !!q.whole, hp: b.hp * 0.4, maxHp: b.hp, buildProgress: 0, buildTime: 200, gateProgress: 0, queue: [], garrison: [] };
    try { const g = new THREE.Group(); MODELS[btype](g, hurt ? { ...e, openTop: true } : e); addHulls(g); fowAll(g);   // (patched before a site's clones of them are cut, as a standing world's are)
      const rec = { obj: g }; if (hurt) rec.dmg = buildingDamage(g, e.x, e.y, b.w, b.h); else if (!q.whole) rec.site = constructionSite(g, e.x, e.y, b.w, b.h, !OPEN_SITE.has(btype));
      const done = () => dropSolid(rec);
      warmCompile(g).then(done, done);
    } catch (err) { /* a warm-up only */ }
  }
  function refreshBuildings(){
    const seen = new Set(), make = e => { if (isWallBtype(e.btype) || isGateBtype(e.btype)) refreshWall(e); else refreshModel(e); return solids.get(e.id); };
    let far = null; const loading = bldLeft; BLD_MS = loading ? LOAD_MS : BLD_IDLE_MS; bldLeft = false;
    bldSpent = warmFrames > 0 || unrevealed ? -Infinity : 0;   // (unrevealed: the view opening behind the 2D — all in view at once)
    const near = [];
    for (const e of entities) {
      if (e.type !== 'building' || e.hp <= 0 || !bldgVisible(e)) continue;
      const c = centerOf(e);
      if (Math.abs(c.x - eye.x) > RANGE + 4 || Math.abs(c.y - eye.y) > RANGE + 4) { if (!far && !solids.has(e.id)) far = e; continue; }
      near.push(loading ? [(c.x - eye.x) ** 2 + (c.y - eye.y) ** 2, e] : [0, e]);
    }
    if (loading) near.sort((a, b) => a[0] - b[0] || a[1].id - b[1].id);   // (filling in: the nearest first)
    for (const [, e] of near) {
      seen.add(e.id);
      const rec = make(e);
      if (rec && rec.obj) { const gh = isWallBtype(e.btype) && ghostAt.get(e.y * MAP + e.x); rec.hid = !!(gh && gh.btype !== e.btype); rec.obj.visible = !rec.hid; }   // (a wall where a gate, a tower or a stone piece is being placed: it will be gone)
    }
    if (!bldSpent && far && solids.size < PREBUILD_MAX) { const rec = make(far);
      if (rec && rec.obj) { rec.obj.visible = false; warmCompile(rec.obj).catch(() => {}); } }
    // Out of range: hidden, not dropped — the model is ready when the view comes back. Gone or unseen: dropped.
    for (const [id, w] of solids) if (!seen.has(id)) { const e = entitiesById.get(id);
      if (e && e.type === 'building' && e.hp > 0 && bldgVisible(e)) { if (w.obj) w.obj.visible = false; } else { dropSolid(w); solids.delete(id); } }
    wallRuns();
  }
  // Where a unit faces: along its path, else toward its target, else the last way it faced. It shares the 2D
  // renderer's facing (e.dir, the sprite direction nearest on screen — cosmetic, never read by the sim): a unit starts from
  // it, 3D writes its turns back (both views agree after a switch), and a 2D turn since overrides the finer memory.
  const heading = new Map(); // id → { h, dir }
  function setHeading(e, h){
    const dir = spriteDir(Math.cos(h), Math.sin(h));
    heading.set(e.id, { h, dir });
    if (world && e.dir !== dir) { e.dir = dir; if (typeof setFacingFromDir === 'function') setFacingFromDir(e, dir); }
  }
  function worldFacing(e){
    if (e.faceAng !== undefined) return e.faceAng;                                        // the dragon's own slow heading (its fire goes where it faces)
    let tx, ty;
    if (e.path && e.path.length) { const a = e.path[0]; tx = a.x; ty = a.y; }               // the current leg: a straight line
    else if (e.target && entitiesById.get(e.target)) { const t = entitiesById.get(e.target); tx = t.x; ty = t.y; }
    if (tx !== undefined && (tx !== e.x || ty !== e.y)) { const h = Math.atan2(ty - e.y, tx - e.x); setHeading(e, h); return h; }
    const r = heading.get(e.id);
    if (r && (e.dir === undefined || r.dir === e.dir)) return r.h;
    return (e.dir !== undefined ? e.dir : 1) * Math.PI / 4;
  }

  function unitVisible(e){
    if (e.garrisonedIn || e.hp <= 0) return false;
    if (dragonSeenByAll(e)) return true;
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
  const WALK_IN = 0.9; // tiles per game-second a villager steps to its work spot at (a walk)
  const workPhase = (e, k) => villagerWorkPhase(e, k, aTick), carriedLoad = villagerLoad;
  const villagerPose = (e, v) => villagerAction(e, v.stride, aTick);                // (render-units: the action, one reading for both views)
  const vilCache = new Map(), vilRefs = new Map(), bladePush = [], VIL_CACHE_VERTS = 1.5e6;
  let cacheVerts = 0;
  let bakesLeft = 0;
  // Merge a posed group into one mesh per (material, draw order); multi-material
  // boxes and ink lines are kept as they are.
  const BAKE_STD = new Set(['position', 'normal', 'uv']), BAKE_DEF = { slide: [0, 1, 0] };
  // mergePlain (a finished building: bakeStill): its plain colours — mat() materials that are a colour and nothing more —
  // go into ONE mesh, the colour per vertex (the rigs' own material, rigPlainMat), not a mesh a colour: a building is
  // a dozen colours, and each was a draw call.
  function bakePose(g, mergePlain = false){
    // (mergePlain: a still model in its real team colour — nothing swaps its materials after. Plain and patterned
    // surfaces alike go into the one body, bodyMat.)
    const still = m => mergePlain && (m.isMeshLambertMaterial || m.isMeshPhongMaterial) && !m.map && !m.transparent && !HULL_MATS.has(m);
    const plainOf = m => still(m) && (m.userData.plain || m.flatShading), detOf = m => still(m) && !m.flatShading && m.userData.detail;
    // (a faceted part — an ore pile's rocks — joins the body with its facets as real normals: a corner per triangle)
    const facets = (geo, range) => { const P = geo.attributes.position, I = geo.index, r0 = range ? range.start : 0, n = range ? range.count : I ? I.count : P.count;
      const pos = new Float32Array(n * 3), nr = new Float32Array(n * 3), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (let t = 0; t < n; t += 3) { const at = k => I ? I.getX(r0 + t + k) : r0 + t + k;
        a.fromBufferAttribute(P, at(0)); b.fromBufferAttribute(P, at(1)); c.fromBufferAttribute(P, at(2));
        pos.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], t * 3); b.sub(a); c.sub(a); b.cross(c).normalize();
        for (let k = 0; k < 3; k++) nr.set([b.x, b.y, b.z], (t + k) * 3); }
      const f = new THREE.BufferGeometry(); f.setAttribute('position', new THREE.BufferAttribute(pos, 3)); f.setAttribute('normal', new THREE.BufferAttribute(nr, 3)); return f; };
    g.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), groups = new Map(), lineGroups = new Map(), root = new THREE.Group();
    g.traverseVisible(o => {
      if (o === g || !(o.isMesh || o.isLineSegments)) return;
      const M = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      const put = (m, range) => { if (!m.visible) return;
        // (a fine outline, pushed out in the geometry, rides the bold ones' material with no push of its own: zero normals)
        const zeroN = mergePlain && m === hullWorldMat; if (zeroN) m = hullMat;
        const pl = plainOf(m), dt = !pl && detOf(m), body = pl || dt, k = (body ? 'body' + m.side : m.uuid) + '|' + o.renderOrder;
        if (!groups.has(k)) groups.set(k, { mat: body ? bodyMat(m.side) : m, ro: o.renderOrder, parts: [], vc: !!body }); const flat = body && m.flatShading;
        groups.get(k).parts.push({ geo: flat ? facets(o.geometry, range) : o.geometry, M, range: flat ? null : range, col: m.color, det: dt ? DETAIL_IDS.indexOf(dt) : -1, zeroN, shine: m.isMeshPhongMaterial ? 0.6 : 0 }); };
      if (o.isMesh && !Array.isArray(o.material)) { put(o.material); return; }
      // a multi-material mesh (a box with its own top): each material's triangles into that material's merge
      if (o.isMesh && o.geometry.groups.length && o.geometry.groups.every(gr => o.material[gr.materialIndex])) { for (const gr of o.geometry.groups) put(o.material[gr.materialIndex], gr); return; }
      if (o.isLineSegments && !o.geometry.index) { const k = 'L' + o.material.uuid + '|' + o.renderOrder;   // ink: merged the same way, as lines
        if (!lineGroups.has(k)) lineGroups.set(k, { mat: o.material, ro: o.renderOrder, parts: [] }); lineGroups.get(k).parts.push({ geo: o.geometry, M }); return; }
      const c = o.isMesh ? new THREE.Mesh(o.geometry, o.material) : new THREE.LineSegments(o.geometry, o.material);
      c.renderOrder = o.renderOrder; M.decompose(c.position, c.quaternion, c.scale); root.add(c); o.geometry.userData.kept = true; // referenced, not copied: survives the source's cleanup
    });
    const nm = new THREE.Matrix3(), v = new THREE.Vector3();
    for (const { mat: m, ro, parts, vc } of groups.values()) {
      let nv = 0, ni = 0; const uv = !vc && parts.every(p => p.geo.attributes.uv);
      for (const p of parts) { nv += p.geo.attributes.position.count; ni += p.range ? p.range.count : p.geo.index ? p.geo.index.count : p.geo.attributes.position.count; }
      const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uvs = uv ? new Float32Array(nv * 2) : null, idx = new Uint32Array(ni);
      let ov = 0, oi = 0;
      for (const { geo, M, range, zeroN } of parts) {
        const P = geo.attributes.position, N = zeroN ? null : geo.attributes.normal, n = P.count; nm.getNormalMatrix(M);
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
      if (vc) { const cols = new Float32Array(nv * 3); let o = 0;
        // (steel and gold keep their sheen as a glow baked on the faces turned up — as the far rigs')
        for (const { geo, col, shine } of parts) { const n = geo.attributes.position.count; for (let i = 0; i < n; i++) { const up = shine ? shine * Math.max(0, nrm[o + 1]) : 0;
          cols[o++] = col.r + (1 - col.r) * up; cols[o++] = col.g + (1 - col.g) * up; cols[o++] = col.b + (1 - col.b) * up; } }
        bg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
        const dets = new Float32Array(nv); o = 0; for (const { geo, det } of parts) { const n = geo.attributes.position.count; dets.fill(det, o, o + n); o += n; }
        bg.setAttribute('det', new THREE.BufferAttribute(dets, 1)); }
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
    try { const g = animFrame(kind, t, female, opt), live = [], free = o => o.traverse(c => { if (c.geometry && c.geometry.userData.own && !c.geometry.userData.kept) c.geometry.dispose(); });
      // (a moving part — trebModel live — baked on its own, a group (still at the model's origin), or kept as it is, a rod)
      g.traverse(o => { if (o.userData.live) live.push(o); }); for (const o of live) o.parent.remove(o);
      f = bakePose(g); free(g);
      for (const o of live) { if (o.isMesh) { f.add(o); continue; } const b = bakePose(o); free(o); b.name = o.name; f.add(b); } } finally { POLY = 1; }
    f.userData.verts = 0; f.traverse(o => { if (o.geometry && o.geometry.userData.baked) f.userData.verts += o.geometry.attributes.position.count; });
    vilCache.set(key, f); cacheVerts += f.userData.verts;
    // held to a vertex budget (≈50MB), least recently used first; poses still worn are kept
    if (cacheVerts > VIL_CACHE_VERTS) for (const [k, old] of vilCache) { if (cacheVerts <= VIL_CACHE_VERTS * 0.8) break;
      if (!vilRefs.get(k)) { old.traverse(o => { if (o.geometry && (o.geometry.userData.baked || o.geometry.userData.own)) o.geometry.dispose(); }); cacheVerts -= old.userData.verts; vilCache.delete(k); } }
    return f;
  }
  // Soldiers (the lab's military frames): march / gallop / roll while moving, the
  // attack while in weapon range, else at rest. The attack rides the REAL reload
  // clock (atkCooldown resets to rof ON the hit — render-units' convention), each
  // swing placed so its blow lands on that reset. Gear: the team's age and forge
  // lines, by soldierEquip's rules.
  const RIG_UNITS = ut => ut !== 'ram' && ut !== 'tradecart' && ut !== 'trebuchet'; // vehicles keep the pose cache (their building-style parts carry ink lines)
  const VIL_SOUND = { chop: 'chop', split: 'chop', mine: 'mine', build: 'build', repair: 'build' }; // the 2D work sounds, by 3D action
  const MIL3D = new Set(['militia', 'spearman', 'archer', 'scout', 'knight', 'ram', 'tradecart', 'trebuchet']);
  // (MIL_IMPACT, soldierEquip, the soldier poses: render-units — shared with the 2D)
  const MIL_STRIDE = { walk: 0.62, gallop: 1.3, roll: 0.76, cart: CART_STRIDE }; // cart: one ox stride = 1/6 of a wheel turn (r ≈ 0.27, circumference 1.695)                 // ground per cycle (the ram: one wheel turn)
  function soldierPose(e, v){
    const ut = e.utype;
    if (ut === 'tradecart') { const mv = isUnitMoving(e); return { kind: mv ? 'walk' : 'idle', t: mv ? ((v.stride / MIL_STRIDE.cart) % 1 + 1) % 1 : workPhase(e, 'idle'), opt: { unit: ut, eq: null, load: e.carrying > 0 } }; } // the sack while it carries gold
    // (a throw by its phase; else its set-up stage's model, its parts moved to how far set up: trebLive)
    if (ut === 'trebuchet') { const p = trebPose(e), opt = { unit: ut, eq: p.p != null ? { p: p.p } : { s: trebStage(p.s), live: true } }; if (p.p == null) opt.art = p.s;
      return isUnitMoving(e) ? { kind: 'walk', t: ((v.stride * TREB_ROLL / (Math.PI / 2)) % 1 + 1) % 1, opt } : { kind: 'idle', t: 0, opt }; }
    if (ut === 'ram') { const rof = (UNITS.ram && UNITS.ram.rof) || T30(60), cd = e.atkCooldown || 0, opt = { unit: ut, eq: null };
      const swing = e.target && (cd > 0 || inActionRange(e)) ? ((1 - cd / rof + MIL_IMPACT.ram) % 1 + 1) % 1 : null;
      if (isUnitMoving(e)) { const lt = ((v.stride / MIL_STRIDE.roll) % 1 + 1) % 1; return swing != null && cd > 0 ? { kind: 'attack', t: swing, opt, legs: { kind: 'walk', t: lt } } : { kind: 'walk', t: lt, opt }; }
      return swing != null ? { kind: 'attack', t: swing, opt } : { kind: 'idle', t: workPhase(e, 'idle'), opt }; }
    const a = soldierAction(e, v.stride, aTick); if (a.kind === 'attack') a.target = true; return a;   // (render-units: one reading for both views)
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
  window.__povVil = id => { const v = villagers.get(id); return v ? { x: v.x, z: v.z, yaw: v.yaw, key: v.key, rig: !!v.rig, ox: v.rig ? v.rig.root.position.x : v.obj && v.obj.position.x, oz: v.rig ? v.rig.root.position.z : v.obj && v.obj.position.z, oyaw: v.rig ? v.rig.root.rotation.y : v.obj && v.obj.rotation.y } : null; };   // dev: a villager's drawn state (tests)
  // Where each action's target sits in the villager's own frame (tiles, +x ahead): villagerWorkReach (render-units,
  // shared with the 2D) — the model steps in so the tool meets it.
  const workAt = villagerWorkReach;
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
    for (let i = 0; i < n; i++) puffs.push({ p: new THREE.Vector3(x + (Math.random() - 0.5) * 0.12, y, z + (Math.random() - 0.5) * 0.12), s: 0.03, a: 0.7, col: bitCol(col), age: 0 });
  }
  let _usph = null; const unitSphere = () => _usph || (_usph = new THREE.SphereGeometry(1, 8, 6));
  // a chimney's smoke: soft grey puffs rising slowly, drifting, swelling and thinning out (updateFlyers)
  const smokes = [];
  function chimneyPuff(x, y, z){
    smokes.push({ p: new THREE.Vector3(x, y, z), s: 0.035, a: 0.45, col: bitCol('#c9c6c0'), age: 0, dx: 0.04 + Math.random() * 0.03 });
  }
  function oreChips(x, y, z, ang, cols){
    for (let i = 0; i < 5; i++) {
      const sp = 0.5 + Math.random() * 0.4, a2 = ang + Math.PI + (Math.random() - 0.5) * 1.8;
      chips.push({ p: new THREE.Vector3(x, y, z), s: new THREE.Vector3(0.02, 0.016, 0.022), col: bitCol(cols[i % cols.length]), rx: 0, rz: 0, v: new THREE.Vector3(Math.cos(a2) * sp, 0.7 + Math.random() * 0.5, Math.sin(a2) * sp), age: 0 }); }
  }
  function loadModel(kind){
    let f = loadCache.get(kind);
    if (!f) { POLY = 0.6; try { const g = new THREE.Group(); load(g, kind, [0, 0, 0]); addHulls(g, true); f = bakePose(g); } finally { POLY = 1; } loadCache.set(kind, f); }
    return f.clone();
  }
  function updateFlyers(dt){
    for (let i = smokes.length - 1; i >= 0; i--) { const p = smokes[i]; p.age += dt;
      p.p.y += dt * 0.14; p.p.x -= dt * p.dx; p.p.z -= dt * p.dx * 0.6; p.s = 0.035 * (1 + p.age * 1.4);
      p.a = 0.45 * Math.max(0, 1 - p.age / 2.6);
      if (p.age > 2.6) smokes.splice(i, 1); }
    for (let i = puffs.length - 1; i >= 0; i--) { const p = puffs[i]; p.age += dt; p.s = 0.03 * (1 + p.age * 3); p.p.y += dt * 0.08; p.a = Math.max(0, 0.7 - p.age);
      if (p.age > 0.8) puffs.splice(i, 1); }
    if (smokes.length || puffs.length || hazeMesh) bitsDraw(hazeMesh = hazeMesh || bitsMesh(unitSphere(), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }), 400, true), smokes.length && puffs.length ? smokes.concat(puffs) : smokes.length ? smokes : puffs);
    for (let i = flying.length - 1; i >= 0; i--) { // a thrown load: an arc from the hands into the drop-off, a puff where it lands
      const f = flying[i]; f.age += dt; const u = Math.min(1, f.age / f.dur);
      f.obj.position.set(f.a[0] + (f.b[0] - f.a[0]) * u, f.a[1] + (f.b[1] - f.a[1]) * u + f.h * 4 * u * (1 - u), f.a[2] + (f.b[2] - f.a[2]) * u);
      f.obj.rotation.set(0, f.yaw, -0.6 * u);
      if (u >= 1) { puffBurst(f.b[0], f.b[1], f.b[2], 5); scene.remove(f.obj); flying.splice(i, 1); }
    }
  }
  // Place and pose one person or machine; false when its rig isn't built yet (it shows once it is).
  function updateVillager3D(e, dt){
    const now = performance.now();
    let [tx, tz] = posOf(e), ty = -worldFacing(e);
    const rx = tx, rz = tz;                                                         // (its true spot, before any work step-in)
    let v = villagers.get(e.id);
    if (!v) villagers.set(e.id, v = { obj: null, key: '', x: tx, z: tz, yaw: ty, stride: 0, lastT: 0 });
    // At a drop-off the sim holds the villager for its throw (dropThrowPhase, js/logic.js): the throw plays on that clock.
    const tp = e.utype === 'villager' ? dropThrowPhase(e) : null;
    if (tp == null) v.throw = null;
    else if (!v.throw) {
      let best = null, bd = 1.6;                                                    // measured to the footprint's edge, as the sim's drop-off contact (a TC corner is 3.5 tiles from its centre)
      for (const b of entities) if (b.type === 'building' && b.team === e.team && b.complete !== false && dropAccepts(b, e.carryType)) {
        const d = edgeDistToBuilding(e.x, e.y, b); if (d < bd) { bd = d; best = b; } }
      if (best) v.throw = { load: carriedLoad(e), b: best, flew: false };
    }
    let p = e.utype === 'villager' ? villagerPose(e, v) : soldierPose(e, v);
    if (e.id === followId && window.__povFpPose) { const f = window.__povFpPose; p = { ...p, ...f, opt: { ...(p.opt || {}), ...(f.opt || {}) } }; }   // dev: a pinned pose (the first-person gallery)
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
    const vmUnit = e.id === followId && eyeView() && RIG_UNITS(e.utype) && !isMountedUnit(e.utype);
    if (vmUnit && p.kind === 'attack' && e.utype !== 'villager' && !(e.range > 0) && MIL_IMPACT[e.utype] != null) {
      v.fpStrike = ((p.t - MIL_IMPACT[e.utype]) % 1 + 1) % 1;                        // 0 at the hit
      p = p.legs ? { kind: p.legs.kind, t: p.legs.t, opt: p.opt } : { kind: 'idle', t: workPhase(e, 'idle'), opt: p.opt };
    }
    if (vmUnit && VM.force != null) { v.fpStrike = VM.force; if (p.kind === 'attack') p = { kind: 'idle', t: 0, opt: p.opt }; } // dev: a pinned strike phase
    // First person, empty-handed at rest or on the move: the arms that hang out of sight are held ready, low in view
    // (the forager's open hands, still) — a body to look out of. The legs keep their own pose.
    const fpRest = vmUnit && e.utype === 'villager' && /^(idle|walk|flee)$/.test(p.kind);
    if (fpRest) p = { kind: 'forage', t: 0.08, opt: p.opt, legs: p.kind === 'idle' ? null : { kind: p.kind, t: p.t } };
    v.lastPose = fpRest ? 'rest' : p.kind; v.lastLoad = p.opt && p.opt.load; // (dev: __povVM, __povPose)
    if (v.throw) { const b = v.throw.b, bx = b.x + (b.w || 1) / 2, bz = b.y + (b.h || 1) / 2;
      { const t = 0.12 + 0.38 * tp;                                                 // knee dip (0.12) through the follow-through (0.5)
        // It throws standing at the drop, turned to the building
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
      if (!isDrawnMoving(e) || !e.path.length) { ty = -ph; setHeading(e, ph); } // at work: turned to what it works on (a path-less press step into its place is a sidestep)
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
    // (isDrawnMoving, as the 2D's: a press-slide into reach is the walk-in's, not a walk — counted, a returning butcher
    // crouched as it slid in, stood to walk the rest, and crouched again)
    const mv = isDrawnMoving(e), gliding = (tx - (e.x + 0.5)) ** 2 + (tz - (e.y + 0.5)) ** 2 > 1e-6, far = (tx - v.x) ** 2 + (tz - v.z) ** 2 > 4;
    let nx, nz;
    if (T && mv && !e.path.length && !v.throw && e.utype === 'villager' && !far) {
      // pressing into its work spot (the sim's walk-in, a step a tick): drawn on its true, interpolated spot, walking and
      // facing its slide; the last sidestep onto the work spot comes once it stands (below). Aimed at the work spot instead
      // — re-aimed every tick from the stepping spot — it went in a jerk a tick, crouched.
      nx = rx; nz = rz; const d = Math.hypot(nx - v.x, nz - v.z), wk = p.opt && p.opt.load ? 'carry' : 'walk';
      if (d > 1e-5) ty = -Math.atan2(nz - v.z, nx - v.x);
      v.stride += d; p = { kind: wk, t: ((v.stride / WALK_TILES[wk]) % 1 + 1) % 1, opt: p.opt };
    } else if (far || ((mv || gliding) && !T)) { nx = tx; nz = tz;
      // leaving a work spot on the move: the step-in offset walks off (at WALK_IN, game-speed scaled), never pops. The
      // offset is from where the unit truly stood LAST frame (v.prx): measured from its new spot, a rider's own run counted
      // as offset, outran WALK_IN and dragged the drawing behind until it snapped 2 tiles
      const ox = v.x - (v.prx ?? rx), oz = v.z - (v.prz ?? rz), od = Math.hypot(ox, oz);
      if (!far && od > 0.01) { const k = Math.max(0, od - WALK_IN * GAME_SPEED * dt) / od; nx = tx + ox * k; nz = tz + oz * k; }
      if (mv && !T && !v.throw && e.path.length) ty = -Math.atan2(e.path[0].y - e.y, e.path[0].x - e.x); // (a throw keeps facing its drop)
      else if (mv && !T && !v.throw && (nx - v.x) ** 2 + (nz - v.z) ** 2 > 1e-6) ty = -Math.atan2(nz - v.z, nx - v.x);   // (a press into contact, path-less: facing its slide)
    } else if (!mv && !v.throw && e.utype === 'villager' && (tx - v.x) ** 2 + (tz - v.z) ** 2 > 0.03 * 0.03) {
      // A villager off its spot (into a work spot, back out of one) walks there, at a walk, legs and all — a load in
      // hand stays in hand (the carrying walk); never over a throw (it stands for that: held below)
      const dx = tx - v.x, dz = tz - v.z, d = Math.hypot(dx, dz), step = Math.min(d, WALK_IN * GAME_SPEED * dt), wk = p.opt && p.opt.load ? 'carry' : 'walk';
      nx = v.x + dx / d * step; nz = v.z + dz / d * step; v.stride += step;
      if (!T) ty = -Math.atan2(dz, dx);   // (stepping into a work spot: a sidestep, still facing the work — turned to the step, it swung away and back)
      p = { kind: wk, t: ((v.stride / WALK_TILES[wk]) % 1 + 1) % 1, opt: p.opt };
    } else { const f = T ? Math.min(1, dt * 10) : Math.min(1, dt * 14); nx = v.x + (tx - v.x) * f; nz = v.z + (tz - v.z) * f; }
    v.prx = rx; v.prz = rz;
    if (steerActive() && e.id === followId && (mv || (!e.target && !T && !e.task)) || (!T && steeredFacing(e))) { ty = -yaw; setHeading(e, yaw); } // the steered character faces where it's steered, and keeps it
    if (v.throw) { nx = v.x; nz = v.z; }                                            // (held at the drop while it throws)
    if (!T) v.stride += Math.hypot(nx - v.x, nz - v.z);
    v.x = nx; v.z = nz;
    v.yaw += Math.atan2(Math.sin(ty - v.yaw), Math.cos(ty - v.yaw)) * Math.min(1, dt * 8);
    const fpv = e.id === followId && eyeView() && RIG_UNITS(e.utype) && !isMountedUnit(e.utype);   // seen through its own eyes: arms as a viewmodel
    if (RIG_UNITS(e.utype)) { if (!rigPose(v, p.kind, p.t, e.female, p.opt, teamColor(e.team), VIL_STEPS, e.id === followId && eyeView(), p.legs, true)) return false; }
    else { const step = Math.floor(p.t * VIL_STEPS) % VIL_STEPS, key = vilKey(p.kind, step, e.female, p.opt);
      const fr = vilFrame(key, p.kind, step / VIL_STEPS, e.female, p.opt, v);
      if (fr) useVilFrame(v, key, fr, teamColor(e.team));
      if (!v.obj) return false;
      if (p.opt && p.opt.art != null && v.key === key) trebLive(v.obj, p.opt.eq.s, p.opt.art); }
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
  let _vmOverride = null;
  const UNIT_VM = {
    militia: {
      aim: 0.16, down: 0.14, back: -0.34, ease: 2.0, at: [0.26, -0.22], near: 0.22, maxTilt: 0.25,
      // Anchor primarily on the sword hand (right hand) so the shield stays steady on the left
      anchor: (l, r) => r || l
    },
    spearman: {
      aim: 0.24, down: 0.15, back: -0.42, ease: 2.0, at: [0.24, -0.22], near: 0.22, maxTilt: 0.28,
      // Spear: anchor along the forward grip / front shaft so spear points toward crosshair
      anchor: (l, r, pose) => (pose === 'attack' && l && r ? [l[0] * 0.7 + r[0] * 0.3, l[1] * 0.7 + r[1] * 0.3, l[2] * 0.7 + r[2] * 0.3] : (r || l))
    },
    archer: {
      aim: 0.08, down: 0.14, back: -0.36, ease: 2.2, at: [-0.22, -0.18], near: 0.20, maxTilt: 0.25,
      // Bow: anchor on the bow hand (left hand) so the bow stays steady on the left and string draws back
      anchor: (l, r) => l || r,
      poseVM: {
        idle: { at: [-0.24, -0.22], down: 0.16, back: -0.36, aim: 0.08, maxTilt: 0.20 },
        walk: { at: [-0.24, -0.22], down: 0.16, back: -0.36, aim: 0.08, maxTilt: 0.20 }
      }
    },
    villager: {
      aim: 0.10, down: 0.16, back: -0.36, ease: 2.0, at: [0.22, -0.22], near: 0.34, maxTilt: 0.25,
      anchor: (l, r, pose) => /^(rest|carry|drop)$/.test(pose) && l && r ? [0, 1, 2].map(i => (l[i] + r[i]) / 2) : r || l,
      // rest: both hands low and centred; a load: held up at the top of the view, the arms reaching up to it
      poseVM: { rest: { at: [0, -0.4] }, carry: { at: [0, 0.46], back: -0.56 }, drop: { at: [0, 0.46], back: -0.56 }, repair: { back: -0.62, at: [0.2, -0.3] } }
    }
  };
  window.__povUnitVM = UNIT_VM;
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
    const uCfg = UNIT_VM[who.utype] || {};
    const poseCfg = (uCfg.poseVM && uCfg.poseVM[v.lastPose]) || {};
    const vm = { ...VM, ...uCfg, ...poseCfg, ...(_vmOverride || {}) };

    let h = null;
    if (uCfg.anchor && (v.fpHandL || v.fpHandR)) {
      h = uCfg.anchor(v.fpHandL, v.fpHandR, v.lastPose, S);
    }
    if (!h) h = v.fpHands;

    const maxTilt = vm.maxTilt != null ? vm.maxTilt : 0.35;
    const want = h ? Math.max(0, Math.min(maxTilt, Math.atan2(S - h[1], Math.max(0.18, h[0])) - vm.aim)) : 0;
    const first = v.vmTilt == null || !root.userData.vm, e = first ? 1 : Math.min(1, camDt * vm.ease);
    v.vmTilt = first ? want : v.vmTilt + (want - v.vmTilt) * e;
    // where the hands land in camera space at this tilt (x right, y up, −z ahead), and the slide that puts them at vm.at
    const c = Math.cos(v.vmTilt), sn = Math.sin(v.vmTilt), hx = h ? h[0] : 0, hy = h ? h[1] - S : 0;
    const px = h ? h[2] : 0, py = -vm.down + hx * sn + hy * c, pz = vm.back - (hx * c - hy * sn), d = Math.max(0.12, -pz);
    const sh = vm.shift || [0, 0], sx = h ? vm.at[0] * d - px : sh[0], sy = h ? vm.at[1] * d - py : sh[1];
    v.vmSlide = first || !v.vmSlide ? [sx, sy] : [v.vmSlide[0] + (sx - v.vmSlide[0]) * e, v.vmSlide[1] + (sy - v.vmSlide[1]) * e];
    // a wind-up swings the hands back at the lens: the nearer one is held off at vm.near
    let pzN = pz; for (const q of [v.fpHandL, v.fpHandR]) if (q) pzN = Math.max(pzN, vm.back - (q[0] * c - (q[1] - S) * sn));
    const push = Math.max(0, vm.near + pzN);

    camera.updateMatrixWorld();
    // model (x forward, y up, z right) → camera (−z forward, y up, x right), turned forward by the tilt about the shoulders
    _vm.r.set(0, 0, 1, 0,  0, 1, 0, 0,  -1, 0, 0, 0,  0, 0, 0, 1).multiply(_vm.t.makeRotationZ(v.vmTilt));
    // on the move the hands sway with the stride (side to side, a dip at each step), eased in and out
    v.vmBob = (v.vmBob || 0) + ((isUnitMoving(who) ? 1 : 0) - (v.vmBob || 0)) * Math.min(1, camDt * 6);
    const ph = v.stride * 5, bx = Math.sin(ph) * 0.014 * v.vmBob, by = -Math.abs(Math.cos(ph)) * 0.012 * v.vmBob;
    _vm.m.copy(camera.matrixWorld).multiply(_vm.t.makeTranslation(v.vmSlide[0] + bx, -vm.down + v.vmSlide[1] + by, vm.back - push));
    const sw = v.rig && v.rig.T.fpSwing, own = v.fpStrike != null && sw && sw.length;   // a shield arm holds still: only the sword arm's bones swing
    if (v.fpStrike != null) { const [pu, ro, fw] = strikeSwing(v.fpStrike, who.utype === 'spearman');
      _vm.k = (_vm.k || new THREE.Matrix4()).makeTranslation(0, 0, -fw).multiply(_vm.t.makeRotationX(pu)).multiply(_vm.t.makeRotationZ(ro));
      if (!own) _vm.m.multiply(_vm.k); }
    _vm.r.multiply(_vm.t.makeTranslation(0, -S, 0));                                  // (model → the shoulders' camera frame)
    if (own && v.posedFrame === frame) { // the same swing, about the same pivot, moved into model space: Q = R⁻¹·K·R on just those bones
      _vm.q = (_vm.q || new THREE.Matrix4()).copy(_vm.r).invert().multiply(_vm.k).multiply(_vm.r);
      const out = v.rig.sk.boneMatrices; _vm.b = _vm.b || new THREE.Matrix4();
      for (const bi of sw) { _vm.b.fromArray(out, bi * 16).premultiply(_vm.q).toArray(out, bi * 16); } }
    _vm.m.multiply(_vm.r);
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
  // Level of detail: a unit farther than RIG_LOD_FAR tiles from the camera (every unit in the map view; all but the near
  // ones behind or through a unit's eyes) wears a lighter template — fewer sides round its tubes, coarser blobs and
  // lathes (~40% fewer triangles), the same bones, so every pose sample fits both. Near ones keep the full rig.
  const RIG_RAD_LOW = 5, POLY_LOW = 0.35, RIG_LOD_NEAR = 6, RIG_LOD_FAR = 7;
  const rigTemplates = new Map(), rigSamples = new Map();
  let rigSampleUntil = 0, rigTemplateBudget = 0, warmFrames = 0, firstSamples = 0; const FIRST_SAMPLES = 2;
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
  // The same with a team's colour: vertices marked tcw (1 team colour, 2 its light tint) take it from the material, so
  // one template's geometry serves every team and a unit's cloth, skin and team colour are one draw.
  const rigTeamMats = new Map(), HULL_BACK = 0.05;
  const rigTeamMat = (side, tc) => { const k = side + tc; let m = rigTeamMats.get(k);
    if (!m) { m = new THREE.MeshLambertMaterial({ vertexColors: true, side, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      // The outline shell rides in the same mesh (vertices marked hullV, drawn first): black back faces pushed out on
      // screen as hullUnionMat's, and set back in depth by HULL_BACK so the unit's own near parts paint over them —
      // one draw a person. (Small: a deeper set-back sinks the outline into the ground at the feet.)
      // And its surface patterns and armour, as a building's body (bodyMat): `det` picks the layer.
      const scales = DETAIL_IDS.map(k => 1 / DETAIL[k][0]), ND = DETAIL_IDS.length;
      const U = { detailArr: { value: detailLayers() }, detailScales: { value: scales }, detailK: { value: DETAIL_K }, tcA: { value: new THREE.Color(tc) }, tcB: { value: new THREE.Color(lightOf(tc)) }, uHullRes: { value: new THREE.Vector2(1000, 700) }, uHullPx: { value: 2 }, uHullW: { value: HULL } };
      m.onBeforeRender = r => { r.getDrawingBufferSize(U.uHullRes.value); U.uHullPx.value = 1.5 * r.getPixelRatio(); };
      m.onBeforeCompile = sh => { Object.assign(sh.uniforms, U);
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float tcw; attribute float hullV; attribute float det; uniform vec3 tcA; uniform vec3 tcB; uniform vec2 uHullRes; uniform float uHullPx, uHullW; varying float vHull; varying float vDet; varying vec3 vWPos; varying vec3 vWNrm; varying vec2 vDUv;')
          .replace('#include <color_vertex>', '#include <color_vertex>\nif (tcw > 0.5) vColor.rgb = tcw > 1.5 ? tcB : tcA;')
          .replace('#include <project_vertex>', `#include <project_vertex>
            vHull = hullV; vDet = det; vDUv = uv; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vWNrm = mat3(modelMatrix) * objectNormal;
            if (hullV > 0.5) {
              if (dot(objectNormal, objectNormal) > 1e-10) {
                vec2 sd = (projectionMatrix * vec4(normalize(normalMatrix * objectNormal), 0.0)).xy * uHullRes;
                vec2 n2 = sd / max(length(sd), 0.5 * projectionMatrix[1][1] * uHullRes.y);
                float pw = clamp(uHullW * projectionMatrix[1][1] * 0.5 * uHullRes.y / gl_Position.w, uHullPx, uHullPx * 2.2);
                gl_Position.xy += n2 * pw * 2.0 / uHullRes * gl_Position.w;
              }
              vec4 hb = projectionMatrix * vec4(mvPosition.xyz * (1.0 + ${HULL_BACK.toFixed(3)} / length(mvPosition.xyz)), 1.0);
              gl_Position.z = hb.z / hb.w * gl_Position.w;
            }`);
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vHull; varying float vDet; varying vec3 vWPos; varying vec3 vWNrm; varying vec2 vDUv; uniform vec3 tcA; uniform mediump sampler2DArray detailArr; uniform float detailScales[' + ND + ']; uniform float detailK;')
          .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vHull > 0.5 && gl_FrontFacing) discard;')
          .replace('#include <color_fragment>', `#include <color_fragment>
            vec3 an = abs(normalize(vWNrm)); int di = int(max(vDet, 0.0) + 0.5); float arm = step(${ND}.0 - 0.5, vDet);
            vec2 duv = an.y > 0.85 ? vWPos.xz : vec2(an.x > an.z ? vWPos.z : vWPos.x, -vWPos.y);
            vec4 dl = texture(detailArr, vec3(mix(duv * detailScales[min(di, ${ND - 1})], vDUv * vec2(3.0, 1.0), arm), float(di)));
            vec3 worn = max(vec3(0.0), 1.0 - detailK * (1.0 - dl.rgb));
            diffuseColor.rgb = mix(diffuseColor.rgb * mix(vec3(1.0), worn, step(-0.5, vDet)), mix(diffuseColor.rgb, tcA, dl.a) * dl.rgb, arm);`); };
      m.customProgramCacheKey = () => 'rig-team';
      m.userData.tc = tc; tcSwaps.set(m, t => rigTeamMat(side, t)); rigTeamMats.set(k, m); }
    return m; };
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
  function ringGeo(r, RAD = RIG_RAD){
    const pos = [], nrm = [], ring = [], idx = [];
    for (let i = 0; i <= RIG_SEG; i++) for (let j = 0; j <= RAD; j++) { const a = j / RAD * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pos.push(0, c * r, s * r); nrm.push(0, c, s); ring.push(i); }
    for (let i = 0; i < RIG_SEG; i++) for (let j = 0; j < RAD; j++) { const a = i * (RAD + 1) + j, b = a + RAD + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1); }                            // wound outward (frame T, N, B right-handed)
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3)); g.setIndex(idx);
    return { g, ring };
  }
  // Build a template from a full (non-light) frame.
  function rigTemplate(kind, t, female, opt, low = false){
    POLY = low ? POLY_LOW : 0.6; RIG_NOHULL = true; if (low) HEAD_RES = HEAD_RES_LOW; let g;
    try { g = animFrame(kind, t, female, opt); } finally { POLY = 1; RIG_NOHULL = false; HEAD_RES = HEAD_RES_FULL; }
    g.updateMatrixWorld(true);
    const parts = rigParts(g), B = new Map(), s = new THREE.Vector3(), inv = new THREE.Matrix4();
    let bone = 0; const fpBones = [], fpFold = [], fpSwing = [];
    for (const p of parts) {
      if (p.o.userData.fpHide) for (let i = 0; i < (p.tube ? RIG_SEG + 1 : 1); i++) fpBones.push(bone + i); // (a tube: all its ring bones)
      if (p.o.userData.fpSwing) for (let i = 0; i < (p.tube ? RIG_SEG + 1 : 1); i++) fpSwing.push(bone + i);
      if (p.tube && p.o.userData.fpForearm) fpFold.push({ bone, side: p.o.userData.fpSide || 1 });
      if (p.tube) { // rings: surface and a fatter outline ring, both on the ring bones
        for (const [r, m, ord] of [[p.tube.r, p.o.material || mat(p.tube.col), 2], [p.tube.r, hullUnionMat, 1]]) { // (the outline ring: pushed out on screen)
          const { g: rg, ring } = ringGeo(r, low ? RIG_RAD_LOW : RIG_RAD), { b, base } = rigAdd(B, m, ord, rg, 0, null);
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
        const hg = hullGeometry(o.userData.hullGeo, s, o.userData.hullW || HULL, null, 'skinned');
        if (hg) { const { b, base } = rigAdd(B, hullUnionMat, 1, hg, bone, null); rigIndex(b, base, hg); hg.dispose(); } }
      for (const c of o.children) if (c.isLineSegments) { const { b, base } = rigAdd(B, c.material, 3, c.geometry, bone, null); b.lines = true; rigIndex(b, base, c.geometry); } // edge ink (posts), on the part's bone
      bone++;
    }
    // Plain-coloured parts (skin, cloth, leather, wood: no texture, no team colour, opaque) go in ONE mesh per side,
    // coloured per vertex — a unit is a handful of draws, not one per colour
    // (low: steel and gold join them too — their sheen is a pixel or two at that distance, and it saves a draw a unit)
    // (a mat() colour — plain or patterned, the owner's or not — or a soldier's armour: all one body)
    const hexOf = m => '#' + m.color.getHexString(), arm = m => m.userData.armor;
    const tcw = m => arm(m) || !tcSwaps.has(m) ? 0 : hexOf(m) === VIL_TC ? 1 : hexOf(m) === lightOf(VIL_TC) ? 2 : 0;
    const detOf = m => arm(m) ? DETAIL_IDS.length + ARMOR_IDS.indexOf(arm(m).kind) : m.userData.detail ? DETAIL_IDS.indexOf(m.userData.detail) : -1;
    const plain = m => arm(m) ? true : (m.isMeshLambertMaterial || (low && m.isMeshPhongMaterial)) && !m.map && !m.transparent && (!tcSwaps.has(m) || tcw(m)) && !HULL_MATS.has(m) && (m.userData.plain || m.userData.detail); // (a mat() colour: fog is patched on at draw, on the merged one too)
    // (one-sided and two-sided parts together, drawn two-sided: a closed part's back faces are hidden behind its front)
    { const group = [...B.entries()].filter(([, b]) => !b.lines && b.order === 2 && plain(b.mat));
      const side = group.some(([, b]) => b.mat.side === THREE.DoubleSide) ? THREE.DoubleSide : THREE.FrontSide;
      if (group.length) {
      // (the outline shells first: the body's own triangles then paint over them)
      const m = { mat: rigTeamMat(THREE.DoubleSide, VIL_TC), order: 2, pos: [], nrm: [], uv: [], bone: [], idx: [], col: [], tcw: [], hull: [], det: [] };
      for (const [k, b] of [...B.entries()].filter(([, b]) => b.mat === hullUnionMat && !b.lines)) { const base = m.pos.length / 3;
        m.pos.push(...b.pos); m.nrm.push(...b.nrm); m.uv.push(...b.uv); m.bone.push(...b.bone);
        for (let i = 0; i < b.pos.length / 3; i++) { m.col.push(0, 0, 0); m.tcw.push(0); m.hull.push(1); m.det.push(-1); }
        for (const i of b.idx) m.idx.push(i + base); B.delete(k); }
      m.hullIdx = m.idx.length;
      for (const [k, b] of group) { const base = m.pos.length / 3, c = arm(b.mat) ? new THREE.Color(arm(b.mat).kind === 'chain' ? '#dde3ea' : arm(b.mat).metal) : b.mat.color, shine = b.mat.isMeshPhongMaterial ? 0.6 : 0;
        { const w = tcw(b.mat), d = detOf(b.mat); for (let i = 0; i < b.pos.length / 3; i++) { m.tcw.push(w); m.hull.push(0); m.det.push(d); } }
        m.pos.push(...b.pos); m.nrm.push(...b.nrm); m.uv.push(...b.uv); m.bone.push(...b.bone);
        // (a merged steel/gold part keeps its sheen as a baked glow on the faces turned up toward the overhead view)
        for (let i = 0; i < b.pos.length / 3; i++) { const up = shine * Math.max(0, b.nrm[i * 3 + 1]);
          m.col.push(c.r + (1 - c.r) * up, c.g + (1 - c.g) * up, c.b + (1 - c.b) * up); }
        for (const i of b.idx) m.idx.push(i + base); B.delete(k); }
      B.set('plain|' + side, m);
    } }
    const meshes = [];
    for (const b of B.values()) {
      const geo = new THREE.BufferGeometry(), n = b.pos.length / 3, si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
      if (b.col) geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      if (b.tcw) geo.setAttribute('tcw', new THREE.Float32BufferAttribute(b.tcw, 1));
      if (b.hull) geo.setAttribute('hullV', new THREE.Float32BufferAttribute(b.hull, 1));
      if (b.det) geo.setAttribute('det', new THREE.Float32BufferAttribute(b.det, 1));
      for (let i = 0; i < n; i++) { si[i * 4] = b.bone[i]; sw[i * 4] = 1; }
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3)); geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2)); geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      geo.setIndex(b.idx); geo.userData.rig = true;
      // (its shell and its body apart, for the rims drawn from them — selection, x-ray: views of the same buffers)
      if (b.hull && b.hullIdx) { const view = (a, c) => { const v = new THREE.BufferGeometry(); for (const k in geo.attributes) v.setAttribute(k, geo.attributes[k]); v.setIndex(geo.index); v.setDrawRange(a, c); return v; };
        geo.userData.views = { hull: view(0, b.hullIdx), body: view(b.hullIdx, b.idx.length - b.hullIdx) }; }
      meshes.push({ geo, mat: b.mat, order: b.order, lines: !!b.lines });
    }
    window.__pov3dLab.dispose(g);
    return { meshes, bones: bone, fpBones, fpFold, fpSwing, sig: rigSig(parts), verts: meshes.reduce((a, m) => a + m.geo.attributes.position.count, 0) };
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
  function rigTemplateFor(base, sig, kind, t, female, opt, low = false){
    const k = base + '#' + sig + (low ? '#low' : ''); let T = rigTemplates.get(k);
    if (!T) { if (rigTemplateBudget <= 0) return null; rigTemplateBudget--; const tb = performance.now(); T = rigTemplate(kind, t, female, opt, low); frameParts.tpl = (frameParts.tpl || 0) + performance.now() - tb; if (T.sig !== sig) { console.warn('rig: layout moved', k, T.sig.length, sig.length); return null; } rigTemplates.set(k, T); }   // (parts unlike the sample's: never worn — every bone on the wrong part blows them up)
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
    for (const m of T.meshes) { if (m.lines) continue; const sm = new THREE.SkinnedMesh(m.geo, tc !== VIL_TC ? sw(m.mat) : m.mat); sm.bindMode = 'detached'; sm.bind(sk, id); sm.renderOrder = m.order; sm.frustumCulled = false; if (m.geo.userData.views) sm.userData.viewKeys = [{}, {}]; root.add(sm); }
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
  function rigPose(v, kind, t, female, opt, tc, steps = VIL_STEPS, fp = false, legs = null, lod = false){ // fp: seen through its own eyes — the head parts collapse; legs: {kind, t} the lower body plays instead; lod: may wear the light template far off
    const base = vilKey(kind, 'x', female, opt), u = ((t % 1) + 1) % 1 * steps, s0 = Math.floor(u) % steps, s1 = (s0 + 1) % steps, f = u - Math.floor(u);
    // a fall plays once: its own step, always (a stand-in step from the frame's budget could hold it standing for good);
    // the looping poses share the frame's sampling time
    const once = kind === 'die', until = rigSampleUntil; if (once) rigSampleUntil = Infinity;
    let A = rigSample(base + '@' + s0, kind, s0 / steps, female, opt), Bs = A && (rigSample(base + '@' + s1, kind, s1 / steps, female, opt) || A);
    rigSampleUntil = until;
    // its step not sampled yet (a pose a crowd takes up at once — farmers to their plows — waits its turn): the nearest
    // step of the same pose that is, not the last pose (walking on without the plow)
    let sa = s0;   // (the step A is: its template is made from that step's frame — a pose's parts can come and go
    // between steps (a forager's berry), and a template from another step would put every bone on the wrong part)
    if (!A) for (let d = 1; d <= steps >> 1 && !A; d++) { const p = (s0 + d) % steps, q = (s0 - d + steps) % steps;
      A = rigSamples.get(base + '@' + p); if (A) sa = p; else { A = rigSamples.get(base + '@' + q); if (A) sa = q; } }
    if (A && !Bs) Bs = A;
    // (none yet at all: its first is made past the frame's sampling time, FIRST_SAMPLES a frame — the pose shows at once)
    if (!A && firstSamples > 0) { firstSamples--; rigSampleUntil = Infinity; A = Bs = rigSample(base + '@' + s0, kind, s0 / steps, female, opt); rigSampleUntil = until; }
    if (!A) return !!v.rig;                                                     // keep the last pose until a sample of it is built
    if (lod && !fp) { const d2 = (v.x - camera.position.x) ** 2 + (v.z - camera.position.z) ** 2;   // (hysteresis: no flicker at the edge)
      if (d2 > RIG_LOD_FAR * RIG_LOD_FAR) v.low = true; else if (d2 < RIG_LOD_NEAR * RIG_LOD_NEAR) v.low = false; }
    else v.low = false;
    const T = (v.low && rigTemplateFor(base, A.sig, kind, sa / steps, female, opt, true)) || rigTemplateFor(base, A.sig, kind, sa / steps, female, opt); // (the light one not built yet: the full one)
    if (!T) return !!v.rig;
    if (!v.rig || v.rig.T !== T || v.rig.tc !== tc) {
      // an action whose parts come and go (an arrow drawn, a tool fetched) flips between templates: each unit keeps the
      // few it has used and swaps, never rebuilding (a rebuild is new meshes, bones and x-ray twins — a crowd's worth a frame)
      const rigs = v.rigs || (v.rigs = new Map());
      if (v.rig) scene.remove(v.rig.root);
      let r = rigs.get(T); if (r && r.tc !== tc) { freeRig(r); rigs.delete(T); r = null; }
      if (!r) { const ti = performance.now(); r = takeRig(T, tc) || rigInstance(T, tc); frameParts.inst = (frameParts.inst || 0) + performance.now() - ti; r.tc = tc; rigs.set(T, r);
        if (rigs.size > RIG_KEEP) for (const [k, o] of rigs) if (o !== r) { freeRig(o); rigs.delete(k); break; } }   // (the oldest goes)
      else { rigs.delete(T); rigs.set(T, r); }                                              // (most recent last)
      v.rig = r; scene.add(r.root);
    }
    const out = v.rig.sk.boneMatrices, a = A.m, b = Bs.sig === A.sig ? Bs.m : a;
    if (out.length >= a.length) for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * f; // (three pads the array to its bone-texture size)
    v.posedFrame = frame;   // (the first-person swing adds onto THIS frame's pose only: kept bones already carry it)
    if (legs) { // the walk's lower body under this pose's upper body (legMap)
      const lb = vilKey(legs.kind, 'x', female, opt), lu = ((legs.t % 1) + 1) % 1 * steps, l0 = Math.floor(lu) % steps, l1 = (l0 + 1) % steps, lf = lu - Math.floor(lu);
      const LA = rigSample(lb + '@' + l0, legs.kind, l0 / steps, female, opt), LB = LA && (rigSample(lb + '@' + l1, legs.kind, l1 / steps, female, opt) || LA);
      if (LA && out.length >= a.length) {
        const w = LA.m, w2 = LB.sig === LA.sig ? LB.m : w, m = legMap(base + '|' + lb, LA.sig, A.sig, w, a, legs.kind === 'gallop');
        for (let q = 0; q < m.length; q += 3) for (let k = 0; k < m[q + 2] * 16; k++) out[m[q + 1] * 16 + k] = w[m[q] * 16 + k] + (w2[m[q] * 16 + k] - w[m[q] * 16 + k]) * lf;
      }
    }
    if (fp) { for (const bi of T.fpBones) out.fill(0, bi * 16, bi * 16 + 16);
      // The arm, shoulder to hand, as ONE smooth curve: from the hand back through the elbow's side to where the shoulder
      // sits for the lens (below, behind and out to its side — out of view). Every ring is laid square to the curve, so
      // the tube never kinks or shears, whatever the pose's own elbow does.
      const mid = RIG_SEG >> 1;
      _fpA = _fpA || { m: new THREE.Matrix4(), h: new THREE.Vector3(), e: new THREE.Vector3(), s: new THREE.Vector3(), p: new THREE.Vector3(), t: new THREE.Vector3(), n: new THREE.Vector3(), b: new THREE.Vector3() };
      const A = _fpA;
      for (const fold of T.fpFold) { const b0 = fold.bone != null ? fold.bone : fold, E = (b0 + mid) * 16, Hd = (b0 + RIG_SEG) * 16, R0 = b0 * 16;
        const k = Math.hypot(out[Hd], out[Hd + 1], out[Hd + 2]) || 1;                 // (the rings' own scale)
        A.h.set(out[Hd + 12], out[Hd + 13], out[Hd + 14]); A.e.set(out[E + 12], out[E + 13], out[E + 14]);
        A.s.set(out[R0 + 12] - FP_ARM * 0.4, out[R0 + 13] - FP_ARM * 0.75, out[R0 + 14] * 1.15);
        A.n.set(0, 0, 0);
        for (let i = 0; i <= RIG_SEG; i++) { const u = i / RIG_SEG, w = 1 - u;        // u: 0 at the shoulder, 1 at the hand
          A.p.copy(A.s).multiplyScalar(w * w).addScaledVector(A.e, 2 * u * w).addScaledVector(A.h, u * u);
          A.t.copy(A.e).sub(A.s).multiplyScalar(w).addScaledVector(A.b.copy(A.h).sub(A.e), u).normalize();
          if (!i) A.n.set(0, 1, 0).addScaledVector(A.t, -A.t.y); else A.n.addScaledVector(A.t, -A.n.dot(A.t));   // (carried along the curve: no twist)
          if (A.n.lengthSq() < 1e-8) A.n.set(0, 0, 1).addScaledVector(A.t, -A.t.z);
          A.n.normalize(); A.b.crossVectors(A.t, A.n);
          A.m.makeBasis(A.t.clone().multiplyScalar(k), A.n.clone().multiplyScalar(k), A.b.clone().multiplyScalar(k)).setPosition(A.p).toArray(out, (b0 + i) * 16); } }
      if (T.fpFold.length) {
        const hs = [0, 0, 0];
        v.fpHandL = null; v.fpHandR = null;
        for (let fi = 0; fi < T.fpFold.length; fi++) {
          const fold = T.fpFold[fi], b0 = fold.bone != null ? fold.bone : fold, side = fold.side != null ? fold.side : (fi === 0 ? -1 : 1);
          for (let k = 0; k < 3; k++) hs[k] += out[(b0 + RIG_SEG) * 16 + 12 + k];
          const pt = [out[(b0 + RIG_SEG) * 16 + 12], out[(b0 + RIG_SEG) * 16 + 13], out[(b0 + RIG_SEG) * 16 + 14]];
          if (side < 0) v.fpHandL = pt; else v.fpHandR = pt;
        }
        v.fpHands = hs.map(x => x / T.fpFold.length);
      } else {
        v.fpHands = null; v.fpHandL = null; v.fpHandR = null;
      } }
    v.obj = v.rig.root;
    return true;
  }
  window.__povRigLab = (kind, t, opt, tc = VIL_TC, female = false, legs = null) => { rigSampleUntil = Infinity; rigTemplateBudget = 9; const v = {}; const sc0 = scene; scene = { add(){}, remove(){} };
    try { rigPose(v, kind, t, female, opt || {}, tc, VIL_STEPS, false, legs); } finally { scene = sc0; } return v.rig && v.rig.root; };
  const RIG_KEEP = 6; // rigs a unit keeps to swap between (rigPose)
  // A rig let go (its unit out of view, a pose's spare) is KEPT by template and colour and the next unit needing one takes
  // it: a pan re-made every villager coming back into view — new skinned meshes, bones, a bone texture each. (A faded one,
  // a dying unit's, has its own see-through materials: freed.)
  const rigPool = new Map(), RIG_POOL_PER = 8;
  function freeRig(r){ scene.remove(r.root);
    let faded = false; r.root.traverse(o => { if (o.userData.fadeOwn) faded = true; });
    let m = rigPool.get(r.T); if (!m) rigPool.set(r.T, m = new Map()); let L = m.get(r.tc); if (!L) m.set(r.tc, L = []);
    if (!faded && L.length < RIG_POOL_PER) { L.push(r); return; }
    disposeRig(r); }
  function disposeRig(r){ disposeFaded(r.root); if (r.sk.boneTexture) r.sk.boneTexture.dispose(); }
  function takeRig(T, tc){ const m = rigPool.get(T), L = m && m.get(tc), r = L && L.length ? L.pop() : null; if (r) r.root.visible = true; return r; }
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
  // Effects (dust, chips, smoke, debris, fire) age on GAME time, as the 2D particles do — sim events spawn them, so on a
  // wall clock a faster game piled them up. In seconds at the 2x speed they were tuned at; 0 while paused.
  let fxDt = 0;
  const tickPos = new Map();
  function clockFrame(now){
    const r0 = rTick;
    if (rateTick < 0 || tick < rateTick || tick - rateTick > 200) { rateTick = tick; rateAt = now; rTick = tick - 1; }
    else if (now - rateAt > 250) { const r = (tick - rateTick) / (now - rateAt); tickRate = tickRate * 0.6 + r * 0.4; rateTick = tick; rateAt = now; } // ticks per ms, over ¼s windows
    const dt = lastClock ? Math.min(100, now - lastClock) : 0; lastClock = now;
    rTick += dt * tickRate;
    const target = tick - 1;                                                  // a tick behind: the next position is always known
    rTick += (target - rTick) * Math.min(1, dt / 400);                         // eased back toward it (no pops)
    rTick = Math.max(tick - 2.5, Math.min(tick, rTick));
    aTick = rTick * (30 / TPS);
    fxDt = r0 < 0 ? 0 : Math.min(1, Math.max(0, rTick - r0) / (TPS * 2));
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
  const _uFr = {}, drawnUnits = new Set();   // (drawnUnits: this frame's modelled units — the overlay's HP bars follow them)
  // An animal's model is costly to make (modelled, outlined, baked: the dragon a frame's worth), and every animal
  // leaving the camera's range and coming back — all through a pan — was made again. So a model let go is KEPT, hidden,
  // by its kind, and the next animal of that kind takes it; a match's start makes the dragon's ahead of time
  // (prewarmDragon). (Never one that died: a death pose stays in its parts.) A model is the same for every owner — a
  // sheep's owner shows only in its band, recoloured in place (animalTint): keyed by colour, a herd changing hands was
  // all rebuilt, a dragon taken for a ride rebuilt for nothing.
  const keptModels = new Map(), KEPT_PER_KEY = 24;
  function animalTint(model, utype, tc){
    if (utype !== 'sheep') return; const b = namedPart(model, 'band'); if (!b) return;
    const m = mat(tc === teamColor(GAIA_TEAM) ? '#f2eddd' : tc); if (b.material !== m) b.material = m; }
  const keptTake = key => { const L = keptModels.get(key); return L && L.length ? L.pop() : null; };
  function animalBuild(utype, tc){ const g = animalModel(utype, tc); addHulls(g, true); bakeRigid(g, utype === 'sheep' ? SHEEP_LOOSE : null); scene.add(g); return g; }
  function dropAnimal(a){
    if (a.obj) quenchDragonFire(a.obj);
    // (a carcass keeps for another carcass only: its pose is re-laid each frame from its age and what's left — deathPose, harvestPose)
    const k = a.deadAt ? (a.key === 'sheep' ? 'sheep:dead' : null) : a.key;
    if (a.obj && k) { const L = keptModels.get(k) || []; if (L.length < (k === 'dragon' ? 1 : KEPT_PER_KEY)) { a.obj.visible = false; L.push(a.obj); keptModels.set(k, L); return; } }
    dropSolid(a);
  }
  function prewarmDragon(){
    if (!entities.some(e => e.utype === 'dragon')) return;
    if ((keptModels.get('dragon') || []).length || [...animals.values()].some(a => a.key === 'dragon')) return;
    const g = animalBuild('dragon', teamColor(GAIA_TEAM)); g.visible = false; keptModels.set('dragon', [g]);
    warmCompile(g).catch(() => {});
  }
  function updateUnits(){
    const now = performance.now(), dt = lastUnitsAt ? Math.min(0.1, (now - lastUnitsAt) / 1000) : 0;
    lastUnitsAt = now;
    const near = [];
    for (const e of entities) {
      if (e.type !== 'unit') continue;
      if (e.id === followId && eyeView() && !(RIG_UNITS(e.utype) && (e.utype === 'villager' || MIL3D.has(e.utype)))) { // seen through its eyes: a rigged person shows its arms and tool (fp); anything else (an animal too) nothing
        const a = animals.get(e.id);                                            // (HIDDEN, not just left un-updated: a sheep's own body sat
        if (a) a.obj.visible = false;                                           // over the camera, bobbing with every step)
        continue;
      }
      const dx = e.x + 0.5 - camAt.x, dy = e.y + 0.5 - camAt.y, d2 = dx * dx + dy * dy;
      if (d2 > RANGE * RANGE || !unitVisible(e)) continue; // (nothing near the camera is hidden: a tree or unit in the way blocks the view, as it would)
      near.push({ e, d2, k: world ? (e.x + 0.5 - camera.position.x) ** 2 + (e.y + 0.5 - camera.position.z) ** 2 : d2 }); // the world view keeps those nearest the camera
    }
    // The world view's budget goes to units the camera can SEE: in a big battle the RANGE circle held hundreds beside and
    // behind the view, and those nearest the camera took every slot while units on screen got no model (only their HP bar).
    if (world) { _uFr.fr = _uFr.fr || new THREE.Frustum(); _uFr.m = _uFr.m || new THREE.Matrix4(); _uFr.s = _uFr.s || new THREE.Sphere(new THREE.Vector3(), 1.2);
      camera.updateMatrixWorld(); _uFr.fr.setFromProjectionMatrix(_uFr.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      for (const n of near) { _uFr.s.center.set(n.e.x + 0.5, 0.4, n.e.y + 0.5); if (!_uFr.fr.intersectsSphere(_uFr.s)) n.k += 1e6; } }   // (off screen: after every on-screen one)
    near.sort((a, b) => a.k - b.k || a.e.id - b.e.id);
    const used = drawnUnits; used.clear();
    const SU = feat.shadowU; SU.n = 0;
    const WP = wheatPushers.value; let wn = 0;
    for (const { e } of near) { if (wn >= 8) break; const a = animals.get(e.id) || villagers.get(e.id); WP[wn++].set(a ? a.x : e.x + 0.5, a ? a.z : e.y + 0.5, 1, 0.32); }
    for (const b of bladePush) { if (wn >= WHEAT_PUSH) break; WP[wn++].set(b[0], b[1], 0.7, 0.14); }       // scythe blades (last frame's): the stalks part ahead of the edge
    for (; wn < WHEAT_PUSH; wn++) WP[wn].set(1e6, 1e6, 0, 0.32);
    bladePush.length = 0;
    for (const { e, d2 } of near.slice(0, world ? MAX_UNITS_WORLD : MAX_UNITS)) {
      used.add(e.id);
      if (e.utype !== 'sheep_carcass') { // a soft contact shadow under every standing unit
        const r = e.utype === 'bear' ? 0.42 : e.utype === 'sheep' ? 0.3 : isMountedUnit(e.utype) || e.utype === 'ram' || e.utype === 'tradecart' ? 0.4 : e.utype === 'trebuchet' ? 0.6 : 0.2;
        const a = animals.get(e.id) || villagers.get(e.id);
        if (e.utype === 'trebuchet') put('shadowU', a ? a.x : e.x + 0.5, 0.007, a ? a.z : e.y + 0.5, 2 * UNIT_SHADOW.trebuchet.len, 1, 2 * UNIT_SHADOW.trebuchet.wid, -worldFacing(e));   // (the 2D's oval, along its heading)
        else if (e.utype === 'dragon') put('shadowU', a ? a.x : e.x + 0.5, 0.007, a ? a.z : e.y + 0.5, 2 * UNIT_SHADOW.dragon.len, 1, 2 * UNIT_SHADOW.dragon.wid, -worldFacing(e)); // (2D's oval, along its heading)
        else put('shadowU', a ? a.x : e.x + 0.5, 0.007, a ? a.z : e.y + 0.5, 2 * r, 1, 2 * r);
      }
      if (ANIMAL_MODELS[e.utype]) { // 3D, posed live from its state
        const dead = e.utype === 'sheep_carcass', kind = dead ? 'sheep' : e.utype; // a carcass keeps its sheep, toppled
        const key = kind, [tx, tz] = posOf(e);
        let a = animals.get(e.id);
        const ty = dead && a ? a.yaw : -worldFacing(e); // the fallen keep the heading they died with
        // a rebuild (its colour changed: a slain sheep's tuft goes to nobody's white) keeps its life — else a sheep seen
        // alive came back already lying, its fall skipped
        let life = null; if (a && a.key !== key) { life = { alive: a.alive, deadAt: a.deadAt }; dropAnimal(a); a = null; }
        if (!a) { const g = (dead && keptTake('sheep:dead')) || keptTake(key) || animalBuild(e.utype, teamColor(e.team)); g.visible = true; animals.set(e.id, a = { obj: g, key, x: tx, z: tz, yaw: ty, phase: 0, gait: 0, graze: 0, ...life }); }
        animalTint(a.obj, kind, teamColor(e.team));
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
          a.bones = a.bones || carcassBones.get(a.obj) || carcassBones.set(a.obj, sheepBones(a.obj)).get(a.obj);
          harvestPose(a.obj, a.bones, Math.max(0, Math.min(1, e.hp / (e.maxHp || 100))));
        }
        else { a.alive = true; animateAnimal(a.obj, e, a, dt); }
        continue;
      }
      // every unit is a 3D model (a person's rig, a machine's, an animal's): one whose rig isn't built yet shows once it is
      if (e.utype === 'villager' || MIL3D.has(e.utype)) updateVillager3D(e, dt);
    }
    SU.mesh.count = SU.n; sendInst(SU.mesh, SU.n);
    for (const [id, a] of animals) if (!used.has(id)) { dropAnimal(a); animals.delete(id); }
    for (const m of burning) { const F = m.userData.fire; if (F.seen !== fireFrame) dragonFire(m, null, 0, fxDt); if (!F.puffs.length) burning.delete(m); }
    fireFrame++;
    for (const [id, v] of villagers) if (!used.has(id)) { dropVillager(v); villagers.delete(id); }
    if (frame % 120 === 0) for (const id of tickPos.keys()) if (!entitiesById.has(id)) tickPos.delete(id);
    updateCorpses(used);
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
      // (the dragon ridden flies along the view, over anything)
      if (dragonAloft(e)) { const px = +(e.x + cx * 4).toFixed(3), py = +(e.y + cy * 4).toFixed(3);
        if (!lastMove || Math.hypot(lastMove.x - px, lastMove.y - py) > 0.35 || now - lastMoveAt > 600) { submitCommand({ kind: 'steer', unitId: e.id, x: px, y: py }); lastMove = { x: px, y: py }; lastMoveAt = now; }
        return; }
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
    // (the dragon ridden: fire, where the rider looks)
    if (e.utype === 'dragon') { if (e.rideLeft !== undefined) submitCommand({ kind: 'dragon-fire', unitId: e.id, ang: +yaw.toFixed(3) }); return false; }
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
  // The 2D map's zoom and the world view's distance are ONE setting: a tile is drawn as wide in both (as near as their
  // ranges allow) — across the view the map shows 64·ZOOM px to a tile's diagonal, the lens (H/2)/tan(FOV/2)/oDist to a
  // tile — so the zoom carries over a switch of view either way.
  const zoomK = () => ((renderer && renderer.domElement.clientHeight) || window.innerHeight || 800) / 2 / Math.tan(ORBIT_FOV * Math.PI / 360) / (64 / Math.SQRT2);
  function distFromZoom(){ oDist = Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, zoomK() / ZOOM)); }
  function zoomFromDist(){ const { ax, ay } = zoomAnchor(); setZoomAroundPoint(zoomK() / oDist, ax, ay); }   // (about the view's centre: the camera stays put)
  const mapCenter = () => fromIso(camX, camY);                          // map coords of the 2D camera, unrounded (screenToMap rounds to whole pixels: a fine swipe would step)
  function panTo(x, y){ // map coords
    // (ONE limit, clampCamera's — js/input.js: a tighter one here snapped the view back onto the map whenever a zoom
    // or key pan followed a swipe that had glided past a corner)
    const iso = toIso(x, y); camX = iso.ix; camY = iso.iy; clampCamera(); window.targetCamX = camX; window.targetCamY = camY; window.cameraFollowId = null;
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
    blendMs = 1000; unfollow(); oDist = ORBIT_MIN; zoomFromDist();
    if (at) { panTo(at[0] - 0.5, at[1] - 0.5); eye = { x: at[0], y: at[1] }; }
  }
  function applyZoom(){
    const f = Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, oDist * zoomBy)) / oDist; zoomBy = 1;
    if (f !== 1 && followId == null && eye && zoomAt) { const g = pick(zoomAt.x, zoomAt.y).map, cx = eye.x - 0.5, cy = eye.y - 0.5;
      // (the shift goes to the camera AND the eased view alike, so the view keeps whatever it trails the camera by: set
      // onto the camera, a zoom in mid-glide skipped the view ahead)
      const c0 = mapCenter(); panTo(c0.x + (1 - f) * (g.x - cx), c0.y + (1 - f) * (g.y - cy)); const c = mapCenter(); eye.x += c.x - c0.x; eye.y += c.y - c0.y; }
    oDist *= f;
    if (f !== 1) zoomFromDist();
  }
  // A mode or character switch glides the camera from where it was to the new view (position, the shortest turn, lens)
  // rather than cutting; each frame blends toward the live target, so the view it lands on is the one it keeps.
  const BLEND_MS = 600; let camFrom = null, camKey = null, camLast = null, _bq = null, blendMs = BLEND_MS;
  // Through the eyes for drawing: the mode is 'eye' AND the camera has got there — the glide in from behind shows the
  // whole body until the last stretch (collapsing it the moment the mode flipped left a headless body in view).
  const EYE_SHOWN_AT = 0.85;
  function eyeView(){
    if (mode !== 'eye') return false;
    if (camKey !== 'eye|' + followId) return false;   // (the glide hasn't started yet: still the view from behind)
    return !camFrom || (performance.now() - camFrom.t0) / camFrom.ms >= EYE_SHOWN_AT;
  }
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
  let camShake = 0, rideH = 1.7;   // rideH: the eye's height on a dragon's back
  function shakeFrom(x, z, amp){ if (!camAt) return; const d = Math.hypot(x - camAt.x, z - camAt.y); camShake = Math.max(camShake, amp * Math.max(0, 1 - d / 18)); }
  window.__povShake = (x, y, mag) => shakeFrom(x + 0.5, y + 0.5, 0.025 * mag);   // (render-fx shakeView: a stone landing)
  // A scripted camera (tools: trailer capture): read or set the world view's orbit and the eye's pitch. Viewer-only.
  window.__pov3dCam = { get: () => ({ yaw: oYaw, pitch: oPitch, dist: oDist, mode, fpPitch, yawEye: yaw }),
    set: o => { if (o.yaw != null) oYaw = o.yaw; if (o.pitch != null) oPitch = o.pitch; if (o.dist != null) oDist = o.dist;
      if (o.mode) mode = o.mode; if (o.fpPitch != null) fpPitch = o.fpPitch; if (o.yawEye != null) yaw = o.yawEye; } };
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
      // just behind the (hidden) head: the arms and tool fall in view. A rider sits a little higher and further back, so the
      // horse's neck lies below the view rather than rising up the middle of it (close up, a wide lens stretched it tall)
      const mounted = isMountedUnit(e.utype), fwd = mounted ? -0.56 : RIG_UNITS(e.utype) ? -0.12 : 0;
      let h = mounted ? 1.2 : e.utype === 'ram' ? 0.8 : e.utype === 'trebuchet' ? 1.3 : 0.58;
      // the dragon: from its back — over the treetops and roofs once aloft (eased with the take-off and the landing)
      if (e.utype === 'dragon') { const to = dragonAloft(e) ? 3.6 : 1.7; rideH += (to - rideH) * Math.min(1, camDt * 1.6); h = rideH; }
      camAt = { x: eye.x, y: eye.y };
      camera.position.set(eye.x + cx * fwd, h, eye.y + cy * fwd);
      const pc = Math.cos(fpPitch);
      camera.lookAt(eye.x + cx * pc * 10, h + Math.sin(fpPitch) * 10, eye.y + cy * pc * 10);
    }
    const orbit = mode === 'orbit' || !e, fov = orbit ? ORBIT_FOV : mode === 'chase' ? 55 : isMountedUnit(e.utype) ? 60 : 70;
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
    drawFrame(now);   // (units at the render clock, between their recorded tick spots: posOf — never inside render.js's
                      // withDrawPositions, whose mid-tick positions would be recorded as tick spots and walk unevenly)
  }
  function drawFrame(now){
    updateHills(1 / 60);
    let e = followId != null ? entitiesById.get(followId) : null;
    if (followId != null && (!e || e.type !== 'unit' || e.hp <= 0 || e.garrisonedIn || (steering && e.team !== myTeam))) {
      // fallen (or gone, or no longer the player's: a dragon whose ride is over): the view lets go — no handover to another unit; the world view back to its map camera
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
    bakesLeft = 1; rigSampleUntil = performance.now() + 1.5; rigTemplateBudget = 1; firstSamples = FIRST_SAMPLES; frameParts.tpl = 0; frameParts.inst = 0; frameParts.samp = 0; frameParts.pose = 0;
    if (warmFrames > 0) { if (warmFrames === 1) { prewarmDragon(); warmedKinds.clear(); warmQueue.length = 0; prewarmShapes(); } warmFrames--; bakesLeft = rigTemplateBudget = Infinity; rigSampleUntil = Infinity; } // a match's first frames: every unit in its real rig at once (no stand-ins turning into place); the building warm-up only queued (one kind a frame, a second on)
    else if (unrevealed) { bakesLeft = rigTemplateBudget = Infinity; rigSampleUntil = Infinity; }   // a switch from 2D: its first frame whole, drawn while the 2D still shows
    if (steering && e) { steer(e, dt); actHeldTick(e, performance.now()); }
    const t0 = performance.now();
    if (groundFor !== map || groundData.length !== MAP * MAP * 4) { buildGround(); lastStatic = 0; }
    camDt = dt || 1 / 60; updateCamera(e);
    { const fp = world && mode === 'eye' && e != null; if (fp !== fpDimmed) { fpDimmed = fp; const mw = document.getElementById('minimap-wrap'); if (mw) mw.classList.toggle('fp-active', fp); } } // first person: the minimap steps back (styles.css)
    // on the cadence, or at once when the view has moved a few tiles (a jump: the new place mustn't wait for it)
    const P = frameParts, mark = k => { const n = performance.now(); P[k] = n - P._t; P._t = n; }; P._t = performance.now(); // (the last frame's time by part: __povFrame)
    if (now - lastStatic > STATIC_MS || !staticAt || (eye.x - staticAt.x) ** 2 + (eye.y - staticAt.y) ** 2 > 9) {
      const t1 = performance.now(); refreshGround(); const t2 = performance.now(); refreshFeatures(); const t3 = performance.now(); refreshBuildings(); if (bldLeft) lastLoad = frame; refreshButtons();
      P.sGround = t2 - t1; P.sFeat = t3 - t2; P.sBld = performance.now() - t3;   // (the static refresh by part: __povFrame)
      lastStatic = now; staticAt = { x: eye.x, y: eye.y }; }
    else { P.sGround = P.sFeat = P.sBld = 0; if (viewTurned()) refreshFeatures(); if (bldLeft) { refreshBuildings(); lastLoad = frame; } else if (frame - lastLoad < 60) {} else if (warmQueue.length) warmStep(); else if (frame % 60 === 0) prewarmShapes(); }
    mark('static');
    animateFeatures(fxDt);
    updateArrows(now);
    clouds.position.set(camera.position.x, 0, camera.position.z); clouds.rotation.y = aTick * 0.00004;
    animateModels(fxDt); mark('models');
    updateUnits(); for (const m of [villagers, animals, corpseModels]) for (const r of m.values()) standUpright(r.obj); mark('units');
    updateXray(); updateSelection();
    if (world) updateGhost(); mark('fx');
    const t1 = performance.now();
    cullRigs();
    // (drawn from the camera raised over the hills — camLift; back to the flat frame for everything else)
    camera.position.y += camLift; camera.updateMatrixWorld(); renderer.render(scene, camera); camera.position.y -= camLift; camera.updateMatrixWorld(); mark('render');
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
    { const r = document.querySelector('input[name="viewmode"][value="' + (on ? '3d' : '2d') + '"]'); if (r) r.checked = true; } // the Options switch shows it
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
  function project(x, y, z){ _v3.set(x, elevAny ? y + groundH(x, z) - camLift : y, z).project(camera);   // (what stands at (x, z) is drawn that much higher: initHills)
    const r = renderer.domElement.getBoundingClientRect();
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
    const a = villagers.get(u.id) || animals.get(u.id); return a ? [a.x, a.z] : posOf(u); }
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
      if (dragonInHand(u)) continue;   // (a click goes through the dragon in hand: js/input.js)
      const [x, z] = drawnAt(u); if ((x - camAt.x) ** 2 + (z - camAt.y) ** 2 > RANGE * RANGE) continue;
      const rect = screenRect(u, x, z); if (!rect) continue;
      const r = test(u, rect, x, z);
      if (r != null) out.push({ u, d: r });
    }
    return out;
  }
  const RES_PARTS = ['trunk', 'crown0', 'crown1', 'crown2', 'stump', 'gold', 'stone', 'puff', 'berry'];
  function pick(cx, cy){
    if (!_ray) { _ray = new THREE.Raycaster(); _ray.layers.enable(RUN_LAYER); } _ndc = _ndc || new THREE.Vector2(); _v3 = _v3 || new THREE.Vector3();
    const r = renderer.domElement.getBoundingClientRect();
    _ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height * 2 - 1));
    _ray.setFromCamera(_ndc, camera);
    const o = _ray.ray.origin, d = _ray.ray.direction;
    let tg = d.y < -1e-4 ? -o.y / d.y : 200, gx = o.x + d.x * tg, gz = o.z + d.z * tg;
    // Hills: the ground the ray meets (found by stepping onto the height under each guess: it settles), then the ray
    // lowered by that height — into the flat frame of whatever stands there, which is drawn that much higher.
    if (elevAny && d.y < -1e-4) { for (let k = 0; k < 8; k++) { tg = (groundH(gx, gz) - camLift - o.y) / d.y; gx = o.x + d.x * tg; gz = o.z + d.z * tg; }
      o.y -= groundH(gx, gz) - camLift; }
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
      oDist = Math.max(ORBIT_MIN, Math.min(ORBIT_MAX, drag.dist * r)); zoomFromDist(); return; }
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
  // "behind" = behind the camera, judged in view space: past the FAR plane (an ally Market across the map) still
  // projects to its true spot — NDC z > 1 lumped the two together, and such a point became a sentinel corner.
  const ovProj = (x, h, z) => { _v3.set(x, elevAny ? h + groundH(x, z) - camLift : h, z).applyMatrix4(camera.matrixWorldInverse); const behind = _v3.z > -camera.near;
    _v3.applyMatrix4(camera.projectionMatrix); return { sx: (_v3.x + 1) / 2 * ov.clientWidth, sy: (1 - _v3.y) / 2 * ov.clientHeight, behind }; };
  // An order line's two ground points as a SEGMENT (render.js worldSegmentScreen): clipped where it crosses the camera's
  // near plane, so an end behind the camera bends nothing — projected alone it was a sentinel, and the line pointed off
  // to the top-left corner whatever the real direction. Both ends behind: nothing to draw.
  let _sa = null, _sb = null;
  const ovSegment = (ax, ay, bx, by) => {
    _sa = _sa || new THREE.Vector3(); _sb = _sb || new THREE.Vector3();
    const lift = (x, z) => elevAny ? groundH(x, z) - camLift : 0;
    _sa.set(ax, lift(ax, ay), ay).applyMatrix4(camera.matrixWorldInverse); _sb.set(bx, lift(bx, by), by).applyMatrix4(camera.matrixWorldInverse);
    const zn = -camera.near * 1.05, inA = _sa.z < zn, inB = _sb.z < zn;      // (view space looks down -z)
    if (!inA && !inB) return null;
    if (!inA) _sa.lerp(_sb, (zn - _sa.z) / (_sb.z - _sa.z));               // slide the hidden end along to the plane
    if (!inB) _sb.lerp(_sa, (zn - _sb.z) / (_sa.z - _sb.z));
    const P = v => { v.applyMatrix4(camera.matrixWorld).project(camera); return { x: (v.x + 1) / 2 * ov.clientWidth, y: (1 - v.y) / 2 * ov.clientHeight }; };
    return [P(_sa), P(_sb)];
  };
  // The signs over things — an idle villager's "?", a locked gate's padlock — as small models in the world (they grow
  // with the zoom, as all else), turned to the camera and bobbing a little; one instanced mesh a kind, and its outline.
  let markMeshes = null; const MARK_PX = 16;
  function markModels(){
    const curve = new THREE.CatmullRomCurve3([[-0.24, 0.72], [-0.15, 0.92], [0.02, 0.98], [0.2, 0.9], [0.25, 0.72], [0.15, 0.56], [0.03, 0.44], [0, 0.28]].map(([x, y]) => new THREE.Vector3(x, y, 0)));
    const ball = (x, y, r) => new THREE.SphereGeometry(r, 12, 8).translate(x, y, 0).toNonIndexed(), GOLD_Q = '#ffd21f';
    const q = tintJoin([[new THREE.TubeGeometry(curve, 24, 0.085, 10).toNonIndexed(), GOLD_Q], [ball(-0.24, 0.72, 0.085), GOLD_Q], [ball(0, 0.28, 0.085), GOLD_Q], [ball(0, 0.08, 0.105), GOLD_Q]]);
    const shell = () => [[new THREE.BoxGeometry(0.62, 0.5, 0.26).translate(0, 0.25, 0).toNonIndexed(), '#e8c84a'],
      [new THREE.TorusGeometry(0.2, 0.055, 8, 16, Math.PI).translate(0, 0.5, 0).toNonIndexed(), '#4a4a4a']];
    // (the keyhole: a mark on each face, a hair proud of it — and no outline of its own)
    const lock = tintJoin(shell().concat([[new THREE.BoxGeometry(0.09, 0.2, 0.27).translate(0, 0.24, 0).toNonIndexed(), '#2a2a2a']])), lockHull = tintJoin(shell());
    const body = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const make = (geo, hg = geo) => { const m = new THREE.InstancedMesh(geo, body, 64), h = new THREE.InstancedMesh(smoothNormals(hg), hullMat, 64);
      for (const o of [m, h]) { o.count = 0; o.frustumCulled = false; scene.add(o); } h.instanceMatrix = m.instanceMatrix; return { m, h }; };
    return { q: make(q), lock: make(lock, lockHull) };
  }
  function drawMarks(marks){
    if (window.__cleanFrame) marks = { q: [], lock: [] };   // (a trailer capture: no HUD cues)
    if (!markMeshes) { if (!marks.q.length && !marks.lock.length) return; markMeshes = markModels(); }
    const t = performance.now() / 1000, cp = camera.position;
    for (const k of ['q', 'lock']) { const M = markMeshes[k], L = marks[k], n = Math.min(L.length, 64);
      for (let i = 0; i < n; i++) { const [x, y, z, s0, id] = L[i], bob = k === 'q' ? 0.025 * Math.sin(t * 2.4 + id) : 0;
        // (never under MARK_PX on screen: far off it stays a sign, close up it is a thing of the world)
        const sz = Math.max(s0, MARK_PX * 2 * Math.hypot(cp.x - x, cp.y - y, cp.z - z) * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, renderer.domElement.clientHeight));
        M.m.setMatrixAt(i, _m.compose(_p.set(x, y + bob, z), _q.setFromAxisAngle(_s.set(0, 1, 0), Math.atan2(cp.x - x, cp.z - z)), _s.set(sz, sz, sz))); }
      M.m.count = M.h.count = n; sendInst(M.m, n); }
  }
  function drawOverlay(){
    ensureOverlay(); _v3 = _v3 || new THREE.Vector3();
    const w = ov.clientWidth, h = ov.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (ov.width !== Math.round(w * dpr) || ov.height !== Math.round(h * dpr)) { ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr); }
    ovx.setTransform(dpr, 0, 0, dpr, 0, 0); ovx.clearRect(0, 0, w, h);
    const sv = { X, W, H, topH, ZOOM, m2s: mapToScreen, seg: worldSegmentScreen };
    try {
      X = ovx; W = w; H = h; topH = 0; ZOOM = 1;
      mapToScreen = (x, y) => { const p = ovProj(x, 0, y); return p.behind ? { sx: -9999, sy: -9999 } : p; };
      worldSegmentScreen = ovSegment;
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
    } finally { window.__pick3D = null; X = sv.X; W = sv.W; H = sv.H; topH = sv.topH; ZOOM = sv.ZOOM; mapToScreen = sv.m2s; worldSegmentScreen = sv.seg; }
    // units: HP bar when damaged (2D: 18×5 over the head), idle villager's "?"
    ovx.lineWidth = 2;
    const marks = { q: [], lock: [] };
    for (const u of entities) {
      if (u.type !== 'unit' || u.hp <= 0 || u.garrisonedIn || !unitVisible(u)) continue;
      if (u.id === followId && mode === 'eye') continue;
      if (world && !drawnUnits.has(u.id)) continue;                              // (no bar floating where no model is drawn)
      const idle = u.team === myTeam && u.utype === 'villager' && !u.task && !u.target;
      if (u.hp >= u.maxHp && !idle) continue;
      const [x, z] = drawnAt(u); if ((x - camAt.x) ** 2 + (z - camAt.y) ** 2 > RANGE * RANGE) continue;
      const top = ovProj(x, (PICK_H[u.utype] || 0.32) * 2 + 0.06, z); if (top.behind) continue;
      if (u.hp < u.maxHp) { const sx = top.sx, y = top.sy - 8;
        ovx.fillStyle = '#000000'; ovx.fillRect(sx - 9, y, 18, 5); ovx.fillStyle = '#300'; ovx.fillRect(sx - 8, y + 1, 16, 3);
        ovx.fillStyle = u.hp / u.maxHp > 0.5 ? '#0c0' : '#c00'; ovx.fillRect(sx - 8, y + 1, 16 * u.hp / u.maxHp, 3); }
      if (idle) marks.q.push([x, (PICK_H[u.utype] || 0.32) * 2 + 0.1, z, 0.24, u.id]);
    }
    // buildings: HP/construction bar, train or research progress, garrison count — above the roof
    _hb = _hb || new THREE.Box3();
    for (const [id, rec] of solids) {
      const e = entitiesById.get(id); if (!e || e.type !== 'building' || e.hp <= 0 || !rec.obj || !rec.obj.visible) continue;
      const f = buildingFogLevel(e); if (!(f === 2 || sameSide(e.team, myTeam))) continue;
      const hurt = e.hp < e.maxHp, busy = (e.queue && e.queue.length) || e.research, garr = e.team === myTeam && e.garrison && e.garrison.length;
      // a locked gate's padlock over its door, as the 2D (only in view: a lock state never shows through the shroud)
      if (e.locked && f === 2 && isGateBtype(e.btype)) { const c = centerOf(e); marks.lock.push([c.x, 16 / HPX + 0.12, c.y, 0.34, id]); }
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
    drawMarks(marks);
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
  let xray = null; const xTwins = new Map(), bTwins = new Map(); // source mesh → twin (a building's: [mask, rim])
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
          r.onBeforeCompile.fow = true; } return r; }, // the ink shell pushed wider: a rim ~1px outside the ink
        // (a building's mask is its whole shape, not only what's hidden: its rim shows only outside it — under a tree's crown —
        // never on the building's own faces, where one part hides another)
        maskB: m({ colorWrite: false, depthTest: false, stencilRef: 2, stencilWriteMask: 2, side: THREE.DoubleSide, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp }), rimB: new Map(),
        rimBOf: t => { let r = xray.userData.rimB.get(t); if (!r) { xray.userData.rimB.set(t, r = screenHull(m({ color: t === 'bad' ? '#ff3020' : teamColor(t), stencilRef: t === 'bad' ? 2 : CROWN_BIT, stencilFuncMask: t === 'bad' ? 0xff : CROWN_BIT | 2, side: THREE.DoubleSide, stencilFunc: t === 'bad' ? THREE.NotEqualStencilFunc : THREE.EqualStencilFunc }), HULL * 2.5, 3));
          r.onBeforeCompile.fow = true; } return r; } };
    }
    const on = world && mode !== 'eye' && !window.__cleanFrame;   // (not through the eyes: team rims through every wall and tree would crowd a first-person view)
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
          const one = (key, geo, hull) => { const mat = skinnedTwin(hull ? xray.userData.rimOf(u.team) : xray.userData.mask, o.isSkinnedMesh);
            let t = xTwins.get(key);
            if (!t || t.geometry !== geo) {
              if (t) xray.remove(t);
              if (o.isSkinnedMesh) { t = new THREE.SkinnedMesh(geo, mat); t.bindMode = 'detached'; t.bind(o.skeleton, o.bindMatrix); }
              else t = new THREE.Mesh(geo, mat);
              t.matrixAutoUpdate = false; t.matrixWorldAutoUpdate = false; t.frustumCulled = false; t.renderOrder = hull ? 1 : 0;
              xTwins.set(key, t); xray.add(t);
            }
            t.material = mat; t.matrix.copy(o.matrixWorld); t.matrixWorld.copy(o.matrixWorld); t.visible = true; t.userData.idle = 0; used.add(key); }; // (the group sits at the origin: local = world)
          // (a rig's one mesh holds its shell and its body: a twin of each)
          const vw = o.geometry.userData.views, vk = o.userData.viewKeys;
          if (vw && vk) { one(vk[0], vw.hull, true); one(vk[1], vw.body, false); }
          else one(o, o.geometry, o.material && o.material.side === THREE.BackSide);
        });
      }
    }
    // A building behind tree crowns: the same rim, round its whole shape (its own surfaces pushed out, as the selection
    // outline's). Drawn before the units' twins, on its own stencil value: a unit's rim still shows over it.
    const usedB = new Set();
    if (on) {
      const M = xray.userData, cam = camera.position;
      const crowned = (x, z) => { const dx = cam.x - x, dz = cam.z - z, dh = Math.hypot(dx, dz) || 1;
        for (let s = 0.5; s <= 2.5; s += 0.5) { const px = x + dx / dh * s, pz = z + dz / dh * s, ty = Math.floor(pz), tx = Math.floor(px), t = map[ty] && map[ty][tx];
          if (t && t.t === TERRAIN.FOREST && t.res > 60 && fog[ty][tx] && 0.3 + (cam.y - 0.3) * s / dh < TREE_H + CROWN_R * 1.2) return true; }
        return false; };
      const twin = (o, i, mat, geo) => { let pr = bTwins.get(o); if (!pr) bTwins.set(o, pr = []);
        let t = pr[i];
        if (!t || t.geometry !== geo) { if (t) xray.remove(t); t = new THREE.Mesh(geo, mat); t.matrixAutoUpdate = false; t.matrixWorldAutoUpdate = false; t.frustumCulled = false; t.renderOrder = i - 2; pr[i] = t; xray.add(t); }
        t.material = mat; t.matrix.copy(o.matrixWorld); t.matrixWorld.copy(o.matrixWorld); t.visible = true; };
      for (const rec of solids.values()) {
        const b = rec.obj && rec.obj.visible && rec.obj.userData.bid != null ? entitiesById.get(rec.obj.userData.bid) : null; if (!b) continue;
        let hid = false; for (let y = 0; y < b.h && !hid; y++) for (let x = 0; x < b.w && !hid; x++) hid = crowned(b.x + x + 0.5, b.y + y + 0.5);
        if (!hid) continue;
        rec.obj.updateWorldMatrix(true, true);
        rec.obj.traverseVisible(o => {
          if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.geometry.attributes.position) return;
          twin(o, 0, M.maskB, o.geometry);
          if (!(o.material && o.material.side === THREE.BackSide)) twin(o, 1, M.rimBOf(b.team), smoothNormals(o.geometry));
          usedB.add(o);
        });
      }
      // …and the piece being placed (a piece that can't go there: red, as its ghost)
      if (ghost && ghost.g.visible) { ghost.g.updateWorldMatrix(true, true);
        ghost.g.traverseVisible(o => { if (!o.isMesh || !o.geometry.attributes.position) return;
          twin(o, 0, M.maskB, o.geometry); twin(o, 1, M.rimBOf(o.userData.ghostBad ? 'bad' : myTeam), smoothNormals(o.geometry)); usedB.add(o); }); }
    }
    for (const [o, pr] of bTwins) if (!usedB.has(o)) { for (const t of pr) if (t) xray.remove(t); bTwins.delete(o); }
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
        const shell = o.material && o.material.side === THREE.BackSide, vw = o.geometry.userData.views;
        if (vw && !bld) { twin(o, 0, M.maskInk, vw.hull); twin(o, 1, M.mask, vw.body); twin(o, 2, M.rimU, vw.hull); }   // (a rig's one mesh: its shell and its body)
        else if (shell && !bld) { twin(o, 0, M.maskInk, o.geometry); twin(o, 1, M.rimU, o.geometry); }  // a unit's ink shell: its ink marked, the rim pushed wider
        else if (shell) twin(o, 0, M.mask, o.geometry);                                                  // a building's ink shell: marked (the rim starts past it)
        // (a gate's wall sections are the adjoining run's, not the gate: marked — no rim across them — but not outlined)
        // (a building going up: its outline round its footprint alone — not round every scaffold pole and fence post)
        else { twin(o, 0, M.mask, o.geometry); if (bld && !(o.userData.arm && isGateBtype(s.btype)) && (s.complete || o.name === 'plate' || isTowerBtype(s.btype))) twin(o, 1, M.rimB, smoothNormals(o.geometry)); }
        used.add(o);
      });
    }
    for (const [o, pr] of sTwins) if (!used.has(o)) { for (const t of pr) if (t) selG.remove(t); sTwins.delete(o); }
  }
  // The building being placed, as its real model in a see-through green (fits) or red (doesn't), on the hovered tile;
  // a wall drag, a box per tile.
  let ghost = null;
  function updateGhost(){
    const sig0 = ghostSig; ghostAt = new Map(); ghostSig = '';
    try { updateGhostArt(); } finally { if (ghostSig !== sig0) lastStatic = 0; }   // (the standing walls are redrawn with it — and without, when it goes)
  }
  function updateGhostArt(){
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
    if (isWallBtype(placing) || isGateBtype(placing) || isTowerBtype(placing)) for (const p of pieces) if (ok && p.ok !== false) {
      for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) ghostAt.set(y * MAP + x, p); ghostSig += p.x + ',' + p.y + ',' + p.w + ',' + p.h + ';'; }
    if (ghostSig) ghostSig = placing + ':' + ghostSig;
    const key = placing + ':' + ageBonus(myTeam) + ':' + ok + ':' + pieces.map(p => p.x + ',' + p.y + ',' + p.w + ',' + p.h + ',' + p.ok).join(';');
    if (!ghost || ghost.key !== key) {
      if (ghost) dropGhost();
      const g = new THREE.Group(), parts = [];
      if (isWallBtype(placing) || isGateBtype(placing)) {
        // Links as 2D's ghost overlay: to the other ghost tiles and (a valid piece only) the walls already there
        const at = new Map(); for (const p of pieces) for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) at.set(y * MAP + x, p);
        const look = (x, y) => at.get(y * MAP + x) || (ok ? occupantAt(x, y) : null);
        // (a piece that fits is on ghostAt: the walls behind it draw their own slab toward it, as they will)
        for (const p of pieces) { const o = wallModel(p, wallArms(p, look, n => ghostAt.has(p.y * MAP + p.x) ? !isTowerBtype(n.btype) : at.has(n.y * MAP + n.x) && n.btype === placing)).obj; g.add(o); parts.push([o, p.ok]); }
      } else {
        const p = pieces[0];
        try { MODELS[placing](g, { ...p, x: 0, y: 0 }); } catch (err) { boxAt(g, '#ffffff', 0, 0, p.w, p.h, 0, 0.5); }
        g.position.set(p.x, 0, p.y); parts.push([g, ok]);
      }
      // see-through in its own colours (2D: the art at 55%); outline shells hidden, a see-through part would show them
      const RED = new THREE.Color('#ff3020'), level = standsLevel({ type: 'building', btype: placing }) ? { value: new THREE.Vector2(pieces[0].x + pieces[0].w / 2, pieces[0].y + pieces[0].h / 2) } : null;
      for (const [part, good] of parts) part.traverse(o => {
        if (o.isMesh && HULL_MATS.has(o.material)) { o.visible = false; return; }
        if (!o.material) return;
        const own = m => { const c = m.clone(); c.onBeforeCompile = m.onBeforeCompile; c.customProgramCacheKey = m.customProgramCacheKey; c.transparent = true; c.opacity = o.isMesh ? 0.7 : 0.35;
          if (!good && c.color) c.color.lerp(RED, 0.65); return level ? levelMat(c, level) : c; };
        o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
        o.userData.ghostOwn = true; o.userData.ghostBad = !good; o.renderOrder = 5;
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
    btnFull.onclick = () => { if (world) povClose(); else openWorld(); rememberView(); };
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
      if (!ev.ctrlKey && isTrackpadWheel(ev)) { camX += ev.deltaX / ZOOM; camY += ev.deltaY / ZOOM; clampCamera(); window.cameraFollowId = null; return; }
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
    distFromZoom();                                                             // …and its zoom
    unrevealed = true; pip.style.visibility = atStart ? '' : 'hidden';          // mid-game: the 2D map stays up until the first 3D frame is drawn (no black while loading)
    // mid-game, the match's warm-up (every kind of building made and thrown away) isn't spent in this first frame: the
    // view's own buildings are built whole (unrevealed), the rest of the warm-up one kind a frame after (drawFrame)
    if (!atStart && warmFrames > 0) { warmFrames = 0; warmedKinds.clear(); warmQueue.length = 0; prewarmShapes(); }
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
    dropUnits();
    dropBuildings();
  }
  // Every per-entity model and its viewer state, keyed by id: a new world reuses ids, so a kept entry would dress the
  // new entity in the old one's model, team and pose.
  function dropUnits(){
    for (const a of animals.values()) dropSolid(a);
    animals.clear();
    for (const L of keptModels.values()) for (const g of L) dropSolid({ obj: g });
    keptModels.clear();
    for (const v of villagers.values()) dropVillager(v);
    villagers.clear();
    for (const m of rigPool.values()) for (const L of m.values()) for (const r of L) disposeRig(r);
    rigPool.clear();
    for (const r of corpseModels.values()) dropCorpse(r);
    corpseModels.clear();
    dropFalls();
    for (const [id, r] of vilCorpses) { dropVillager(r); scene.remove(r.blood); r.blood.geometry.dispose(); r.blood.material.dispose(); }
    vilCorpses.clear();
    tickPos.clear(); farmLive.clear(); farmPrev.clear(); lastPh.clear();
  }

  // Toggle for the selected unit: open, switch to it, or close if already on it (the world view: its eyes, or back to orbit).
  function povToggle(id){
    if (world) { if (followId === id) unfollow(); else povOpen(id); return; }
    if (followId === id) povClose(); else povOpen(id);
  }

  window.povOpen = povOpen;
  window.povClose = povClose;
  window.povToggle = povToggle;
  // The player's view choice, kept across reloads (localStorage 'aoeView'); the URL's ?view= wins, and automated
  // browsers ignore the stored one (the battery's default stays 2D)
  function preferredView(){
    const v = new URLSearchParams(location.search).get('view');
    if (v || navigator.webdriver) return v;
    try { return localStorage.getItem('aoeView'); } catch (e) { return null; }
  }
  function rememberView(v = world ? '3d' : '2d'){ try { localStorage.setItem('aoeView', v); } catch (e) {} }
  window.preferredView = preferredView;
  // Options → View: switch now in a match, else just remember it for the next one
  window.setViewMode = v => { if (gameStarted && (v === '3d') !== world) toggleView3D(); else rememberView(v); };
  window.toggleView3D = () => { if (world) povClose(); else openWorld(); rememberView(); };
  // A match (or a loaded save) opens in the view the player last switched to — the 3D world view until they pick one.
  // ?view=2d|3d overrides; automated browsers (the test battery drives the 2D map) default to 2D.
  window.enterDefaultView = () => {
    warmFrames = 2;                                                             // every match start, the world already open (a rematch) or not
    eye = null; camFrom = null; camLast = null;                                 // a new match CUTS to its base (no glide from the last match's view)
    const v = preferredView();
    if (!world && (v ? v !== '2d' : !navigator.webdriver)) openWorld(true);
  };
  window.povWorld = () => world;
  // Fetch three.js and set up the renderer and scene (nothing of a match's) while the menu is up, so a match opens
  // straight into 3D.
  if (preferredView() !== '2d' && !navigator.webdriver)
    window.addEventListener('load', () => setTimeout(() => loadThree().then(() => { ensurePip(); if (!renderer) initScene(); }).catch(() => {}), 500), { once: true });
  window.__povYaw = a => { if (a !== undefined) yaw = a; return yaw; }; // dev: the view's heading (tests; given one, sets it)
  window.__povAnimYaw = id => { const a = animals.get(id); return a ? a.yaw : null; }; // dev: an animal's drawn heading (tests)
  window.__pov3dScene = () => scene; // dev: profiling
  window.__povVM = (o, pitch, utype) => {
    if (o) {
      if (utype && UNIT_VM[utype]) Object.assign(UNIT_VM[utype], o);
      else { _vmOverride = _vmOverride || {}; Object.assign(_vmOverride, o); Object.assign(VM, o); }
    }
    if (pitch !== undefined) fpPitch = pitch;
    const v = villagers.get(followId);
    const u = followId != null && entitiesById.get(followId);
    const uCfg = (u && UNIT_VM[u.utype]) || {};
    return { ...VM, ...uCfg, ...(_vmOverride || {}), tilt: v && v.vmTilt, hands: v && v.fpHands, handL: v && v.fpHandL, handR: v && v.fpHandR, S: chh(-8), pose: v && v.lastPose, strike: v && v.fpStrike, mode, eyeView: eyeView(), camKey, blending: !!camFrom, cam: camera && camera.position.toArray().map(x => +x.toFixed(2)), unit: u && [+(u.x + 0.5).toFixed(2), +(u.y + 0.5).toFixed(2)] };
  }; // dev: tune the first-person viewmodel
  // The eye button: into character mode on a unit — the camera standing behind it (zoom in for its eyes) — opening
  // the world view if need be; again, back to the map.
  const inEyes = id => world && followId === id && mode !== 'orbit';
  window.povEyesUnit = () => world && mode !== 'orbit' ? followId : null;   // whose character mode, if any (the corner eye button)
  window.povEyes = (id, force = false) => {
    const u = entitiesById.get(id);
    if (!u || u.type !== 'unit' || u.hp <= 0) return;
    if (!force && inEyes(id)) { leaveToMap(); return; }
    if (!world) openWorld();
    blendMs = 1000; anchorTo(u); mode = 'chase'; chaseK = 1; refreshButtons();
  };
  window.__povOnScreen = u => { if (!renderer) return false; _v3 = _v3 || new THREE.Vector3(); const [x, z] = drawnAt(u); _v3.set(x, 0.3, z).project(camera); return _v3.z < 1 && Math.abs(_v3.x) <= 1.05 && Math.abs(_v3.y) <= 1.05; };
  window.__povProject = u => { _v3 = _v3 || new THREE.Vector3(); const [x, z] = drawnAt(u); return project(x, (PICK_H[u.utype] || 0.32), z); }; // dev: a unit's screen spot (tests)
  window.__povPick = (x, y) => { const p = pick(x, y); return { unit: p.unit && p.unit.id, building: p.building && p.building.id, resource: p.resource, map: p.map }; }; // dev: what a click there hits (tests)
  window.__povEyeNow = id => { window.povEyes(id, true); zoomIn(true); blendMs = 1; };   // dev: straight into a unit's eyes
  window.__povCam = () => camera.position.toArray().map(v => +v.toFixed(2)); // dev: the camera spot (tests)
  window.__povPose = id => { const v = villagers.get(id); return v ? v.lastPose + ':' + (v.lastLoad || '') : null; }; // dev: a villager's drawn pose and load
  window.__povFacing = id => { const v = villagers.get(id); return v ? +v.yaw.toFixed(2) : null; }; // dev: a unit's drawn heading (tests)
  window.__povDrawnAt = id => { const v = villagers.get(id); return v ? [v.x, v.z] : null; }; // dev: where a villager is drawn (tests)
  window.povFollowing = () => followId;
  window.povSteering = () => steering;
  // dev: what the people in the scene draw, by kind of part
  window.__povPeople = () => { const out = { n: 0 }; for (const v of villagers.values()) { if (!v.obj || !v.obj.visible) continue; out.n++;
    v.obj.traverseVisible(o => { if (!(o.isMesh || o.isLineSegments || o.isSprite)) return; const M = o.material;
      const k = o.isLineSegments ? 'lines' : o.isSprite ? 'sprite' : HULL_MATS.has(M) ? 'hull' : rigTeamMats.has(M.side + (M.userData.tc || '')) && M.userData.tc ? 'body' : M.vertexColors ? 'bodyPlain' : (o.isSkinnedMesh ? 'rig:' : 'loose:') + (M.map ? 'map' : M.userData.detail || '#' + M.color.getHexString()) + (M.transparent ? ':tr' : '');
      out[k] = (out[k] || 0) + 1; }); } return out; };
  window.__povRigMix = () => { const out = { templates: rigTemplates.size, meshes: 0, plain: 0, team: 0, detail: 0, hull: 0, lines: 0, other: 0 };
    for (const T of rigTemplates.values()) for (const m of T.meshes) { out.meshes++; const M = m.mat;
      if (m.lines) out.lines++; else if (HULL_MATS.has(M)) out.hull++; else if (tcSwaps.has(M)) out.team++; else if (M.isMeshLambertMaterial && !M.map && !M.userData.detail && !M.transparent) out.plain++; else if (M.userData.detail || M.map) out.detail++; else out.other++; }
    return out; }; // dev
  window.__povModelsOf = id => scene ? scene.children.filter(o => o.userData && o.userData.bid === id).map(o => ({ visible: o.visible, kids: o.children.length })) : null; // dev: the 3D models claiming building id (tests)
  window.__povBldParts = () => { const out = {}; for (const rec of solids.values()) { if (!rec.obj || !rec.obj.visible || rec.site || rec.dmg) continue; const e = entitiesById.get(rec.obj.userData.bid); if (!e) continue;
    const k = e.btype; if (out[k]) { out[k]._n++; continue; } const c = { _n: 1 }; rec.obj.traverseVisible(o => { if (!(o.isMesh || o.isLineSegments)) return; const t = o.isLineSegments ? 'lines' : HULL_MATS.has(o.material) ? 'hull' : (o.name || (o.parent && o.parent.name) || ((m => (m.vertexColors ? 'vc' : m.map ? 'map' : m.userData.detail ? 'd:' + m.userData.detail : (tcSwaps.has(m) ? 'tc' : '') + '#' + m.color.getHexString()) + (m.side === THREE.DoubleSide ? '/2' : '') + (m.transparent ? '/tr' : '') + (m.isMeshLambertMaterial ? '' : '/' + m.type))([].concat(o.material)[0]))); c[t] = (c[t] || 0) + 1; }); out[k] = c; } return out; }; // dev
  window.__povBldDraws = () => { const out = {}; for (const rec of solids.values()) { if (!rec.obj || !rec.obj.visible) continue; const k = rec.site ? 'site' : rec.dmg ? 'damaged' : rec.door ? 'gate' : 'finished';
    let n = 0; rec.obj.traverseVisible(o => { if (o.isMesh || o.isLineSegments) n++; }); const e = out[k] || (out[k] = { count: 0, draws: 0 }); e.count++; e.draws += n; } return out; }; // dev
  // dev: the frame's drawables (meshes and line sets in view of the scene graph — visible, not yet frustum-culled) by kind
  window.__povDraws = () => { const n = o => { let k = 0; if (o && o.visible) o.traverseVisible(c => { if ((c.isMesh || c.isLineSegments || c.isSprite) && c.layers.test(camera.layers)) k++; }); return k; };
    const sum = it => { let k = 0; for (const r of it) k += n(r.obj || r.sprite || r); return k; };
    const known = new Set(); for (const m of [solids, villagers, animals, corpseModels]) for (const r of m.values()) known.add(r.obj || r.sprite || r); known.add(xray); known.add(selG);
    const rest = {}; for (const c of scene.children) { if (known.has(c)) continue; const k = n(c); if (!k) continue; const M = [].concat(c.material || [])[0];
      const key = c.name || (c.isInstancedMesh ? 'inst' : c.isSprite ? 'sprite' : c.isLineSegments ? 'lines' : c.isMesh ? 'mesh:' + (M.map ? 'map' : M.type.replace('Material', '')) + (c.isSkinnedMesh ? ':skin' : '') + ':' + c.geometry.type.replace('Geometry', '') + (M.color ? '#' + M.color.getHexString() : '') + ':' + Object.keys(c.userData).join('.') : c.type + ':' + Object.keys(c.userData).join('.') + ':' + c.children.length); rest[key] = (rest[key] || 0) + k; }
    return { rest, buildings: sum(solids.values()), people: sum(villagers.values()), animals: sum(animals.values()), corpses: sum(corpseModels.values()), xray: n(xray), selection: n(selG), all: n(scene) }; };
  window.__povMem = () => { const sz = m => { let b = 0; for (const v of m.values()) { if (v && v.m) b += v.m.byteLength || 0; } return b; };
    let tv = 0; for (const T of rigTemplates.values()) tv += T.verts || 0; let cv = 0; for (const c of vilCache.values()) cv += c.verts || 0;
    return { rigSamples: rigSamples.size, rigSampleMB: +(sz(rigSamples) / 1048576).toFixed(1), rigTemplates: rigTemplates.size, templateVertsK: Math.round(tv / 1000), vilCache: vilCache.size, vilCacheVertsK: Math.round(cv / 1000),
      tickPos: tickPos.size, heading: heading.size, lastPh: lastPh.size, farmPrev: farmPrev.size, legMaps: legMaps.size, mats: mats.size, blobGeos: blobGeos.size, painted: painted.size, villagers: villagers.size }; }; // dev: cache sizes
  window.povStats = () => ({ frames: frame, jsMs: +stats.js.toFixed(2), glMs: +stats.gl.toFixed(2), units: villagers.size, animals: animals.size, buildings: solids.size, arrows: feat.shaft ? feat.shaft.n : 0, shadows: feat.shadow ? feat.shadow.mesh.count : 0, calls: renderer ? renderer.info.render.calls : 0, tris: renderer ? renderer.info.render.triangles : 0,
    programs: renderer ? renderer.info.programs.length : 0, geos: renderer ? renderer.info.memory.geometries : 0, tex: renderer ? renderer.info.memory.textures : 0 });   // (programs / geos / tex rising in a slow frame: what it was building)
})();
