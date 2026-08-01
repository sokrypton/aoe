#!/usr/bin/env node
// ---- Free-variable check for extract-a-function refactors ----
// Lists identifiers a line range READS but does not declare, split into
// "globals (fine)" and "enclosing-scope locals (must be passed or recomputed)".
// The second list is the one that breaks an extraction — see the sheep block,
// which closed over drawUnit's `tc` and threw ReferenceError only at runtime.
//
//   node tools/free-vars.js js/ui.js 949 1658
//
// HEURISTIC, not a parser (no acorn in tools/node_modules): it strips comments,
// strings, property accesses and object keys, then diffs identifiers against
// declarations found in the range and top-level declarations across js/*.js.
// Treat the output as a checklist to eyeball, not proof — but it turns a
// runtime surprise into a pre-flight read.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const KEYWORDS = new Set(('let const var function if else return for while new this true false null undefined typeof of in ' +
  'break continue switch case default do try catch finally throw instanceof delete void class extends yield async await ' +
  'arguments super static get set').split(' '));
const BUILTINS = new Set(('Math JSON Object Array Set Map String Number Boolean Date RegExp Promise Error Infinity NaN ' +
  'parseInt parseFloat isNaN isFinite window document console performance requestAnimationFrame setTimeout setInterval ' +
  'clearTimeout clearInterval localStorage navigator location Image Audio Uint8Array Float64Array Int32Array Symbol ' +
  'encodeURIComponent decodeURIComponent structuredClone globalThis').split(' '));

const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
  .replace(/`(?:[^`\\]|\\.)*`/g, '""')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, '""')
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

// identifiers, minus property accesses (.foo) and object literal keys (foo:)
function idents(code) {
  const out = new Set();
  const noProp = code.replace(/\.\s*([A-Za-z_$][\w$]*)/g, '.').replace(/([A-Za-z_$][\w$]*)\s*:/g, ':');
  for (const m of noProp.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
  return out;
}

// Binding names only. Capturing the INITIALIZER too is the subtle failure that
// makes this tool lie: `let crestIdx = myAgeUpBldg ? ...` would mark
// myAgeUpBldg as declared, hiding the very free variable being hunted.
function declArators(list) {
  const names = [];
  let depth = 0, buf = '';
  for (const c of list) {
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { names.push(buf); buf = ''; continue; }
    buf += c;
  }
  names.push(buf);
  // left of the first '=' is the binding pattern; the rest is an expression
  return names.flatMap(n => [...n.split('=')[0].matchAll(/[A-Za-z_$][\w$]*/g)].map(m => m[0]));
}

function declared(code) {
  const out = new Set();
  const re = /\b(?:let|const|var)\s+/g;
  let m;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length, depth = 0;
    while (i < code.length && !(code[i] === ';' && depth === 0)) {
      if ('([{'.includes(code[i])) depth++;
      else if (')]}'.includes(code[i])) { if (depth === 0) break; depth--; }
      i++;
    }
    for (const n of declArators(code.slice(m.index + m[0].length, i))) out.add(n);
  }
  for (const m of code.matchAll(/\bfunction\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/g)) {
    if (m[1]) out.add(m[1]);
    for (const nm of (m[2] || '').matchAll(/[A-Za-z_$][\w$]*/g)) out.add(nm[0]);
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g))
    for (const nm of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) out.add(nm[0]);
  for (const m of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/gm)) out.add(m[1]);
  for (const m of code.matchAll(/\bfor\s*\(\s*(?:let|const|var)?\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  return out;
}

// top-level declarations across the shipped sources = the global surface
function globals() {
  const out = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(f => f.endsWith('.js'))) {
    const s = strip(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'));
    for (const m of s.matchAll(/^(?:function|const|let|var)\s+([^;=\n(]+)/gm))
      for (const nm of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) out.add(nm[0]);
  }
  return out;
}

const [file, from, to] = [process.argv[2], +process.argv[3], +process.argv[4]];
if (!file || !from || !to) { console.error('usage: node tools/free-vars.js <file> <fromLine> <toLine>'); process.exit(2); }

const lines = fs.readFileSync(file, 'utf8').split('\n');
const range = strip(lines.slice(from - 1, to).join('\n'));
const enclosing = strip(lines.join('\n'));   // whole file: everything the range could close over

const used = idents(range);
const localDecls = declared(range);
const fileDecls = declared(enclosing);
const glob = globals();

const free = [...used].filter(n => !localDecls.has(n) && !KEYWORDS.has(n) && !BUILTINS.has(n)).sort();
const fromGlobal = free.filter(n => glob.has(n));
const fromEnclosing = free.filter(n => !glob.has(n) && fileDecls.has(n));
const unknown = free.filter(n => !glob.has(n) && !fileDecls.has(n));

console.log(`range ${file}:${from}-${to}  (${to - from + 1} lines)\n`);
console.log(`MUST HANDLE — enclosing-scope locals (${fromEnclosing.length}):\n  ${fromEnclosing.join(', ') || '(none)'}\n`);
console.log(`globals, fine (${fromGlobal.length}):\n  ${fromGlobal.join(', ') || '(none)'}\n`);
console.log(`unresolved — likely properties/params the heuristic missed (${unknown.length}):\n  ${unknown.join(', ') || '(none)'}`);
