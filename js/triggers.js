// ---- SCENARIO TRIGGERS ----
// AoE2's trigger model (conditions → effects, objectives, instructions) for
// authored scenarios: the tutorial lessons now, campaigns later. See
// docs/scenarios.md for the authoring vocabulary.
//
// Two halves, kept apart like the rest of the engine:
//   scenarioScript — the authored triggers/areas/objectives. Static after load,
//                    identical on every peer (it ships in saves and snapshots).
//   scenarioState  — what has fired, timers, objective states, the message log,
//                    tags, markers. SIM state: snapshot, save, and simChecksum.
// Conditions read only sim state; viewer-only facts (a selection, a camera pan)
// reach the sim as a 'scenario-signal' command, the one viewer→sim channel.
// No script → every hook below is a no-op, so normal matches are untouched.
let scenarioScript = null;
let scenarioState = null;

const SCENARIO_EVERY = T30(10); // condition sweep cadence (a third of a game-second)

function resetScenario(){ scenarioScript = null; scenarioState = null; }

// Compile `steps` (a linear lesson: each step arms the next when it fires)
// into plain triggers, then start the runtime. Called by loadScenario.
function startScenario(spec){
  // `hint` rides along for the viewer's guide (js/scenario-ui.js); the sim never reads it.
  let trig = (spec.triggers || []).map(t => ({ id: t.id, on: t.on !== false, repeat: !!t.repeat, when: t.when || [], do: t.do || [], hint: t.hint || null }));
  let steps = spec.steps || [];
  let base = trig.length;
  steps.forEach((s, i) => {
    let fx = (s.do || []).slice();
    if (i + 1 < steps.length) fx.push({ on: base + i + 1 });
    trig.push({ id: s.id || ('step' + i), on: i === 0, repeat: false, when: s.when || [], do: fx, hint: s.hint || null });
  });
  // `on`/`off` may name a trigger id; resolve to indices once.
  let byName = new Map(trig.map((t, i) => [t.id, i]));
  trig.forEach(t => t.do.forEach(f => {
    if (f.on != null && typeof f.on === 'string') f.on = byName.get(f.on);
    if (f.off != null && typeof f.off === 'string') f.off = byName.get(f.off);
  }));
  scenarioScript = {
    id: spec.id || null, title: spec.title || '', next: spec.next || null,
    victory: spec.victory || 'conquest',
    areas: spec.areas || {}, objectives: spec.objectives || [], triggers: trig,
  };
  scenarioState = {
    on: trig.map(t => t.on ? 1 : 0), fired: trig.map(() => 0), since: trig.map(() => 0),
    obj: {}, log: [], markers: [], tags: {}, signals: {}, cam: null, result: 0,
  };
  // Authored entities carrying `tag` (js/scenario.js) register here.
  (spec._tagged || []).forEach(([name, id]) => tagEntity(name, id));
}

function tagEntity(name, id){
  (scenarioState.tags[name] || (scenarioState.tags[name] = [])).push(id);
}

// An area reference: a name from script.areas, or an inline {x,y,w?,h?}.
function scenarioArea(ref){
  let a = typeof ref === 'string' ? scenarioScript.areas[ref] : ref;
  if (!a) return null;
  return { x: a.x, y: a.y, w: a.w || 1, h: a.h || 1 };
}
function inScenarioArea(e, a){
  let x = Math.floor(e.x), y = Math.floor(e.y);
  if (e.type === 'building') { let c = footprintCenter(e); x = Math.floor(c.x); y = Math.floor(c.y); }
  return x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h;
}
function areaCenter(a){ return { x: a.x + (a.w >> 1), y: a.y + (a.h >> 1) }; }

// `what` selects objects: a utype/btype key, '#tag', or a class word.
function scenarioMatches(e, what){
  if (e.hp <= 0) return false;
  if (!what || what === 'any') return e.type === 'unit' ? !isHarmlessAnimal(e) : true;
  if (what[0] === '#') { let ids = scenarioState.tags[what.slice(1)]; return !!ids && ids.indexOf(e.id) >= 0; }
  if (what === 'unit') return e.type === 'unit' && !isHarmlessAnimal(e);
  if (what === 'building') return e.type === 'building';
  if (what === 'military') return e.type === 'unit' && isSoldierUnit(e);
  return e.utype === what || e.btype === what;
}
// Matching objects of `team` (null = any team), optionally inside an area.
// Buildings count once complete unless `foundations` is set.
function scenarioObjects(what, team, area, foundations){
  let a = area != null ? scenarioArea(area) : null;
  return entities.filter(e => (team == null || e.team === team) && scenarioMatches(e, what)
    && (foundations || e.type !== 'building' || e.complete)
    && (!a || inScenarioArea(e, a)));
}

// ---- Conditions (AoE2 names in comments). One key picks the kind. ----
function scenarioCondition(c, i, k){
  let st = scenarioState, team = c.team != null ? c.team : 0;
  if (c.after != null) return tick - st.since[i] >= Math.round(c.after * TPS);          // Timer
  if (c.ui != null) return !!st.signals[i + '.' + k];                                  // (viewer signal)
  if (c.inArea != null) return scenarioObjects(c.what || 'unit', team, c.inArea).length >= (c.n || 1); // Objects in Area
  if (c.own != null) return scenarioObjects(c.own, team, c.area, c.foundations).length >= (c.n || 1);   // Own Objects
  if (c.atMost != null) return scenarioObjects(c.atMost, c.team != null ? c.team : null, c.area, true).length <= (c.n || 0); // Own Fewer Objects
  if (c.destroyed != null) return scenarioObjects('#' + c.destroyed, null, null, true).length === 0;  // Destroy Object
  if (c.res != null) { let r = resources[team]; return Object.keys(c.res).every(k2 => r[k2] >= c.res[k2]); } // Accumulate Attribute
  if (c.age != null) return teamAge[team] >= c.age;
  if (c.tech != null) return hasUpgrade(team, c.tech);                                  // Research Technology
  if (c.goal != null) return st.obj[c.goal] === 2;                                       // (objective completed)
  return false;
}

// ---- Effects ----
function scenarioEffect(f){
  let st = scenarioState, team = f.team != null ? f.team : 0;
  if (f.say != null) st.log.push({ t: tick, text: f.say, who: f.who || '', task: f.task || '' }); // Display Instructions (task: the one-line version)
  else if (f.goal != null) { if (!st.obj[f.goal]) st.obj[f.goal] = 1; }                // Change Objective (show)
  else if (f.done != null) st.obj[f.done] = 2;
  else if (f.fail != null) st.obj[f.fail] = 3;
  else if (f.marker != null) { if (st.markers.indexOf(f.marker) < 0) st.markers.push(f.marker); }
  else if (f.unmark != null) st.markers = st.markers.filter(m => m !== f.unmark);
  else if (f.camera != null) { let c = areaCenter(scenarioArea(f.camera)); st.cam = { n: (st.cam ? st.cam.n : 0) + 1, x: c.x, y: c.y }; }
  else if (f.spawn != null) {                                                           // Create Object
    let a = scenarioArea(f.at), n = f.n || 1;
    for (let j = 0; j < n; j++) {
      let x = a.x + (j % a.w), y = a.y + (Math.floor(j / a.w) % a.h);
      let u = createUnit(f.spawn, x, y, team);
      if (f.stance) u.stance = f.stance;
      if (f.tag) tagEntity(f.tag, u.id);
    }
    refreshPopulationCounts();
  }
  else if (f.convert != null) {                                                         // Change Ownership
    scenarioObjects(f.convert, f.from != null ? f.from : null, f.area, true).forEach(e => {
      e.team = team;
      if (e.type === 'unit') { clearUnitPath(e); e.target = null; e.task = null; issueOrder(e, null); }
    });
    refreshPopulationCounts();
  }
  else if (f.attack != null || f.move != null) {                                        // Task Object
    let ids = scenarioObjects(f.attack != null ? f.attack : f.move, team).filter(e => e.type === 'unit').map(e => e.id);
    if (!ids.length) return;
    let goal = f.to != null ? scenarioArea(f.to) : null;
    let tgt = f.target != null ? scenarioObjects(f.target, null, null, true)[0] : null;
    let c = tgt ? (tgt.type === 'building' ? footprintCenter(tgt) : tgt) : areaCenter(goal);
    execCommand({ kind: 'command', unitIds: ids, tileX: Math.floor(c.x), tileY: Math.floor(c.y), targetId: tgt ? tgt.id : null }, team);
  }
  else if (f.give != null) { let r = resources[team]; Object.keys(f.give).forEach(k => { r[k] = (r[k] || 0) + f.give[k]; }); } // Tribute
  else if (f.on != null) { if (!st.on[f.on]) { st.on[f.on] = 1; st.since[f.on] = tick; } } // Activate Trigger
  else if (f.off != null) st.on[f.off] = 0;                                             // Deactivate Trigger
  else if (f.win != null || f.lose != null) {                                           // Declare Victory
    if (gameOver) return;
    st.result = f.win != null ? 1 : 2;
    gameOver = true; won = f.win != null;
  }
}

// Per-tick sweep (js/loop.js). Array order = firing order; a trigger armed
// by another fires no earlier than the next sweep.
function updateScenario(){
  if (!scenarioScript || gameOver || tick % SCENARIO_EVERY !== 0) return;
  let st = scenarioState, trig = scenarioScript.triggers;
  let armed = st.on.slice();
  for (let i = 0; i < trig.length; i++) {
    if (!armed[i] || !st.on[i] || (st.fired[i] && !trig[i].repeat)) continue;
    let t = trig[i];
    if (!t.when.every((c, k) => scenarioCondition(c, i, k))) continue;
    st.fired[i] = 1;
    if (!t.repeat) st.on[i] = 0; else st.since[i] = tick;
    t.do.forEach(scenarioEffect);
    if (gameOver) return;
  }
}

// Custom-victory scenarios end only by trigger — except the player being
// wiped out, which still loses (nothing left to play with).
function scenarioBlocksConquest(){
  return !!scenarioScript && scenarioScript.victory === 'custom' && !(defeatedTeams && defeatedTeams[0]);
}

// 'scenario-signal' executor (js/commands.js): a viewer-observed ui condition.
function execScenarioSignal(cmd){
  if (!scenarioState || typeof cmd.key !== 'string' || cmd.key.length > 12) return;
  scenarioState.signals[cmd.key] = 1;
}

function scenarioStrHash(h, s){ for (let i = 0; i < s.length; i++) h = detMix(h, s.charCodeAt(i)); return h; }
// simChecksum fold — only when a scenario runs, so plain-match checksums are unchanged.
function scenarioChecksum(h){
  let st = scenarioState;
  if (!st) return h;
  for (let i = 0; i < st.on.length; i++) { h = detMix(h, st.on[i] + 2 * st.fired[i]); h = detMix(h, st.since[i]); }
  Object.keys(st.obj).sort().forEach(k => { h = scenarioStrHash(h, k); h = detMix(h, st.obj[k]); });
  h = detMix(h, st.log.length);
  st.markers.forEach(m => { h = scenarioStrHash(h, String(m)); });
  Object.keys(st.tags).sort().forEach(k => { h = scenarioStrHash(h, k); st.tags[k].forEach(id => { h = detMix(h, id); }); });
  Object.keys(st.signals).sort().forEach(k => { h = scenarioStrHash(h, k); });
  return detMix(h, st.result);
}

// Snapshot / save plumbing: the script rides along so a resync or a loaded
// save can rebuild a scenario on a fresh page.
function captureScenario(){ return scenarioScript ? { script: scenarioScript, state: scenarioState } : null; }
function restoreScenario(s){
  scenarioScript = s ? s.script : null;
  scenarioState = s ? s.state : null;
}
