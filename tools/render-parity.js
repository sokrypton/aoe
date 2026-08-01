#!/usr/bin/env node
// ---- Render parity probe ----
// Loads a SAVE, renders it at several zooms and hashes the canvas pixels.
// With baseline=<git-ref> it renders the same save in a throwaway worktree at
// that ref and diffs the hashes — the check that a viewer-side refactor moved
// no pixels. Exits non-zero on mismatch, so it drives a refactor loop:
// extract one piece of art, re-run, require IDENTICAL.
//
//   node tools/render-parity.js save=my.json                 # print hashes
//   node tools/render-parity.js save=my.json baseline=HEAD   # compare vs HEAD
//   node tools/render-parity.js save=my.json zooms=0.5,1     # pick zooms
//
// Two things must be pinned or the SAME tree hashes differently every run
// (both cost real debugging time to find, hence addInitScript, not page.evaluate
// — by evaluate time gameLoop has already rendered a timing-dependent number of
// frames, each mutating anim/FX state):
//   - the rAF gameLoop keeps rendering between calls  -> stub requestAnimationFrame
//   - cosmetic FX (particles, smoke) are deliberately random -> seed Math.random
// Corpses are cleared each frame: their fade rides performance.now(), which no
// amount of seeding pins down.
//
// Sim-neutral by construction (render is viewer-only) — for SIM equivalence use
// tools/simulate.sh checksums instead.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { ROOT, requireChromium, parseArgs, launchBrowser } = require('./lib/harness');
const chromium = requireChromium();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };

// Own static server (not harness.startServer, which is pinned to ROOT) so a
// baseline worktree can be served without needing its own node_modules.
function serve(root) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/') rel = '/index.html';
      const fp = path.join(root, rel);
      if (!fp.startsWith(root + path.sep) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const PROBE = (zooms) => `(() => {
  const out = [];
  for (const z of [${zooms}]) {
    ZOOM = z; tick = 5000;
    // Warm the lazy art caches (tree bodies, building silhouettes) and settle
    // the outline layer's every-other-frame parity before the hashed frame.
    for (let w = 0; w < 4; w++) { corpses.length = 0; render(); }
    corpses.length = 0;
    render();
    const d = X.getImageData(0, 0, X.canvas.width, X.canvas.height).data;
    let h = 2166136261 >>> 0;                      // FNV-1a over the pixel buffer
    for (let i = 0; i < d.length; i += 4) {
      h ^= d[i] | (d[i+1] << 8) | (d[i+2] << 16) | (d[i+3] << 24);
      h = Math.imul(h, 16777619) >>> 0;
    }
    out.push(z + ':' + h.toString(16));
  }
  return out;
})()`;

// Gallery mode: style.html stages EVERY unit type in all 8 facings across
// idle/walk/attack/death, plus tech ladders and villager task/carry rows —
// the coverage a drawUnit refactor actually needs (any one save is missing
// whole unit types). Driven through window.GALLERY so frame count, tick and
// scroll are exact rather than rAF-timed.
const POSES = ['idle', 'walk', 'attack', 'death'];
const SCROLL_STEP = 400, SCROLL_STEPS = 14;   // overshoot is blank frames, which are harmless

async function hashGallery(browser, root) {
  const srv = await serve(root);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => {
      window.requestAnimationFrame = () => 0;   // GALLERY.frame() is the only driver
      let s = 12345;
      Math.random = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      // Death/corpse art ages off the WALL CLOCK (render-units.js dying-unit
      // dt, drawCorpse age, and style-gallery's own corpse-cycle math), so a
      // frozen clock is what makes the death pose comparable at all.
      performance.now = () => 100000;
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message || e).slice(0, 200)));
    await page.goto('http://127.0.0.1:' + srv.address().port + '/style.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.GALLERY, { timeout: 20000 })
      .catch(() => { throw new Error('window.GALLERY missing' + (errs.length ? ' — ' + errs[0] : '')); });
    const out = await page.evaluate(`(() => {
      const out = [];
      for (const pose of ${JSON.stringify(POSES)}) {
        for (let i = 0; i < ${SCROLL_STEPS}; i++) {
          GALLERY.set({ pose, scroll: i * ${SCROLL_STEP}, tick: 5000 });
          GALLERY.frame();
          const d = X.getImageData(0, 0, X.canvas.width, X.canvas.height).data;
          let h = 2166136261 >>> 0;
          for (let k = 0; k < d.length; k += 4) {
            h ^= d[k] | (d[k+1] << 8) | (d[k+2] << 16) | (d[k+3] << 24);
            h = Math.imul(h, 16777619) >>> 0;
          }
          out.push(pose + '@' + (i * ${SCROLL_STEP}) + ':' + h.toString(16));
        }
      }
      return out;
    })()`);
    await ctx.close();
    return out;
  } finally { srv.close(); }
}

async function hashTree(browser, root, saveText, zooms) {
  const srv = await serve(root);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => {
      window.requestAnimationFrame = () => 0;   // halt gameLoop before it ever runs
      let s = 12345;
      Math.random = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e.message || e).slice(0, 200)));
    await page.goto('http://127.0.0.1:' + srv.address().port + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const b = document.getElementById('start-game-btn'); return b && !b.disabled;
    }, { timeout: 20000 });
    await page.evaluate(`window.__save = ${saveText};`);
    const n = await page.evaluate(`(()=>{ loadGame(window.__save); gameStarted=true; gamePaused=true; return entities.length; })()`);
    if (!n) throw new Error('save failed to load (version/TPS mismatch?)' + (errs.length ? ' — ' + errs[0] : ''));
    const out = await page.evaluate(PROBE(zooms));
    await ctx.close();
    return out;
  } finally { srv.close(); }
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  if (!a.save && !a.gallery) {
    console.error('usage: node tools/render-parity.js (save=<file.json> | gallery=1) [baseline=<ref>] [zooms=..]');
    process.exit(2);
  }
  const saveText = a.save ? fs.readFileSync(a.save, 'utf8') : null;
  const zooms = (a.zooms || '0.35,0.61,1,2').split(',').map(Number).join(',');
  const browser = await launchBrowser(chromium, false);
  const probe = (root) => a.gallery ? hashGallery(browser, root) : hashTree(browser, root, saveText, zooms);
  let wt = null;
  try {
    const cur = await probe(ROOT);
    if (!a.baseline) { console.log(cur.join('\n')); return; }

    wt = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aoe-parity-'));
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, a.baseline], { cwd: ROOT });
    const base = await probe(wt);

    // Only mismatches are worth printing — gallery mode compares ~56 cells.
    const bad = [];
    cur.forEach((h, i) => {
      if (h === base[i]) return;
      bad.push(h.split(':')[0]);
      console.log(`  ${h.split(':')[0].padEnd(16)} ${a.baseline} ${base[i].split(':')[1]}  ->  working ${h.split(':')[1]}`);
    });
    console.log(bad.length
      ? `\nFAIL — ${bad.length}/${cur.length} differ vs ${a.baseline}`
      : `\nPASS — pixel-identical vs ${a.baseline} (${cur.length} probes)`);
    if (bad.length) process.exitCode = 1;
  } finally {
    await browser.close();
    // No symlinks were made into the worktree, so nothing here can follow one
    // back out into the real tree.
    if (wt) { try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: ROOT }); } catch (e) {} }
  }
})();
