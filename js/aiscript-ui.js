// ---- AI PLAN: menus and editor (viewer side of js/aiscript.js) ----
// The single-player choice (a preset key or 'custom') and the custom script persist in localStorage, along with the
// player's saved scripts by name; a match gets the compiled script on its AI seats' controllers (aiPlanScript), where
// the sim reads it. The MP lobby offers the same choices per AI seat (js/lobby.js).

const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

// The plan choices: the presets loaded from ai-scripts/ (in load order), then the custom script.
function aiPlanKeys(){ return [...Object.keys(AI_SCRIPT_PRESETS), 'custom']; }
function aiPlanLabel(k){ return k === 'custom' ? 'Custom' : AI_SCRIPT_PRESETS[k].name; }
// The AI Plan pickers (Match Setup, lobby seats) are hidden while the feature is finished: every AI plays the default plan.
const AI_PLAN_MENU = false;
function aiPlanChoice(){ const v = AI_PLAN_MENU ? lsGet('aoeAIPlan', 'default') : 'default'; return aiPlanKeys().includes(v) ? v : 'default'; }
function aiCustomScriptText(){ return lsGet('aoeAIScript', ''); }
function setAIPlan(v){
  lsSet('aoeAIPlan', v);
  if (v === 'custom' && !aiCustomScriptText()) openAIScriptEditor();
}
// The compiled script for a plan choice (a preset key, or 'custom' → the active custom text), or null for the default AI.
function aiPlanScript(choice){
  return resolveAIScript(choice === 'custom' ? aiCustomScriptText() : choice);
}
// Give the single-player match's AI seats the chosen plan (init.js startGame, before the first AI tick).
function applyAIPlanToSeats(){
  const s = aiPlanScript(aiPlanChoice());
  teamControllers.forEach(c => { if (c && c.type === 'ai') { if (s) c.script = s; else delete c.script; } });
}
// The menu's pills, one per plan choice; Custom… opens the editor.
function buildAIPlanPills(){
  const row = byId('aiplan-pills'); if (!row) return;
  show('opt-aiplan', AI_PLAN_MENU);
  row.innerHTML = '';
  for (const k of aiPlanKeys()) {
    const l = document.createElement('label'); l.className = 'opt-pill';
    const i = document.createElement('input'); i.type = 'radio'; i.name = 'aiplan'; i.value = k;
    i.onchange = () => setAIPlan(k);
    if (k === 'custom') i.onclick = openAIScriptEditor;
    const sp = document.createElement('span'); sp.textContent = k === 'custom' ? 'Custom…' : aiPlanLabel(k);
    l.title = k === 'custom' ? 'Your own script: write one, open a file, or pick a saved one' : AI_SCRIPT_PRESETS[k].about || '';
    l.append(i, sp); row.appendChild(l);
  }
  syncAIPlanPills();
}
function syncAIPlanPills(){
  const el = document.querySelector('input[name="aiplan"][value="' + aiPlanChoice() + '"]');
  if (el) el.checked = true;
}

// ---- Saved scripts: { name: text }, keyed by the script's own "name" ----
function aiSavedScripts(){ try { const o = JSON.parse(lsGet('aoeAIScripts', '{}')); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
function setAISavedScripts(o){ lsSet('aoeAIScripts', JSON.stringify(o)); }

// ---- Editor ----
function aiScriptButton(label, title, onclick){
  const b = document.createElement('button'); b.type = 'button'; b.className = 'aiscript-preset';
  b.textContent = label; b.title = title || ''; b.onclick = onclick; return b;
}
function fillAIScriptLists(){
  const ta = byId('aiscript-text'), load = t => { ta.value = t; checkAIScriptEditor(); };
  const ps = byId('aiscript-presets'); ps.innerHTML = '';
  for (const k of Object.keys(AI_SCRIPT_PRESETS)) ps.appendChild(aiScriptButton(AI_SCRIPT_PRESETS[k].name, AI_SCRIPT_PRESETS[k].about, () => load(JSON.stringify(AI_SCRIPT_PRESETS[k], null, 2))));
  const mine = aiSavedScripts(), ms = byId('aiscript-mine'); ms.innerHTML = '';
  for (const name of Object.keys(mine).sort()) {
    const g = document.createElement('span'); g.className = 'aiscript-mine';
    const del = aiScriptButton('×', 'Delete ' + name, () => { const o = aiSavedScripts(); delete o[name]; setAISavedScripts(o); fillAIScriptLists(); });
    del.classList.add('aiscript-del');
    g.append(aiScriptButton(name, 'Load ' + name, () => load(mine[name])), del); ms.appendChild(g);
  }
  show('aiscript-mine-row', Object.keys(mine).length > 0);
}
function openAIScriptEditor(){
  const ed = byId('aiscript-editor'); if (!ed) return;
  const ta = byId('aiscript-text');
  ta.value = aiCustomScriptText() || JSON.stringify(AI_SCRIPT_PRESETS.rusher || AI_SCRIPT_PRESETS.default, null, 2);
  fillAIScriptLists();
  ed.style.display = 'flex';
  ta.onkeydown = e => e.stopPropagation();   // (typing never reaches the game's hotkeys)
  checkAIScriptEditor();
}
function closeAIScriptEditor(){
  const ed = byId('aiscript-editor'); if (ed) ed.style.display = 'none';
  if (aiPlanChoice() === 'custom' && !aiCustomScriptText()) { lsSet('aoeAIPlan', 'default'); syncAIPlanPills(); }
}
function checkAIScriptEditor(){
  const r = compileAIScript(byId('aiscript-text').value), ul = byId('aiscript-errors'), st = byId('aiscript-status');
  ul.innerHTML = '';
  for (const m of (r.errors || []).slice(0, 8)) { const li = document.createElement('li'); li.textContent = m; ul.appendChild(li); }
  st.textContent = r.errors ? r.errors.length + ' problem' + (r.errors.length > 1 ? 's' : '') : r.script.rules.length + ' rule' + (r.script.rules.length !== 1 ? 's' : '') + ' — OK';
  st.className = r.errors ? 'bad' : 'ok';
  byId('aiscript-save').disabled = byId('aiscript-download').disabled = !!r.errors;
  return r;
}
// Use the script: it becomes the active custom plan and is saved under its name.
function saveAIScriptEditor(){
  const r = checkAIScriptEditor(); if (r.errors) return;
  const text = byId('aiscript-text').value, mine = aiSavedScripts();
  mine[r.script.name] = text; setAISavedScripts(mine);
  lsSet('aoeAIScript', text); lsSet('aoeAIPlan', 'custom');
  syncAIPlanPills();
  const ed = byId('aiscript-editor'); if (ed) ed.style.display = 'none';
  if (typeof onLobbyAIPlanSaved === 'function') onLobbyAIPlanSaved();   // (the lobby re-sends a seat set to Custom)
}
// Open a .json script or an ai-scripts/ preset file into the editor.
function openAIScriptFile(input){
  const f = input.files && input.files[0]; if (!f) return;
  f.text().then(t => {
    const body = parseAIScriptText(t);
    try { byId('aiscript-text').value = JSON.stringify(JSON.parse(body), null, 2); } catch (e) { byId('aiscript-text').value = body; }
    checkAIScriptEditor();
  });
  input.value = '';   // (re-opening the same file fires change again)
}
// Download the script as <name>.json — the file simulate.js and agents read (drop it in ai-scripts/).
function downloadAIScriptEditor(){
  const r = checkAIScriptEditor(); if (r.errors) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([parseAIScriptText(byId('aiscript-text').value).trim() + '\n'], { type: 'application/json' }));
  a.download = (r.script.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ai-plan') + '.json';
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', buildAIPlanPills);
