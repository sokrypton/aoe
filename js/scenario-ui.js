// ---- SCENARIO VIEWER: instructions, objectives, Learn to Play ----
// Viewer-only half of js/triggers.js: draws scenarioState (the message log and
// objectives) into #scn-card, reports ui conditions (a selection, a camera pan)
// as 'scenario-signal' commands, and runs the Learn to Play lesson menu.
// Nothing here is read by the sim.

const LEARN_LESSONS = [
  { id: 'learn-1', file: 'scenarios/learn/1-marching.js', title: 'Marching and Fighting', blurb: 'Select, move and fight' },
  { id: 'learn-2', file: 'scenarios/learn/2-feeding.js',  title: 'Feeding the Army',      blurb: 'Villagers, houses and gathering' },
  { id: 'learn-3', file: 'scenarios/learn/3-training.js', title: 'Training the Troops',   blurb: 'Barracks, soldiers and defense' },
  { id: 'learn-4', file: 'scenarios/learn/4-research.js', title: 'Research and Technology', blurb: 'Technologies and the Feudal Age' },
];

function learnDone(){ try { return JSON.parse(localStorage.getItem('aoeLearnDone') || '[]'); } catch (e) { return []; } }
function markLearnDone(id){
  let d = learnDone();
  if (d.indexOf(id) < 0) d.push(id);
  try { localStorage.setItem('aoeLearnDone', JSON.stringify(d)); } catch (e) {}
}

function renderLearnList(){
  let list = byId('learn-list');
  if (!list) return;
  let done = learnDone();
  list.innerHTML = '';
  LEARN_LESSONS.forEach((l, i) => {
    let b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-action-btn learn-item' + (done.indexOf(l.id) >= 0 ? ' done' : '');
    b.innerHTML = '<span class="learn-num">' + (i + 1) + '</span><span class="learn-txt"><b></b><small></small></span>'
      + (done.indexOf(l.id) >= 0 ? menuIcon('check') : '');
    b.querySelector('b').textContent = l.title;
    b.querySelector('small').textContent = l.blurb;
    b.onclick = () => startLesson(l.id);
    list.appendChild(b);
  });
}

// Lesson files are scripts that fill SCENARIOS: a <script> loads from file:// and
// inside the app, where fetching a local JSON is blocked.
const SCENARIOS = {};
function loadLessonScript(l){
  if (SCENARIOS[l.id]) return Promise.resolve(SCENARIOS[l.id]);
  return new Promise((ok, fail) => {
    let s = document.createElement('script');
    s.src = l.file;
    s.onload = () => SCENARIOS[l.id] ? ok(SCENARIOS[l.id]) : fail(new Error(l.file + ' did not register ' + l.id));
    s.onerror = () => fail(new Error('could not load ' + l.file));
    document.head.appendChild(s);
  });
}

// A lesson is a single-player match built by loadScenario (js/scenario.js).
async function startLesson(id){
  let l = LEARN_LESSONS.find(x => x.id === id);
  if (!l) return;
  let spec;
  try { spec = JSON.parse(JSON.stringify(await loadLessonScript(l))); } // (a fresh copy: startScenario resolves trigger names in place)
  catch (e) { console.error('[learn] load failed:', e); showMsg('Could not load the lesson'); return; }
  if (netRole) leaveMpSession();
  let speedSel = document.querySelector('input[name="gamespeed"]:checked');
  setGameSpeed(speedSel ? parseFloat(speedSel.value) : 2);
  applyAudioSettings();
  applyGameSettings();
  scnView.lesson = l.id;
  loadScenario(Object.assign({ id: l.id }, spec)); // restartGame → startGame closes the menu
  if (typeof updateUI === 'function') updateUI();
  showMsg(l.title);
}

// ---- Instruction card ----
const scnView = { lesson: null, key: '', logN: 0, camN: 0, collapsed: false, openUntil: 0, sent: new Set(), panFrom: {}, script: null };

// Control words differ by input: touch, the mobile skin's click-to-command
// desktop, and classic's AoE2 left-select / right-command.
const SCN_PHRASES = {
  touch:   { click: 'tap', Click: 'Tap', order: 'tap', Order: 'Tap', pan: 'drag the map with one finger',
             box: 'press and hold on empty ground, then drag a box around them', zoom: 'pinch' },
  click:   { click: 'click', Click: 'Click', order: 'click', Order: 'Click', pan: 'use the arrow keys (or swipe two fingers on a trackpad)',
             box: 'drag a box around them with the mouse', zoom: 'use the scroll wheel' },
  classic: { click: 'left-click', Click: 'Left-click', order: 'right-click', Order: 'Right-click', pan: 'use the arrow keys',
             box: 'drag a box around them with the left mouse button', zoom: 'use the scroll wheel' },
};
function scnInputMode(){
  let touch = lastTouchTime > 0 || (window.matchMedia && matchMedia('(pointer: coarse)').matches);
  return touch ? 'touch' : isClassicUI ? 'classic' : 'click';
}
function scnText(s){
  let p = SCN_PHRASES[scnInputMode()];
  return String(s).replace(/\{(\w+)\}/g, (m, k) => p[k] != null ? p[k] : m);
}

// The card opens in full on each new message, then folds itself to a one-line task bar after a reading time
// (~200 words a minute, at least 6s). Opened by hand, it stays open until closed.
function toggleScenarioCard(){ scnView.collapsed = !scnView.collapsed; scnView.openUntil = Infinity; scnView.key = ''; updateScenarioUI(); }
function readMs(text){ return Math.max(6000, String(text).split(/\s+/).length * 300 + 2000); }
// The bar's line: the step's authored task, else the message's last sentence (lessons end on the instruction).
function taskLine(m){
  if (!m) return '';
  if (m.task) return scnText(m.task);
  let s = scnText(m.text).match(/[^.!?]+[.!?]*/g) || [''];
  return s[s.length - 1].trim();
}

// Per frame (js/init.js gameLoop): cheap unless the log/objectives changed.
function updateScenarioUI(){
  let card = byId('scn-card');
  if (!card) return;
  if (!scenarioScript || !gameStarted) { if (card.style.display !== 'none') card.style.display = 'none'; scnView.script = null; if (scnGlow.length || scnGlowEls.size) updateScenarioGuide(); return; }
  let st = scenarioState;
  if (scnView.script !== scenarioScript) { // a new scenario (or a loaded save): start the view fresh
    scnView.script = scenarioScript; scnView.logN = 0; scnView.camN = st.cam ? st.cam.n : 0;   // (logN 0: the current message opens the card)
    scnView.sent.clear(); scnView.panFrom = {}; scnView.collapsed = false; scnView.key = '';
  }
  if (!gameOver) reportScenarioSignals();
  updateScenarioGuide();
  if (st.cam && st.cam.n !== scnView.camN) { scnView.camN = st.cam.n; jumpCameraToTile(st.cam.x + 0.5, st.cam.y + 0.5); }
  if (st.log.length !== scnView.logN) { // a new instruction re-opens the card
    scnView.logN = st.log.length; scnView.collapsed = false;
    let m = st.log[st.log.length - 1]; scnView.openUntil = performance.now() + readMs(m ? m.text : '');
    card.classList.remove('scn-new'); void card.offsetWidth; card.classList.add('scn-new');   // (restart the slide-in: the text changed)
    if (window.playSound) playSound('chat');
  }
  if (!scnView.collapsed && performance.now() > scnView.openUntil) scnView.collapsed = true;
  let goals = scenarioScript.objectives.filter(o => st.obj[o.id]);
  let key = st.log.length + '|' + goals.map(o => st.obj[o.id]).join('') + '|' + scnView.collapsed + '|' + scnInputMode() + '|' + gameOver;
  if (key === scnView.key) return;
  scnView.key = key;
  card.style.display = gameOver ? 'none' : '';
  card.classList.toggle('collapsed', scnView.collapsed);
  let last = st.log[st.log.length - 1];
  // Folded: the head IS the task bar; open: the lesson's title over the full message and objectives.
  byId('scn-title').textContent = scnView.collapsed ? (taskLine(last) || scenarioScript.title || '') : (scenarioScript.title || 'Objectives');
  let doneN = goals.filter(o => st.obj[o.id] === 2).length;
  byId('scn-count').textContent = goals.length ? doneN + '/' + goals.length : '';
  byId('scn-chev').textContent = scnView.collapsed ? '▾' : '▴';
  let txt = byId('scn-text');
  txt.innerHTML = '';
  if (last) {
    if (last.who) { let w = document.createElement('b'); w.textContent = last.who + ': '; txt.appendChild(w); }
    txt.appendChild(document.createTextNode(scnText(last.text)));
  }
  let ul = byId('scn-goals');
  ul.innerHTML = '';
  goals.forEach(o => {
    let li = document.createElement('li');
    li.className = st.obj[o.id] === 2 ? 'done' : st.obj[o.id] === 3 ? 'failed' : '';
    li.textContent = scnText(o.text);
    ul.appendChild(li);
  });
}

// ---- Guide: what to press next ----
// A trigger's `hint` (viewer-only, never read by the sim) names the action its
// conditions wait for; the guide walks that action's click chain from the
// current HUD state and pulses the next thing to press: a unit or building on
// the map (gold ring, js/render.js) or a HUD button (.scn-glow). A list is
// tried in order; the first hint with something to point at wins.
//   {select: what, n?}        pulse those units/buildings until n of them are selected
//   {with: what, on: what?}   select `with`, then pulse `on` (the target to order onto)
//   {build: BTYPE}            villager → build menu → the building's button
//   {train: utype}            the building that trains it → its train button
//   {research: tech|'age'}    the building that owns it → its research button
//   {button: id}              a fixed HUD button (e.g. 'bell-btn')
const MIL_BUILDINGS = new Set(['BARRACKS', 'TOWER', 'PTOWER', 'WALL', 'GATE', 'SWALL', 'SGATE']);
let scnGlow = [];                 // entity ids the map pulses (read by drawScenarioMarkers)
const scnGlowEls = new Set();
const ownSelN = what => selected.filter(e => e.team === myTeam && scenarioMatches(e, what)).length;
const ownSel = what => ownSelN(what) > 0;
const ownIds = what => scenarioObjects(what, myTeam, null, true).map(e => e.id);
const shown = b => !!b && b.getClientRects().length > 0;   // (not offsetParent: null for the fixed-position corner buttons)
const hudBtn = sel => { let b = document.querySelector(sel); return shown(b) ? b : null; };
function guideTarget(h){
  if (h.select != null) return ownSelN(h.select) >= (h.n || 1) ? null : { ids: ownIds(h.select) };
  if (h.with != null) {
    if (!ownSel(h.with)) return { ids: ownIds(h.with) };
    return h.on != null ? { ids: scenarioObjects(h.on, null, null, true).filter(e => entityVisibleToTeam(e, myTeam)).map(e => e.id) } : null;
  }
  if (h.button != null) { let b = byId(h.button); return shown(b) ? { el: b } : null; }
  if (h.build != null) {
    if (scenarioObjects(h.build, myTeam, null, true).length || placing === h.build) return null;
    if (!ownSel('villager')) return { ids: ownIds('villager') };
    let b = hudBtn('[data-tip-type="building"][data-tip-key="' + h.build + '"]')
      || hudBtn('[data-menu="' + (MIL_BUILDINGS.has(h.build) ? 'mil' : 'eco') + '"]') || hudBtn('.back-btn.submenu-back');   // (in the other build menu: step back)
    return b ? { el: b } : null;
  }
  if (h.train != null) {
    let b = hudBtn('[data-tip-type="unit"][data-tip-key="' + h.train + '"]');
    if (b) return { el: b };
    return { ids: entities.filter(e => e.type === 'building' && e.team === myTeam && e.complete && (BLDGS[e.btype].builds || []).includes(h.train)).map(e => e.id) };
  }
  if (h.research != null) {
    let owner = e => e.type === 'building' && e.team === myTeam && e.complete
      && (h.research === 'age' ? e.btype === 'TC' : (BLDGS[e.btype].researches || []).includes(h.research));
    if (entities.some(e => owner(e) && e.research)) return null;   // under way: nothing left to press
    let b = hudBtn('[data-research="' + h.research + '"]');
    return b ? { el: b } : { ids: entities.filter(owner).map(e => e.id) };
  }
  return null;
}
function updateScenarioGuide(){
  let el = null, ids = [];
  if (scenarioScript && !gameOver) {
    let st = scenarioState;
    scenarioScript.triggers.forEach((t, i) => {
      if (!st.on[i] || !t.hint || el || ids.length) return;
      for (const h of [].concat(t.hint)) { let r = guideTarget(h); if (r && (r.el || (r.ids && r.ids.length))) { el = r.el || null; ids = r.ids || []; break; } }
    });
  }
  scnGlow = ids;
  for (const e of scnGlowEls) if (e !== el) { e.classList.remove('scn-glow'); scnGlowEls.delete(e); }
  if (el && !scnGlowEls.has(el)) { el.classList.add('scn-glow'); scnGlowEls.add(el); }
}

// ui conditions of armed triggers, checked locally and sent once each.
function reportScenarioSignals(){
  let st = scenarioState;
  scenarioScript.triggers.forEach((t, i) => {
    if (!st.on[i]) return;
    t.when.forEach((c, k) => {
      if (c.ui == null) return;
      let key = i + '.' + k;
      if (st.signals[key] || scnView.sent.has(key) || !scnUiMet(c, key)) return;
      scnView.sent.add(key);
      submitCommand({ kind: 'scenario-signal', key });
    });
  });
}
function scnUiMet(c, key){
  if (c.ui === 'select') return selected.filter(e => e.team === myTeam && scenarioMatches(e, c.what)).length >= (c.n || 1);
  if (c.ui === 'pan') {
    let m = fromIso(camX, camY), a = scnView.panFrom[key] || (scnView.panFrom[key] = m);
    return Math.hypot(m.x - a.x, m.y - a.y) >= (c.tiles || 6);
  }
  return false;
}

// ---- End of a lesson ----
function lessonActive(){ return !!(scnView.lesson && scenarioScript); }
function scenarioEndLine(iWon){
  if (!scenarioScript) return null;
  return iWon ? 'Lesson complete: ' + (scenarioScript.title || '') : 'The lesson was lost. Try again!';
}
// Shown under See Map on a lesson's end screen: the next lesson, or a retry.
function scenarioEndButtonLabel(iWon){
  if (!lessonActive()) return null;
  if (!iWon) return 'Try Again';
  let i = LEARN_LESSONS.findIndex(l => l.id === scnView.lesson);
  return i >= 0 && i + 1 < LEARN_LESSONS.length ? 'Next Lesson' : 'Done';
}
function scenarioEndButton(){
  let iWon = didIWin(), i = LEARN_LESSONS.findIndex(l => l.id === scnView.lesson);
  if (!iWon) return startLesson(scnView.lesson);
  if (i >= 0 && i + 1 < LEARN_LESSONS.length) return startLesson(LEARN_LESSONS[i + 1].id);
  scnView.lesson = null;
  toggleMenu(); showMenuPanel('learn');
}
// gameLoop's one-shot game-over hook: record the lesson, offer the next step.
function scenarioGameOver(iWon){
  if (!lessonActive()) return;
  if (iWon) markLearnDone(scnView.lesson);
  let b = byId('scn-end-btn'), label = scenarioEndButtonLabel(iWon);
  if (b && label) { b.innerHTML = menuIcon(iWon ? 'learn' : 'retry') + label; b.style.display = ''; }
}
