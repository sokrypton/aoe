#!/usr/bin/env node
// ---- Unit-stat audit vs AoE2 (The Conquerors) reference ----
// Diffs js/core.js UNITS/BLDGS against docs/reference/unit_stats_aoc.csv
// (Leif Ericson's AoK Heaven tables, vendored from openage's
// doc/reverse_engineering/unit_stats/). INFORMATIONAL: exits 0 always —
// deviations are fine when deliberate, but they must be listed in
// DELIBERATE below (with the reason) or they show up in the report.
//
//   node tools/stats-audit.js          # report all mapped units
//   node tools/stats-audit.js all     # also show whitelisted deviations

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

// core.js is a browser script (canvas/DOM globals at load). Stub just enough
// DOM for the constants to evaluate; the sim entities aren't touched here.
function loadCore() {
  const canvasStub = () => ({
    getContext: () => new Proxy({}, { get: () => () => {} }),
    width: 0, height: 0, style: {},
    addEventListener: () => {},
  });
  const windowStub = new Proxy({ innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 }, {
    get: (t, k) => (k in t ? t[k] : undefined),
    set: (t, k, v) => (t[k] = v, true),
  });
  const sandbox = {
    window: windowStub,
    document: { getElementById: canvasStub, createElement: canvasStub, addEventListener: () => {} },
    navigator: { userAgent: 'node', maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: '', href: '' },
    console, Math, JSON, Array, Object, Set, Map, performance: { now: () => 0 },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/core.js'), 'utf8'), sandbox, { filename: 'core.js' });
  // top-level const/let live in the context's lexical scope, not as sandbox
  // properties — evaluate an expression inside the context to pull them out.
  return vm.runInContext('({ UNITS, BLDGS, TPS })', sandbox);
}

// our key -> CSV row name
const UNIT_MAP = {
  villager: 'Villager',
  militia: 'Militia',
  spearman: 'Spearman',
  archer: 'Archer',
  scout: 'Scout Cavalry',
  knight: 'Knight',
  ram: 'Battering Ram',
  tradecart: 'Trade Cart',
};

// Deliberate deviations: ourKey.field -> reason (kept out of the main report).
// Add entries ONLY with a reason; docs/aoe2-ai-behavior.md §11 carries the
// design rationale for gameplay-motivated ones.
const DELIBERATE = {
  // Scout is Feudal-gated in this game (AGE_REQ), and AoE2 gives scouts a
  // free +0.35 speed at Feudal — so our scout ships at the Feudal speed
  // (1.2 + 0.35), not the Dark-Age 1.2 the AoC table lists. See the comment
  // on UNITS.scout in js/core.js.
  'scout.speed': 'Feudal-gated scout carries the AoE2 Feudal speed bonus (1.2+0.35)',
};

function splitCsvLine(line) {
  const cells = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}
function parseCsv(text) {
  const rows = [];
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue;
    // columns: Icon,Name,Age,HP,Att.,Att. Type,Reload,M.Arm,P.Arm,LOS,R,Acc.,Sp.,Tr.Time,Cost,Bonuses
    const c = splitCsvLine(line);
    if (c.length < 15) continue;
    rows.push({
      name: c[1].trim(), hp: +c[3], att: +c[4], attType: c[5].trim(),
      reload: parseFloat(c[6]), mArm: +c[7], pArm: +c[8],
      range: +c[10], speed: parseFloat(c[12]), trTime: parseFloat(c[13]),
      cost: parseCost(c[14]),
    });
  }
  return rows;
}
function parseCost(s) {
  const out = {};
  for (const m of (s || '').matchAll(/(\d+)\s*([FWGS])/gi)) out[m[2].toUpperCase()] = +m[1];
  return out;
}

const core = loadCore();
const { UNITS, TPS } = core;
const toSec = (ticks) => ticks / TPS;
const OUR_COST_KEYS = { f: 'F', w: 'W', g: 'G', s: 'S' };

const csv = parseCsv(fs.readFileSync(path.join(ROOT, 'docs/reference/unit_stats_aoc.csv'), 'utf8'));
const byName = Object.fromEntries(csv.map((r) => [r.name, r]));
const showAll = process.argv.includes('all');

let mismatches = 0, whitelisted = 0;
const report = [];
for (const [ours, refName] of Object.entries(UNIT_MAP)) {
  const u = UNITS[ours], ref = byName[refName];
  if (!u || !ref) { report.push(`  ?? ${ours} -> ${refName}: ${!u ? 'missing in UNITS' : 'missing in CSV'}`); continue; }
  const checks = [
    ['hp', u.hp, ref.hp],
    ['atk', u.atk, ref.att],
    ['reload_s', +toSec(u.rof || 0).toFixed(2), ref.reload],
    ['melee_armor', (u.armor && u.armor.m) || 0, ref.mArm],
    ['pierce_armor', (u.armor && u.armor.p) || 0, ref.pArm],
    ['range', u.range || 0, ref.range],
    ['speed', u.speed || 0, ref.speed],
    ['train_s', +toSec(u.trainTime || 0).toFixed(1), ref.trTime],
  ];
  for (const [K, otherK] of Object.entries(OUR_COST_KEYS)) {
    checks.push([`cost_${otherK}`, (u.cost && u.cost[K]) || 0, ref.cost[otherK] || 0]);
  }
  for (const [field, oursV, refV] of checks) {
    if (Number.isNaN(refV)) continue; // '-' columns
    if (oursV === refV) continue;
    const key = `${ours}.${field}`;
    if (DELIBERATE[key]) {
      whitelisted++;
      if (showAll) report.push(`  ok(deliberate) ${key}: ours=${oursV} aoc=${refV} — ${DELIBERATE[key]}`);
      continue;
    }
    mismatches++;
    report.push(`  DIFF ${key}: ours=${oursV} aoc=${refV}`);
  }
}

console.log(`stats-audit: ${Object.keys(UNIT_MAP).length} units vs unit_stats_aoc.csv — ${mismatches} unexplained diff(s), ${whitelisted} deliberate`);
for (const l of report) console.log(l);
process.exit(0); // informational, never gates
