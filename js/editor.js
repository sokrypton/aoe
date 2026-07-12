// ---- SCENARIO EDITOR ----
// The whole in-browser scenario editor, loaded ONLY by editor.html (which sets
// window.__editorMode before any script). It reuses the real engine: the world
// is built with the same createUnit/createBuilding/restartGame the game uses,
// rendered by the same render() every frame via the same gameLoop(), and "Play"
// is literally clearing gamePaused so that loop starts stepping the sim. Nothing
// here runs in a normal game — index.html/classic.html never load this file.
//
// Output is the compact scenario spec that js/scenario.js loadScenario() already
// consumes (and simulate.sh / ?scenario= / the Load-Game button already accept),
// so a scene authored here drops straight into the Phase-1 pipeline.
(function(){
'use strict';

// Units offered in the palette (sheep_carcass is a dead-food node, not authored).
const EDITOR_UNITS = ['villager','militia','spearman','archer','scout','knight','ram','tradecart','sheep','bear'];
// Terrain paints. GRASS doubles as the terrain eraser.
const EDITOR_TERRAIN = ['GRASS','FOREST','GOLD','STONE','BERRIES','FARM','WATER'];
// All placeable buildings, in a sensible authoring order.
const EDITOR_BLDGS = ['TC','HOUSE','LCAMP','MCAMP','MILL','FARM','BARRACKS','MARKET','TOWER','PTOWER','WALL','GATE','SWALL','SGATE'];
const STANCES = ['aggressive','defensive','standground','passive'];
const MAP_SIZE_KEYS = ['small','medium','large'];

// Reverse TERRAIN value -> name, for export.
const TERRAIN_NAME = {};
Object.keys(TERRAIN).forEach(k => { TERRAIN_NAME[TERRAIN[k]] = k; });

// Current tool + selectors.
let tool = { kind:'unit', key:'villager', team:0, stance:'aggressive' };
let editSeed = 1;
let controllers = ['human','human','human','human']; // per team, up to 4
let teamDiff = ['hard','hard','hard','hard'];         // per-team AI difficulty, kept when toggling human↔AI
let saveDetail = 'full';  // 'full' = lossless v3 snapshot (serializeGame); 'compact' = scenario spec
let running = false;      // true while the sim is unpaused (Play)
// Lossless snapshot (serializeGame, deep-cloned) captured at each edit→Play
// transition. Reset restores it — the world exactly as it was when you last
// pressed Play, INCLUDING any mid-game edits made while paused before that Play.
let playCheckpoint = null;
let painting = false;     // left-drag terrain paint
let panning = false, panLastX = 0, panLastY = 0;
let wallDragging = false; // left-drag wall run (reuses the game's wall-drag)
let minimapOn = false;    // upper-right minimap overlay toggle

// Run fn with toasts suppressed. restartGame/startGame/loadScenario fire
// showMsg (e.g. "Difficulty: Medium") on every editor rebuild — noise here.
function silent(fn){
  let s = window.showMsg;
  window.showMsg = function(){};
  try { fn(); } finally { window.showMsg = s; }
}

// ---- world coord -> screen pixel (matches render()'s post-restore space).
// Inside render() a world point draws at (toIso().ix - camX + W/2) then the
// ZOOM transform scales it around (W/2, H/2+topH); that reduces to this. We
// draw the cursor AFTER render's X.restore(), i.e. in identity space, so we
// apply ZOOM + camera ourselves here.
function worldToScreen(wx, wy){
  let iso = toIso(wx, wy);
  return { x: (iso.ix - camX) * ZOOM + W/2,
           y: (iso.iy - camY) * ZOOM + (H/2 + topH) };
}

// ---------------------------------------------------------------- UI (DOM/CSS)
function injectStyle(){
  let css = `
    body.editor-ui #ui, body.editor-ui #bottom, body.editor-ui #topbar,
    body.editor-ui #tutorial, body.editor-ui #pop-wrap, body.editor-ui #see-map-btn,
    body.editor-ui #chat-input-wrap, body.editor-ui #mp-status-panel,
    body.editor-ui #menu-btn, body.editor-ui #fs-btn { display: none !important; }
    body.editor-ui #game { cursor: crosshair; }
    /* Minimap overlay: hidden by default, shown upper-right when toggled on
       (body.ed-minimap). !important beats the game's #minimap-wrap position +
       the mobile media-query hide. pointer-events:auto so it doesn't leak
       clicks onto the map beneath (no accidental placement under it). */
    body.editor-ui #minimap-wrap { display: none !important; }
    body.editor-ui.ed-minimap #minimap-wrap {
      display: block !important; position: fixed !important;
      top: 8px !important; right: 8px !important; left: auto !important; bottom: auto !important;
      width: 224px !important; height: 116px !important; margin: 0 !important;
      z-index: 400 !important; overflow: hidden; pointer-events: auto !important; }
    #editor-panel { position: fixed; top: 0; left: 0; bottom: 0; width: 208px;
      background: #1c1712; color: #e8dcc5; font: 12px/1.35 system-ui, sans-serif;
      border-right: 2px solid #3a2f22; overflow-y: auto; z-index: 500;
      padding: 8px; box-sizing: border-box; user-select: none; }
    #editor-panel h3 { margin: 10px 0 4px; font-size: 11px; letter-spacing: .5px;
      text-transform: uppercase; color: #b89a6a; border-bottom: 1px solid #3a2f22;
      padding-bottom: 2px; }
    #editor-panel h3:first-child { margin-top: 0; }
    .ed-grid { display: flex; flex-wrap: wrap; gap: 3px; }
    .ed-btn { flex: 0 0 auto; min-width: 30px; height: 30px; padding: 0 5px;
      background: #2a2118; border: 1px solid #4a3c2a; border-radius: 4px;
      color: #e8dcc5; font-size: 15px; cursor: pointer; display: flex;
      align-items: center; justify-content: center; }
    .ed-btn.sel { background: #6a4; border-color: #ad6; color: #0d1a05;
      box-shadow: 0 0 0 1px #ad6; }
    .ed-btn.terr { font-size: 9px; font-weight: 700; color: #fff;
      text-shadow: 0 1px 1px #000; }
    .ed-btn .spr { width: 26px; height: 26px; display: block; pointer-events: none; }
    .ed-row { display: flex; align-items: center; gap: 4px; margin: 3px 0; }
    .ed-row label { flex: 0 0 46px; color: #b89a6a; }
    .ed-row select, .ed-row input { flex: 1 1 auto; background: #2a2118;
      color: #e8dcc5; border: 1px solid #4a3c2a; border-radius: 3px; padding: 2px; }
    .ed-swatch { width: 26px; height: 26px; border-radius: 4px; cursor: pointer;
      border: 2px solid transparent; }
    .ed-swatch.sel { border-color: #fff; }
    .ed-act { width: 100%; margin: 3px 0; padding: 7px; border-radius: 4px;
      border: 1px solid #4a3c2a; background: #2a2118; color: #e8dcc5;
      font-size: 13px; font-weight: 700; cursor: pointer; }
    #ed-play { background: #2e6b2e; border-color: #4a9a4a; }
    #ed-play.running { background: #8a5a1e; border-color: #c88a3a; }
    .ed-spd { flex: 1 1 0; height: 26px; background: #2a2118; border: 1px solid #4a3c2a;
      border-radius: 4px; color: #e8dcc5; font-size: 12px; font-weight: 700; cursor: pointer; }
    .ed-spd.sel { background: #6a4; border-color: #ad6; color: #0d1a05; }
    .ed-hint { color: #8a7a5a; font-size: 10px; margin-top: 8px; line-height: 1.4; }
  `;
  let s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);
}

function mkBtn(label, title, cls, onClick){
  let b = document.createElement('button');
  b.className = 'ed-btn' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.title = title || label;
  b.onclick = onClick;
  return b;
}

// Resolve a unit/building key to the best available sprite-sheet cell key,
// reusing the game's own iconKey() (age variants: TC→TC-dark, TOWER→WT-feudal,
// militia→militia at dark). Falls back through age variants, then null if the
// sheet has no cell for it (caller then shows the emoji).
function spriteKeyFor(key){
  let SC = window.SPRITE_CELLS || {};
  let k = (typeof iconKey === 'function') ? iconKey(key, 0) : key;
  if (SC[k]) return k;
  if (SC[key]) return key;
  let v = (typeof AGE_ICON_VARIANTS !== 'undefined') && AGE_ICON_VARIANTS[key];
  if (v) for (let a of [1, 2, 0]) if (v[a] && SC[v[a]]) return v[a];
  return null;
}

// A palette button that shows the in-game sprite icon (from sprites.png via the
// .icon-<cell> classes page-shell.js injects), or the emoji if no cell exists.
function mkIconBtn(key, emojiFallback, title, onClick){
  let b = document.createElement('button');
  b.className = 'ed-btn'; b.title = title;
  let sk = spriteKeyFor(key);
  if (sk) b.innerHTML = '<div class="spr sprite-icon icon-' + sk + '"></div>';
  else b.textContent = emojiFallback || '?';
  b.onclick = onClick;
  return b;
}

// Track the currently-selected palette button to move the .sel highlight.
let selBtn = null;
function selectToolBtn(btn){
  if (selBtn) selBtn.classList.remove('sel');
  selBtn = btn; if (btn) btn.classList.add('sel');
}
// Re-apply the .sel highlight to whatever button matches the current tool —
// used after a palette rebuild (map-size change / Reset / Clear) so the
// active tool stays visibly selected regardless of kind.
function selectByTool(){
  let root = document.getElementById('editor-panel'); if (!root) return;
  let want = tool.kind + ':' + (tool.key == null ? '' : tool.key);
  let btn = [...root.querySelectorAll('.ed-btn')].find(b => b.dataset.tool === want);
  selectToolBtn(btn || null);
}

function buildPalette(){
  let p = document.createElement('div');
  p.id = 'editor-panel';

  // Actions
  let play = document.createElement('button');
  play.id = 'ed-play'; play.className = 'ed-act';
  play.textContent = '▶ Play'; play.onclick = togglePlay;
  p.appendChild(play);
  let resetBtn = actBtn('↺ Reset', resetToAuthored);
  resetBtn.title = 'Undo the simulation back to the last time you pressed ▶ Play (keeps your edits from before that Play)';
  p.appendChild(resetBtn);
  p.appendChild(actRow(actBtn('📂 Load', loadScenarioFile), actBtn('💾 Save', saveGame)));
  // Save detail: Full = lossless game snapshot (round-trips a real game);
  // Compact = scenario spec (fresh entities, carries ages/resources). One
  // loader reads both.
  let dBtn = actBtn('Save: ' + (saveDetail === 'full' ? 'Full' : 'Compact'), null);
  dBtn.onclick = () => { saveDetail = saveDetail === 'full' ? 'compact' : 'full'; dBtn.textContent = 'Save: ' + (saveDetail === 'full' ? 'Full' : 'Compact'); };
  p.appendChild(dBtn);
  p.appendChild(actBtn('🗑 Clear', clearWorld));

  // Sim speed (applies live, in edit or play). GAME_SPEED default is 2.
  let spd = document.createElement('div'); spd.className = 'ed-grid'; spd.style.margin = '3px 0';
  [1, 2, 4].forEach(v => {
    let b = document.createElement('button');
    b.className = 'ed-spd' + (GAME_SPEED === v ? ' sel' : '');
    b.textContent = v + '×'; b.title = 'Simulation speed ' + v + '×';
    b.onclick = () => { setGameSpeed(v); [...spd.children].forEach(c => c.classList.toggle('sel', c.textContent === v + '×')); };
    spd.appendChild(b);
  });
  p.appendChild(spd);

  // Team picker (color swatches). Clicking a color selects that team AND
  // repopulates the whole per-team config block below (controller / difficulty /
  // age / resources) for it — and everything you then place goes to that team.
  let nTeams = Math.max(2, NUM_TEAMS);
  if (tool.team >= nTeams) { tool.team = 0; myTeam = 0; } // clamp after loading a game with fewer teams
  let h = document.createElement('h3'); h.textContent = 'Team ' + tool.team; p.appendChild(h);
  h.style.color = teamColor(tool.team);
  let teamRow = document.createElement('div'); teamRow.className = 'ed-grid';
  for (let t = 0; t < nTeams; t++){
    let sw = document.createElement('div');
    sw.className = 'ed-swatch' + (t === tool.team ? ' sel' : '');
    sw.style.background = teamColor(t);
    sw.title = 'Team ' + t;
    sw.onclick = () => {
      tool.team = t;
      myTeam = t; // building ghost color + the side you command in Play follow the picker
      rebuildPalette(); // repopulate the per-team config block for the newly selected team
    };
    teamRow.appendChild(sw);
  }
  p.appendChild(teamRow);

  // Selected team's config — controller / difficulty / age / resources. Applied
  // LIVE (the editor runs the real engine) so a loaded game reflects edits at
  // once; both Save formats + Reset capture them. Switch teams with the
  // swatches above to configure another team.
  let et = tool.team;
  const applyController = () => {
    controllers[et] = (controllers[et] === 'human') ? 'human' : ('ai:' + teamDiff[et]);
    if (typeof teamControllers !== 'undefined' && teamControllers) {
      teamControllers[et] = parseController(controllers[et]);
      if (typeof resetAIStates === 'function') resetAIStates();
    }
  };
  let isAI = controllers[et] !== 'human';
  p.appendChild(selectRow('Plays', ['human','ai'], isAI ? 'ai' : 'human', v => {
    controllers[et] = (v === 'ai') ? ('ai:' + teamDiff[et]) : 'human';
    applyController(); rebuildPalette(); // show/hide the difficulty row
  }));
  if (isAI){
    p.appendChild(selectRow('Difficulty', ['easy','standard','hard'], teamDiff[et], v => {
      teamDiff[et] = v; controllers[et] = 'ai:' + v; applyController();
    }));
  }
  const AGE_NAMES = ['Dark','Feudal','Castle'];
  p.appendChild(selectRow('Age', AGE_NAMES,
    AGE_NAMES[(typeof teamAge !== 'undefined' && teamAge ? teamAge[et] : 0) || 0],
    v => { if (typeof setTeamAge === 'function') setTeamAge(et, AGE_NAMES.indexOf(v)); }));
  let rs = (typeof resources !== 'undefined' && resources && resources[et]) || {};
  ['food','wood','gold','stone'].forEach(k => {
    p.appendChild(inputRow(k, rs[k] != null ? rs[k] : 0,
      v => { if (resources && resources[et]) resources[et][k] = Math.max(0, v | 0); }));
  });

  // Terrain
  addSection(p, 'Terrain', EDITOR_TERRAIN.map(t => {
    let b = mkBtn(t.slice(0,3), t, 'terr', () => { setTool('terrain', t); selectToolBtn(b); });
    b.dataset.tool = 'terrain:' + t;
    b.style.background = (TCOL[TERRAIN[t]] && TCOL[TERRAIN[t]][0]) || '#4a8c2a';
    return b;
  }));

  // Units — plus the stance placed units get (a unit-only property, so it lives
  // with the unit palette rather than floating up by the team config).
  addSection(p, 'Units', EDITOR_UNITS.map(u => {
    let b = mkIconBtn(u, UNITS[u].icon, UNITS[u].name, () => { setTool('unit', u); selectToolBtn(b); });
    b.dataset.tool = 'unit:' + u;
    return b;
  }));
  p.appendChild(selectRow('Stance', STANCES, tool.stance, v => tool.stance = v));

  // Buildings
  addSection(p, 'Buildings', EDITOR_BLDGS.map(k => {
    let b = mkIconBtn(k, BLDGS[k].icon, BLDGS[k].name + ' (' + BLDGS[k].w + '×' + BLDGS[k].h + ')',
      () => { setTool('building', k); selectToolBtn(b); });
    b.dataset.tool = 'building:' + k;
    return b;
  }));

  // Erase
  let hE = document.createElement('h3'); hE.textContent = 'Erase'; p.appendChild(hE);
  let eg = document.createElement('div'); eg.className = 'ed-grid';
  let eb = mkBtn('❌', 'Eraser — click an entity to delete it, or a tile to reset to grass',
    '', () => { setTool('erase', null); selectToolBtn(eb); });
  eb.dataset.tool = 'erase:';
  eg.appendChild(eb); p.appendChild(eg);

  // Map settings
  let hM = document.createElement('h3'); hM.textContent = 'Map'; p.appendChild(hM);
  let curSize = MAP_SIZE_KEYS.find(k => MAP_SIZES[k] === MAP) || 'medium';
  p.appendChild(selectRow('Size', MAP_SIZE_KEYS, curSize, v => {
    if (entities.length && !confirm('Change map size? This clears the current scene.')) { rebuildPalette(); return; }
    enterEditor(v);
  }));
  p.appendChild(inputRow('Seed', editSeed, v => { editSeed = (parseInt(v,10) || 1) >>> 0; }));
  // Minimap on/off (upper-right overlay)
  let mmRow = document.createElement('div'); mmRow.className = 'ed-row';
  let mmL = document.createElement('label'); mmL.textContent = 'Minimap'; mmRow.appendChild(mmL);
  let mmB = document.createElement('button'); mmB.className = 'ed-spd' + (minimapOn ? ' sel' : '');
  mmB.textContent = minimapOn ? 'On' : 'Off';
  mmB.onclick = () => { minimapOn = !minimapOn; applyMinimap(); mmB.textContent = minimapOn ? 'On' : 'Off'; mmB.classList.toggle('sel', minimapOn); };
  mmRow.appendChild(mmB); p.appendChild(mmRow);

  let hint = document.createElement('div'); hint.className = 'ed-hint';
  hint.innerHTML = 'Left-click: place / paint · Right or middle drag: pan · Wheel: zoom · Arrows: pan · Space: Play/Pause';
  p.appendChild(hint);

  document.body.appendChild(p);
  selectByTool(); // keep the active tool highlighted across rebuilds
}

function rebuildPalette(){
  let old = document.getElementById('editor-panel');
  if (old) old.remove();
  selBtn = null;
  buildPalette();
}
function actBtn(label, fn){ let b = document.createElement('button'); b.className = 'ed-act'; b.textContent = label; b.onclick = fn; return b; }
// Two (or more) action buttons side by side, each taking an equal share.
function actRow(...btns){ let r = document.createElement('div'); r.style.display = 'flex'; r.style.gap = '4px'; btns.forEach(b => { b.style.flex = '1 1 0'; r.appendChild(b); }); return r; }
function addSection(p, title, btns){
  let h = document.createElement('h3'); h.textContent = title; p.appendChild(h);
  let g = document.createElement('div'); g.className = 'ed-grid';
  btns.forEach(b => g.appendChild(b));
  p.appendChild(g);
}
function selectRow(label, opts, cur, fn){
  let row = document.createElement('div'); row.className = 'ed-row';
  let l = document.createElement('label'); l.textContent = label; row.appendChild(l);
  let sel = document.createElement('select');
  opts.forEach(o => { let op = document.createElement('option'); op.value = o; op.textContent = o; if (o === cur) op.selected = true; sel.appendChild(op); });
  sel.onchange = () => fn(sel.value);
  row.appendChild(sel); return row;
}
function inputRow(label, cur, fn){
  let row = document.createElement('div'); row.className = 'ed-row';
  let l = document.createElement('label'); l.textContent = label; row.appendChild(l);
  let inp = document.createElement('input'); inp.type = 'number'; inp.value = cur; inp.min = 0;
  inp.onchange = () => fn(inp.value);
  row.appendChild(inp); return row;
}

function setTool(kind, key){
  tool.kind = kind; tool.key = key;
  syncPlacing();
}

// Show/hide the upper-right minimap overlay (CSS in injectStyle). render()
// draws the minimap every frame; toggling the body class resizes the wrap, so
// force a dims re-read (the ResizeObserver in render-fx.js also catches it).
function applyMinimap(){
  document.body.classList.toggle('ed-minimap', minimapOn);
  if (minimapOn && typeof miniDimsStale !== 'undefined') miniDimsStale = true;
}

// Drive the engine's own building ghost: setting the global `placing` to a
// building key makes render()'s drawGhost() preview the real building (sprite
// + footprint tint) for free. Cleared for non-building tools and during Play
// (so the game's mousedown never treats it as a build order).
function syncPlacing(){
  placing = (!window.__editorPlaying && tool.kind === 'building') ? tool.key : null;
}

// A detached, fully-formed unit used only to preview a placement (the engine
// has no unit "ghost" like it does for buildings). We build it with the real
// createUnit() — so every field drawUnit() reads is present — then pull it
// straight back out of the world so the sim never sees it. Cached per
// utype+team; rebuilt when the tool changes.
let ghostUnit = null, ghostKey = '';
function unitGhost(){
  let key = tool.key + ':' + tool.team;
  if (ghostKey !== key){
    let u = createUnit(tool.key, 0, 0, tool.team);
    let idx = entities.indexOf(u); if (idx >= 0) entities.splice(idx, 1);
    if (u) entitiesById.delete(u.id);
    if (u && tool.stance && typeof isSoldierUnit === 'function' && isSoldierUnit(u)) u.stance = tool.stance;
    ghostUnit = u; ghostKey = key;
  }
  return ghostUnit;
}

// ------------------------------------------------------------------- world/boot
function enterEditor(sizeKey){
  sizeKey = sizeKey || (MAP_SIZE_KEYS.find(k => MAP_SIZES[k] === MAP) || 'medium');
  running = false; window.__editorPlaying = false; playCheckpoint = null;
  NUM_TEAMS = 4;                      // author for up to 4 teams; export trims
  window.__scenarioMode = true;       // genMap()/init() skip default placement
  window.fogDisabled = true;          // whole authored map visible; combat engages
  window.__pendingMatchSeed = editSeed >>> 0;
  setMapSize(sizeKey);
  silent(() => restartGame('standard')); // full reset -> blank grass world; hides menu (no toast)
  window.__scenarioMode = false;      // mirror scenario.js (only genMap/init read it)
  // FFA: every team its own side. restartGame() sets 2v2 alliances for
  // NUM_TEAMS===4, which would make teams 0+1 (and 2+3) refuse to fight — not
  // what "place two sides and watch them battle" means in an editor.
  if (typeof resetTeamAlliance === 'function') resetTeamAlliance();
  if (typeof resetTeamColorMap === 'function') resetTeamColorMap();
  gameStarted = true;
  gamePaused = true;                  // start paused = edit mode
  // Center camera on the map middle.
  let iso = toIso(MAP/2, MAP/2);
  camX = iso.ix; camY = iso.iy;
  window.cameraFollowId = null;
  myTeam = tool.team; // building-ghost color + Play-mode controlled side
  syncPlacing();
  applyMinimap();
  updatePlayBtn();
  rebuildPalette();
}

// --------------------------------------------------------------------- placement
function applyTool(tx, ty){
  if (tx < 0 || ty < 0 || tx >= MAP || ty >= MAP) return;
  if (tool.kind === 'terrain'){
    let ty2 = TERRAIN[tool.key];
    let res = (typeof SCENARIO_RES_DEFAULT !== 'undefined' && SCENARIO_RES_DEFAULT[tool.key] != null)
      ? SCENARIO_RES_DEFAULT[tool.key] : 0;
    map[ty][tx] = { t: ty2, res, occupied: null };
    if (typeof markMapDirty === 'function') markMapDirty(tx, ty);
  } else if (tool.kind === 'unit'){
    if (unitAtTile(tx, ty)) return; // one unit per tile — never stack (matters for drag-paint too)
    let u = createUnit(tool.key, tx, ty, tool.team);
    // Only soldiers carry a stance; forcing it on sheep/villagers/carts is
    // meaningless (they never auto-engage) and would leak into the export.
    if (u && tool.stance && typeof isSoldierUnit === 'function' && isSoldierUnit(u)) u.stance = tool.stance;
    if (typeof refreshPopulationCounts === 'function') refreshPopulationCounts();
  } else if (tool.kind === 'building'){
    // shared gate/tower/wall/regular placement; null = canPlace rejected it
    if (!editorPlace(tool.key, tx, ty) && window.showMsg) showMsg("Can't build there");
  } else if (tool.kind === 'erase'){
    eraseAt(tx, ty);
  }
}

// Place a COMPLETE building via the SAME shared primitives the game uses
// (resolveBuildingPlacement + commitBuildingPlacement, js/commands.js): gate
// footprint sizing, tower/stone-wall-on-wall replacement, and multi-tile
// occupancy all behave identically to gameplay — nothing reinvented here. The
// resolved gw/gh rides the entity and round-trips through the scenario spec
// (buildSpec exports w/h; loadScenario passes them back to createBuilding).
function editorPlace(btype, tx, ty){
  // Same placement rules as gameplay (gate-on-wall, no build on water/
  // resources, no overlap) — only the age gate is bypassed (ignoreAge=true).
  // The ghost uses the same check (drawGhost passes window.__editorMode), so
  // what the green/red preview shows is exactly what places.
  if (typeof canPlace === 'function' && !canPlace(btype, tx, ty, tool.team, true)) return null;
  let plan = resolveBuildingPlacement(btype, tx, ty, tool.team);
  return commitBuildingPlacement(btype, plan, tool.team, true);
}

// Commit a dragged wall run: place a wall of the drag material on each tile of
// the elbow line (skipping tiles already occupied). Reuses the game's
// getWallElbowTiles for the line/elbow, then the shared placement per tile.
function finalizeEditorWall(){
  let start = window.wallDragStart, end = window.wallDragEnd, corner = window.wallDragCorner || end;
  let btype = window.wallDragBtype || tool.key;
  if (start && end && typeof getWallElbowTiles === 'function'){
    // editorPlace → canPlace skips out-of-bounds / occupied / bad-terrain tiles.
    getWallElbowTiles(start, corner, end).forEach(t => editorPlace(btype, t.x, t.y));
  }
  if (typeof abortWallDrag === 'function') abortWallDrag();
}

// Any unit already standing on this tile (units rest on integer tiles in the
// editor, so a rounded compare is exact). Enforces one-unit-per-tile.
function unitAtTile(tx, ty){
  return entities.find(e => e.type === 'unit' && Math.round(e.x) === tx && Math.round(e.y) === ty);
}

function eraseAt(tx, ty){
  // Reuse the game's cursor hit-tests (they live in input.js, loaded here).
  let hit = getUnitUnderCursor(mouseX, mouseY) || getBuildingUnderCursor(mouseX, mouseY);
  if (hit){
    let idx = entities.indexOf(hit);
    if (idx >= 0) entities.splice(idx, 1);
    entitiesById.delete(hit.id);
    if (hit.type === 'building'){
      for (let dy = 0; dy < hit.h; dy++) for (let dx = 0; dx < hit.w; dx++){
        let mx = hit.x + dx, my = hit.y + dy;
        if (my < MAP && mx < MAP && map[my][mx] && map[my][mx].occupied === hit.id) map[my][mx].occupied = null;
      }
    }
    if (typeof refreshPopulationCounts === 'function') refreshPopulationCounts();
    return;
  }
  // No entity under cursor -> reset the tile to plain grass.
  map[ty][tx] = { t: TERRAIN.GRASS, res: 0, occupied: null };
  if (typeof markMapDirty === 'function') markMapDirty(tx, ty);
}

// ----------------------------------------------------------------- play / export
function togglePlay(){
  if (!running){
    // Checkpoint the CURRENT world (lossless, deep-cloned so the running sim
    // can't mutate it) — Reset returns here. Captured on EVERY Play, so it
    // reflects whatever you last set up, including mid-game edits made while
    // paused. serializeGame() returns live references, hence the clone.
    if (typeof serializeGame === 'function') playCheckpoint = JSON.parse(JSON.stringify(serializeGame()));
    // Wire controllers so AI teams act; soldiers of any team auto-engage.
    teamControllers = controllers.slice(0, NUM_TEAMS).map(parseController);
    if (typeof resetAIStates === 'function') resetAIStates();
    if (typeof refreshPopulationCounts === 'function') refreshPopulationCounts();
    // Enter PLAYER MODE: the game's own select/command input takes over (see
    // the __editorPlaying guards in input.js) so you can select units and
    // order them around; the editor's placement input stands down. You drive
    // the team the picker is on (myTeam, set on team-swatch click).
    running = true; window.__editorPlaying = true;
    selected.length = 0; syncPlacing();
    gamePaused = false;
  } else {
    // Back to EDIT MODE — on the LIVE simulated state. You can now place/delete
    // units, edit team state, etc. mid-game; they apply to the running world,
    // and pressing Play again continues from there (and re-checkpoints).
    running = false; window.__editorPlaying = false;
    selected.length = 0; syncPlacing();
    gamePaused = true;
  }
  updatePlayBtn();
}
function parseController(c){
  if (typeof c === 'string' && c.indexOf('ai') === 0){
    let d = c.split(':')[1];
    return { type:'ai', difficulty: (typeof AI_LEVELS !== 'undefined' && AI_LEVELS[d]) ? d : 'standard' };
  }
  return { type:'human' };
}
function updatePlayBtn(){
  let b = document.getElementById('ed-play');
  if (!b) return;
  b.textContent = running ? '⏸ Pause' : '▶ Play';
  b.classList.toggle('running', running);
}

// Restore the last-Play checkpoint (undo the sim since then), keeping the user's
// current camera view. The checkpoint is a full serializeGame snapshot, so this
// is a lossless applySavedGame — exact entities/resources/age/rng/tick as they
// were the moment Play was pressed. Deep-cloned again on restore so repeated
// Resets keep working (applySavedGame assigns the arrays by reference).
function restoreCheckpoint(){
  if (!playCheckpoint) return false;
  let cx = camX, cy = camY, z = ZOOM;
  let nt = playCheckpoint.numTeams || NUM_TEAMS;
  if (myTeam >= nt) myTeam = 0;
  if (tool.team >= nt) tool.team = 0;
  silent(() => applySavedGame(JSON.parse(JSON.stringify(playCheckpoint))));
  window.fogDisabled = true;
  running = false; window.__editorPlaying = false; gameStarted = true; gamePaused = true;
  selected.length = 0; syncPlacing();
  camX = cx; camY = cy; ZOOM = z;
  return true;
}

function resetToAuthored(){
  if (!restoreCheckpoint()){ if (window.showMsg) showMsg('Nothing to reset to — press Play first'); return; }
  updatePlayBtn(); rebuildPalette();
  if (window.showMsg) showMsg('Reset to last Play');
}

function clearWorld(){
  if (entities.length && !confirm('Clear the whole scene?')) return;
  enterEditor();
}

function buildSpec(){
  let terrain = [];
  for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++){
    let c = map[y][x];
    if (!c || c.t === TERRAIN.GRASS) continue;
    let o = { t: TERRAIN_NAME[c.t], x, y };
    if (c.res) o.amount = c.res;
    terrain.push(o);
  }
  let ents = [], maxTeam = 1;
  entities.forEach(e => {
    if (e.team != null && e.team > maxTeam && e.team < 4) maxTeam = e.team;
    if (e.type === 'building') {
      let o = { b: e.btype, x: Math.round(e.x), y: Math.round(e.y), team: e.team };
      let def = BLDGS[e.btype];
      // Preserve a non-default footprint (gates sized by gateFootprint) so it
      // round-trips — loadScenario passes w/h back to createBuilding.
      if (def && (e.w !== def.w || e.h !== def.h)) { o.w = e.w; o.h = e.h; }
      ents.push(o);
    }
    else if (e.type === 'unit') {
      let o = { u: e.utype, x: Math.round(e.x), y: Math.round(e.y), team: e.team };
      if (e.stance) o.stance = e.stance;
      ents.push(o);
    }
  });
  let numTeams = Math.max(2, maxTeam + 1);
  let spec = {
    map: MAP_SIZE_KEYS.find(k => MAP_SIZES[k] === MAP) || MAP,
    seed: editSeed >>> 0,
    numTeams,
    controllers: controllers.slice(0, numTeams),
    terrain,
    entities: ents,
  };
  // Per-team AGE + RESOURCES from LIVE state — only when non-default, to keep a
  // compact scenario compact. loadScenario applies these (js/scenario.js).
  let ages = [], anyAge = false, res = [], anyRes = false;
  let dflt = (typeof freshTeamResources === 'function') ? freshTeamResources()[0] : { food:200, wood:200, gold:100, stone:200 };
  for (let t = 0; t < numTeams; t++){
    let a = (typeof teamAge !== 'undefined' && teamAge && teamAge[t]) || 0;
    ages.push(a); if (a) anyAge = true;
    let r = (typeof resources !== 'undefined' && resources) ? resources[t] : null;
    if (r){
      let o = { food: r.food|0, wood: r.wood|0, gold: r.gold|0, stone: r.stone|0 };
      if (r.prepaidFarms) o.prepaidFarms = r.prepaidFarms|0;
      res.push(o);
      if (o.food !== dflt.food || o.wood !== dflt.wood || o.gold !== dflt.gold || o.stone !== dflt.stone || o.prepaidFarms) anyRes = true;
    } else res.push(null);
  }
  if (anyAge) spec.ages = ages;
  if (anyRes) spec.resources = res;
  return spec;
}

function downloadJson(json, name){
  let blob = new Blob([json], { type: 'application/json' });
  let a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportScenario(){
  let spec = buildSpec();
  downloadJson(JSON.stringify(spec, null, 2), 'scenario.json');
  if (window.showMsg) showMsg('Saved scenario.json (' + spec.entities.length + ' entities)');
}

// The unified Save. 'full' → a lossless v3 snapshot (serializeGame) that
// round-trips a real game (exact entities + resources/age/controllers/rng/tick).
// 'compact' → the scenario spec (buildSpec, now carrying ages/resources). Both
// files load back through the one loader (loadGame / editor Load).
function saveGame(){
  if (saveDetail === 'full' && typeof serializeGame === 'function'){
    downloadJson(JSON.stringify(serializeGame()), 'aoe2-game.json');
    if (window.showMsg) showMsg('Saved full game (' + entities.length + ' entities)');
  } else {
    exportScenario();
  }
}

// Load a scenario .json from disk back INTO the editor (open a file picker,
// parse, hand to loadEditorScenario). Round-trips anything Save produced.
function loadScenarioFile(){
  let inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = () => {
    let f = inp.files && inp.files[0];
    if (!f) return;
    let r = new FileReader();
    r.onload = () => {
      let data;
      try { data = JSON.parse(r.result); }
      catch (e) { if (window.showMsg) showMsg('Invalid game/scenario JSON'); console.error('[editor] load failed:', e); return; }
      loadIntoEditor(data);
    };
    r.readAsText(f);
  };
  inp.click();
}

// Mirror the live sim's per-team controllers back into the editor's authoring
// array (used by buildSpec + Play), e.g. after loading a full save.
function syncControllersFromLive(){
  for (let t = 0; t < controllers.length; t++){
    let c = (typeof teamControllers !== 'undefined' && teamControllers) ? teamControllers[t] : null;
    if (c && c.type === 'ai'){ teamDiff[t] = c.difficulty || 'standard'; controllers[t] = 'ai:' + teamDiff[t]; }
    else controllers[t] = 'human';
  }
}

// The editor's single Load entry — accepts EITHER detail level (the unification):
//   - a full v3 snapshot (2D `map` grid) → applySavedGame, then drop back into
//     EDIT mode so you can tweak the loaded game and re-save;
//   - a compact scenario spec → loadEditorScenario (constructive, forces 4 teams).
// Mirrors the game's loadGame() routing so the editor and the game read the
// same files.
function loadIntoEditor(data){
  data = data || {};
  if (Array.isArray(data.map)){
    // Clamp the selected team to the incoming save's team count BEFORE
    // applySavedGame — it runs updateUI, which reads resources[myTeam]; a stale
    // myTeam/tool.team (e.g. 3, from the picker) past the loaded numTeams would
    // crash there before rebuildPalette's clamp could fix it.
    let nt = data.numTeams || 2;
    if (myTeam >= nt) myTeam = 0;
    if (tool.team >= nt) tool.team = 0;
    silent(() => applySavedGame(data)); // exact restore: entities + resources/age/controllers/rng
    if (typeof matchSeed !== 'undefined') editSeed = matchSeed >>> 0;
    syncControllersFromLive();
    running = false; window.__editorPlaying = false; gameStarted = true; gamePaused = true;
    playCheckpoint = null; selected.length = 0;
    syncPlacing(); updatePlayBtn(); rebuildPalette();
    if (window.showMsg) showMsg('Loaded saved game (' + entities.length + ' entities)');
  } else {
    loadEditorScenario(data);
  }
}

// Build the loaded scenario's world, then re-establish EDIT state (paused, FFA,
// 4 teams so the palette works) and sync the palette selectors (seed,
// controllers, map size) to what was loaded. Forces numTeams:4 up front so
// every per-team sim array is sized for editing (same reason as resetToAuthored).
function loadEditorScenario(spec){
  spec = spec || {};
  editSeed = (spec.seed != null ? spec.seed : 1) >>> 0;
  controllers = ['human', 'human', 'human', 'human'];
  if (Array.isArray(spec.controllers)) spec.controllers.forEach((c, i) => {
    if (i < 4){ controllers[i] = c; let d = String(c).split(':')[1]; if (d) teamDiff[i] = d; }
  });
  silent(() => loadScenario(Object.assign({}, spec, { numTeams: 4 }))); // centers camera on the authored content
  window.fogDisabled = true;
  if (typeof resetTeamAlliance === 'function') resetTeamAlliance();
  if (typeof resetTeamColorMap === 'function') resetTeamColorMap();
  running = false; window.__editorPlaying = false; gameStarted = true; gamePaused = true;
  playCheckpoint = null; selected.length = 0;
  syncPlacing();
  updatePlayBtn(); rebuildPalette();
  if (window.showMsg) showMsg('Loaded scenario (' + (spec.entities ? spec.entities.length : 0) + ' entities)');
}

// ----------------------------------------------------------------------- cursor
// Apply render()'s own ZOOM+camera transform, run fn, restore. Lets us reuse
// engine draw helpers (drawUnit) that expect the in-render transform, from our
// post-restore overlay. Mirrors render.js:97-100.
function inWorldTransform(fn){
  X.save();
  X.translate(Math.round(W/2), Math.round(H/2 + topH));
  X.scale(ZOOM, ZOOM);
  X.translate(-Math.round(W/2), -Math.round(H/2 + topH));
  fn();
  X.restore();
}

function tileDiamond(tx, ty, w, h, col, alpha){
  let c0 = worldToScreen(tx, ty), c1 = worldToScreen(tx + w, ty),
      c2 = worldToScreen(tx + w, ty + h), c3 = worldToScreen(tx, ty + h);
  X.save();
  X.lineWidth = 2; X.strokeStyle = col; X.fillStyle = col;
  X.globalAlpha = alpha; X.beginPath();
  X.moveTo(c0.x, c0.y); X.lineTo(c1.x, c1.y); X.lineTo(c2.x, c2.y); X.lineTo(c3.x, c3.y); X.closePath();
  X.fill(); X.globalAlpha = Math.min(1, alpha + 0.65); X.stroke();
  X.restore();
}

function drawEditorCursor(){
  if (window.__editorPlaying) return;              // Play mode: no placement cursor
  if (map.length === 0 || typeof mouseX !== 'number') return;
  let t = screenToTile(mouseX, mouseY);
  if (!t || t.x < 0 || t.y < 0 || t.x >= MAP || t.y >= MAP) return;

  // Buildings: render()'s drawGhost() already previews the real building (we
  // keep `placing` set to the building key — see syncPlacing). Nothing to add.
  if (tool.kind === 'building') return;

  // Units: translucent real sprite at the hovered tile + a faint tile marker.
  if (tool.kind === 'unit'){
    tileDiamond(t.x, t.y, 1, 1, '#6f6', 0.18);
    let g = unitGhost();
    if (g){ g.x = t.x; g.y = t.y; g.path = []; g.moveT = 0;
      inWorldTransform(() => { X.save(); X.globalAlpha = 0.6; drawUnit(g); X.globalAlpha = 1; X.restore(); }); }
    return;
  }

  // Terrain / erase: a tinted tile diamond + short label.
  let col = tool.kind === 'erase' ? '#e44' : '#4cf';
  tileDiamond(t.x, t.y, 1, 1, col, 0.25);
  X.save();
  X.globalAlpha = 1; X.fillStyle = '#fff'; X.font = 'bold 12px system-ui, sans-serif';
  X.textAlign = 'center'; X.strokeStyle = '#000'; X.lineWidth = 3;
  let ctr = worldToScreen(t.x + 0.5, t.y + 0.5);
  let label = tool.kind === 'erase' ? 'erase' : tool.key;
  X.strokeText(label, ctr.x, ctr.y + 4); X.fillText(label, ctr.x, ctr.y + 4);
  X.restore();
}

// -------------------------------------------------------------------- input
function bindInput(){
  // Keep the mouse position current (screenToTile reads mouseX/mouseY).
  C.addEventListener('mousemove', e => {
    if (window.__editorPlaying) return; // Play mode: the game owns the cursor
    mouseX = e.clientX; mouseY = e.clientY;
    if (panning){
      camX -= (e.clientX - panLastX) / ZOOM;
      camY -= (e.clientY - panLastY) / ZOOM;
      panLastX = e.clientX; panLastY = e.clientY;
      return;
    }
    if (wallDragging){ updateWallDrag(mouseX, mouseY); return; } // extend the wall run (ghost previews it)
    if (painting){ // drag: paint terrain / place units (one-per-tile) / sweep-erase — applyTool dispatches
      let t = screenToTile(mouseX, mouseY);
      if (t) applyTool(t.x, t.y);
    }
  });
  C.addEventListener('mousedown', e => {
    if (window.__editorPlaying) return; // Play mode: game handles select/command
    if (e.button === 1 || e.button === 2){ // middle/right = pan
      panning = true; panLastX = e.clientX; panLastY = e.clientY; e.preventDefault(); return;
    }
    if (e.button !== 0) return;
    mouseX = e.clientX; mouseY = e.clientY;
    // (No rewind: edits after a Play apply to the LIVE simulated world — that's
    // the mid-game-edit flow. Reset restores the last-Play checkpoint instead.)
    // Walls drag out a run in one gesture (a plain click = one tile). Reuses
    // the game's wall-drag state; render()'s drawGhost previews the line.
    if (tool.kind === 'building' && typeof isWallBtype === 'function' && isWallBtype(tool.key)){
      startWallDrag(mouseX, mouseY); wallDragging = true; return;
    }
    let t = screenToTile(mouseX, mouseY);
    if (!t) return;
    applyTool(t.x, t.y);
    // Drag to paint terrain, place a row of units, or sweep-erase.
    if (tool.kind === 'terrain' || tool.kind === 'unit' || tool.kind === 'erase') painting = true;
  });
  window.addEventListener('mouseup', () => {
    if (wallDragging){ finalizeEditorWall(); wallDragging = false; }
    painting = false; panning = false;
  });
  C.addEventListener('contextmenu', e => e.preventDefault());
  // Wheel/trackpad zoom+pan is handled by the GAME's wheel listener (input.js),
  // which now runs in editor edit mode too — so pinch-zoom, two-finger-swipe
  // pan and wheel-notch zoom-around-cursor match normal gameplay exactly. (No
  // editor-specific wheel handler, to avoid double-zoom.)
  window.addEventListener('keydown', e => {
    let tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return; // don't hijack the Seed field etc.
    if (e.key === ' '){ e.preventDefault(); togglePlay(); return; } // Space toggles Play in either mode
    if (window.__editorPlaying) return; // Play mode: game handles arrows/hotkeys
    let pan = 40 / ZOOM;
    if (e.key === 'ArrowLeft'){ camX -= pan; camY += pan; }
    else if (e.key === 'ArrowRight'){ camX += pan; camY -= pan; }
    else if (e.key === 'ArrowUp'){ camX -= pan; camY -= pan; }
    else if (e.key === 'ArrowDown'){ camX += pan; camY += pan; }
    else return;
  });
  // Minimap navigation: click/drag the overlay to move the camera. The game's
  // own minimap input lives inside the (editor-guarded) #game handlers, and the
  // overlay is pointer-events:auto so clicks land on the minimap canvas (MC),
  // not #game — so we start the drag here. The game's window-level mousemove +
  // mouseup (input.js) then drive/end minimapDragging, unguarded, for free.
  if (typeof MC !== 'undefined' && MC){
    MC.addEventListener('mousedown', e => {
      if (!minimapOn || typeof minimapJump !== 'function') return;
      e.preventDefault(); e.stopPropagation();
      minimapJump(e.clientX, e.clientY); // fresh click: respects the diamond hit-test
      minimapDragging = true;            // subsequent window mousemoves keep panning
    });
  }
}

// ------------------------------------------------------------------------- boot
// Append the cursor overlay to every rendered frame. render() is a mutable
// function binding (function declaration), and gameLoop() calls it by name, so
// reassigning it here makes the loop draw our cursor after the world each frame.
let _origRender = render;
render = function(){ _origRender(); if (window.__editorMode) drawEditorCursor(); };

injectStyle();
bindInput();
enterEditor('medium'); // builds the world, then the palette (rebuildPalette)

// Expose for the init.js editor-boot branch and for debugging/tests.
window.enterEditor = enterEditor;
window.editorBuildSpec = buildSpec;
window.loadEditorScenario = loadEditorScenario;
window.loadIntoEditor = loadIntoEditor;

})();
