// ---- AI SCRIPTS ----
// A seat's strategy as data — AoE2's .per idea (defrules that set strategic numbers), in JSON a person or an agent
// can write. A script is a list of rules: when every condition holds, its `set` levers take effect and STAY set (as
// AoE2's strategic numbers do); `once` makes a rule fire a single time (a rule with no conditions — the setup — is
// once unless it says "once": false). The levers are the AI profile's own keys
// (js/core.js AI_LEVELS) plus a few strategic ones (unitMix, counterPick, techOrder) — so a script steers what the AI
// decides; it never adds abilities or resources, and the tactical layer (gathering, pathing, squads) stays the AI's.
//
// Determinism: the script is plain data on the seat's controller (teamControllers[t].script — the same object ships
// in lockstep-start, snapshots and saves); what it has set lives in AI_STATES[t] (scriptSet, scriptDone — hashed).
// Conditions read only sim state. No code runs from a script.
//
// {
//   "name": "Archer Rush",
//   "rules": [
//     { "set": { "maxAge": 1, "maxVils": 22, "unitMix": { "archer": 3, "spearman": 1 } } },
//     { "when": [ { "age": 1 } ], "set": { "maxBarracks": 3, "attackSize": 6 } },
//     { "when": [ { "minute": 14 } ], "set": { "maxAge": 2, "maxVils": 45 }, "once": true }
//   ]
// }

// Lever types: int/num [min, max]; bool; sec (game seconds — stored as ticks); ages3 (per age: Dark, Feudal, Castle);
// ages3sec (the same, in game seconds); ratios (gatherer weights); mix (unit weights); techs (an UPGRADES key list).
const AI_SCRIPT_LEVERS = {
  // economy
  maxVils: ['int', 0, 200], ecoRatios: ['ratios'], farmShare: ['int', 0, 40], targetFarms: ['int', 0, 60],
  houseBuffer: ['int', 0, 20], maxTradeCarts: ['int', 0, 40], civilianMilitia: ['int', 0, 100],
  // ages
  maxAge: ['int', 0, 2], ageUpVils: ['ages3'], ageUpTick: ['ages3sec'],
  // buildings
  maxBarracks: ['int', 0, 8], barracksVil: ['int', 0, 100], walls: ['bool'], wallAge: ['int', 0, 2],
  wallRadius: ['int', 3, 12], maxTowers: ['int', 0, 12],
  // army and attacks
  armyCap: ['int', 0, 200], darkAgeArmy: ['int', 0, 60], armyPerVil: ['num', 0, 3], armyReserve: ['int', 0, 100], attackSize: ['int', 1, 60],
  waveCap: ['int', 1, 100], commitPercent: ['int', 0, 100], attackTick: ['sec'], waveCooldown: ['sec'],
  attacksVillagers: ['bool'], queueLimit: ['int', 1, 10],
  unitMix: ['mix'], counterPick: ['num', 0, 1], techOrder: ['techs'],
};
const AI_SCRIPT_UNITS = ['militia', 'spearman', 'archer', 'knight'];
const AI_SCRIPT_RATIOS = ['forage', 'chop', 'mine_gold', 'mine_stone'];
const AI_SCRIPT_CONDS = ['minute', 'age', 'villagers', 'army', 'res', 'own', 'atMost', 'tech', 'underAttack', 'not'];

// Check a script and normalise it to the stored form (seconds → ticks). Returns { script } or { errors: [...] } —
// every problem, worded for the person or agent who wrote it.
function compileAIScript(src){
  const errors = [], err = m => errors.push(m);
  let s = src;
  if (typeof s === 'string') { try { s = JSON.parse(parseAIScriptText(s)); } catch (e) { return { errors: ['Not valid JSON: ' + e.message] }; } }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { errors: ['A script is an object: { "name": ..., "rules": [...] }'] };
  const rules = Array.isArray(s.rules) ? s.rules : (err('"rules" must be a list'), []);
  if (rules.length > 100) err('At most 100 rules');
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const checkCond = (c, where) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) { err(where + ': a condition is an object, e.g. { "age": 1 }'); return null; }
    const keys = Object.keys(c).filter(k => k !== 'n');
    if (keys.length !== 1 || !AI_SCRIPT_CONDS.includes(keys[0])) { err(where + ': unknown condition ' + JSON.stringify(c) + ' (use one of: ' + AI_SCRIPT_CONDS.join(', ') + ')'); return null; }
    const k = keys[0], v = c[k];
    if (k === 'not') { const inner = checkCond(v, where + ' (not)'); return inner && { not: inner }; }
    if (k === 'res') { if (!v || typeof v !== 'object' || !Object.keys(v).every(r => ['food', 'wood', 'gold', 'stone'].includes(r) && isNum(v[r]))) { err(where + ': "res" is { "food": 500, ... }'); return null; } return { res: { ...v } }; }
    if (k === 'own' || k === 'atMost') { if (typeof v !== 'string' || !(UNITS[v] || BLDGS[v])) { err(where + ': "' + k + '" names a unit or building, e.g. "archer" or "BARRACKS"'); return null; }
      if (c.n != null && !isNum(c.n)) { err(where + ': "n" is a number'); return null; } return { [k]: v, n: c.n != null ? c.n : (k === 'own' ? 1 : 0) }; }
    if (k === 'tech') { if (!UPGRADES[v]) { err(where + ': unknown tech "' + v + '"'); return null; } return { tech: v }; }
    if (k === 'underAttack') { if (typeof v !== 'boolean') { err(where + ': "underAttack" is true or false'); return null; } return { underAttack: v }; }
    if (!isNum(v)) { err(where + ': "' + k + '" is a number'); return null; }
    return { [k]: v };
  };
  const checkLever = (key, v, where) => {
    const L = AI_SCRIPT_LEVERS[key];
    if (!L) { err(where + ': unknown lever "' + key + '"'); return undefined; }
    const [type, lo, hi] = L, inRange = x => isNum(x) && x >= lo && x <= hi;
    if (type === 'int') { if (!Number.isInteger(v) || !inRange(v)) { err(where + ': "' + key + '" is a whole number ' + lo + '–' + hi); return undefined; } return v; }
    if (type === 'num') { if (!inRange(v)) { err(where + ': "' + key + '" is a number ' + lo + '–' + hi); return undefined; } return v; }
    if (type === 'bool') { if (typeof v !== 'boolean') { err(where + ': "' + key + '" is true or false'); return undefined; } return v; }
    if (type === 'sec') { if (!isNum(v) || v < 0 || v > 7200) { err(where + ': "' + key + '" is game seconds, 0–7200'); return undefined; } return Math.round(v * TPS); }
    if (type === 'ages3' || type === 'ages3sec') { if (!Array.isArray(v) || v.length !== 3 || !v.every(x => isNum(x) && x >= 0)) { err(where + ': "' + key + '" is [dark, feudal, castle], e.g. [0, 20, 28]'); return undefined; }
      // (at least 1: the AI reads a 0 here as "no such step" — never)
      return type === 'ages3sec' ? v.map(x => Math.max(1, Math.round(x * TPS))) : v.map(x => Math.max(1, Math.round(x))); }
    if (type === 'ratios' || type === 'mix') { const names = type === 'ratios' ? AI_SCRIPT_RATIOS : AI_SCRIPT_UNITS;
      if (!v || typeof v !== 'object' || !Object.keys(v).length || !Object.keys(v).every(n => names.includes(n) && isNum(v[n]) && v[n] >= 0 && v[n] <= 100)) { err(where + ': "' + key + '" is weights for ' + names.join('/') + ', each 0–100'); return undefined; }
      return { ...v }; }
    if (type === 'techs') { if (!Array.isArray(v) || !v.every(t => UPGRADES[t])) { err(where + ': "techOrder" lists tech keys (' + Object.keys(UPGRADES).join(', ') + ')'); return undefined; } return v.slice(); }
    return undefined;
  };
  const out = { name: typeof s.name === 'string' ? s.name.slice(0, 60) : 'Custom', about: typeof s.about === 'string' ? s.about.slice(0, 200) : '', rules: [] };
  rules.forEach((r, i) => {
    const where = 'Rule ' + (i + 1);
    if (!r || typeof r !== 'object') { err(where + ' is not an object'); return; }
    const when = r.when == null ? [] : Array.isArray(r.when) ? r.when : (err(where + ': "when" is a list of conditions'), []);
    const set = r.set && typeof r.set === 'object' && !Array.isArray(r.set) ? r.set : (err(where + ': "set" is an object of levers'), {});
    // (a rule with no conditions is the setup: it fires once — re-asserting it every pass undid later rules' levers)
    const rule = { when: when.map((c, k) => checkCond(c, where + ' condition ' + (k + 1))).filter(Boolean), set: {}, once: r.once === true || (r.once !== false && !when.length) };
    for (const key of Object.keys(set)) { const v = checkLever(key, set[key], where); if (v !== undefined) rule.set[key] = v; }
    out.rules.push(rule);
  });
  return errors.length ? { errors } : { script: out };
}

// ---- Runtime (sim) ----
function aiScriptCond(ai, c){
  const team = ai.team;
  if (c.not) return !aiScriptCond(ai, c.not);
  if (c.minute != null) return tick >= c.minute * 60 * TPS;
  if (c.age != null) return teamAge[team] >= c.age;
  if (c.villagers != null) return entities.filter(e => e.team === team && e.type === 'unit' && e.utype === 'villager').length >= c.villagers;
  if (c.army != null) return entities.filter(e => e.team === team && e.type === 'unit' && isArmyUnit(e.utype) && e.utype !== 'scout').length >= c.army;
  if (c.res) { const r = resources[team]; return Object.keys(c.res).every(k => r[k] >= c.res[k]); }
  if (c.own) return entities.filter(e => e.team === team && e.hp > 0 && (e.utype === c.own || (e.btype === c.own && e.complete))).length >= c.n;
  if (c.atMost) return entities.filter(e => e.team === team && e.hp > 0 && (e.utype === c.atMost || e.btype === c.atMost)).length <= c.n;
  if (c.tech) return hasUpgrade(team, c.tech);
  if (c.underAttack != null) return aiUnderRealPressure(ai) === c.underAttack;
  return false;
}
// Each AI decision tick, before planning (updateAI): rules in order; a fired rule's levers replace what was set.
function runAIScript(ai){
  const c = teamControllers[ai.team], s = c && c.script;
  if (!s || !s.rules.length) return;
  let set = ai.scriptSet, changed = false;
  if (!ai.scriptDone || ai.scriptDone.length !== s.rules.length) ai.scriptDone = s.rules.map(() => 0);
  s.rules.forEach((r, i) => {
    if (r.once && ai.scriptDone[i]) return;
    if (!r.when.every(cd => aiScriptCond(ai, cd))) return;
    ai.scriptDone[i] = 1;
    for (const k of Object.keys(r.set)) { if (!set || JSON.stringify(set[k]) !== JSON.stringify(r.set[k])) { set = { ...(set || {}), [k]: r.set[k] }; changed = true; } }
  });
  if (changed) ai.scriptSet = set;   // (a NEW object on change: aiProfileFor caches by it)
}
// The profile with the script's levers over it (cached per set object — a rollback restores another object).
const _aiScriptProfiles = new WeakMap();
function aiScriptedProfile(base, set){
  let byBase = _aiScriptProfiles.get(set);
  if (!byBase) _aiScriptProfiles.set(set, byBase = new Map());
  let p = byBase.get(base);
  if (!p) byBase.set(base, p = { ...base, ...set });
  return p;
}
// simChecksum fold: the script a seat runs (static — hashed once per object) and what it has set.
const _aiScriptHash = new WeakMap();
function aiScriptChecksum(h, team){
  const c = teamControllers[team], s = c && c.script;
  if (s) { let v = _aiScriptHash.get(s); if (v === undefined) { v = 0; const j = JSON.stringify(s); for (let i = 0; i < j.length; i++) v = detMix(v, j.charCodeAt(i)); _aiScriptHash.set(s, v); } h = detMix(h, v); }
  const ai = AI_STATES && AI_STATES[team];
  if (ai && ai.scriptSet) { const j = JSON.stringify(ai.scriptSet); for (let i = 0; i < j.length; i++) h = detMix(h, j.charCodeAt(i)); }
  if (ai && ai.scriptDone) for (const d of ai.scriptDone) h = detMix(h, d);
  return h;
}

// ---- Presets: one file each in ai-scripts/ (a <script> line, then plain JSON — loads from file:// like the lessons).
// The menus offer whatever is registered here, in load order.
const AI_SCRIPT_PRESETS = { default: { name: 'Default', about: 'The difficulty\'s own plan.', rules: [] } };
// Script file text → its object: plain JSON, or a preset file (JSON after the `AI_SCRIPT_PRESETS[...] =` line).
function parseAIScriptText(text){
  const m = /^[^{]*AI_SCRIPT_PRESETS\[[^\]]*\]\s*=/.exec(text);
  return m ? text.slice(m[0].length).trim().replace(/;$/, '') : text;
}
// A seat's script choice → the compiled script, or null. `choice`: a preset key, or a script object / file text.
function resolveAIScript(choice){
  if (choice == null || choice === '' || choice === 'default') return null;
  const src = typeof choice === 'string' && AI_SCRIPT_PRESETS[choice] ? AI_SCRIPT_PRESETS[choice] : choice;
  const r = compileAIScript(src);
  return r.script && r.script.rules.length ? r.script : null;
}
