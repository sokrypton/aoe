#!/usr/bin/env node
// ---- Headless self-play simulator (Playwright driver) ----
// Loads tools/sim.html in a real headless browser, calls window.runSimulation
// and reads the returned report object directly — no DOM scraping, live JS
// error capture, honest wall-clock timing (the old Chrome --dump-dom +
// --virtual-time-budget approach froze performance.now() and swallowed
// crashes into a blank page).
//
//   node tools/simulate.js                          # 1v1 standard, 60k ticks
//   node tools/simulate.js mode=2v2 diff=hard ticks=120000 seed=42
//   node tools/simulate.js rollback=1 | jq '.health.rollbackDeterministic'
//   node tools/simulate.js runs=5 mode=1v1          # 5 seeds, aggregated
//
// Args are key=value (order-independent):
//   mode=1v1|2v2   diff=easy|standard|hard (or comma list: easy,hard)
//   map=small|medium|large   ticks=N   seed=N   rollback=1
//   runs=N         run N matches (seed varied per run) and print a summary
//   timeout=MS     per-match evaluate timeout (default scales with ticks)
//   headed=1       show the browser window (debugging)
//
// Exit codes: 0 clean · 1 findings/JS errors observed · 2 harness failure.

const http = require('http');
const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run:  (cd tools && npm install)');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = a.match(/^([\w-]+)=(.*)$/);
    if (m) o[m[1]] = m[2];
    else console.error(`ignoring unrecognized arg: ${a}`);
  }
  return o;
}

// Minimal static server rooted at the repo (serves the JS the page imports).
// Path traversal is blocked; listens on an ephemeral port so parallel runs
// never collide.
function startServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/') rel = '/tools/sim.html';
      const fp = path.join(ROOT, rel);
      if (!fp.startsWith(ROOT + path.sep) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(res);
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// Prefer the system Chrome (no browser download), fall back to a bundled
// chromium if one was installed via `npx playwright install`.
async function launchBrowser(headed) {
  const attempts = [{ channel: 'chrome' }, { channel: 'chromium' }, {}];
  let lastErr;
  for (const opts of attempts) {
    try { return await chromium.launch({ headless: !headed, ...opts }); }
    catch (e) { lastErr = e; }
  }
  throw new Error('could not launch a browser (install Chrome, or: cd tools && npx playwright install chromium)\n' + lastErr.message);
}

async function runOne(browser, base, cfg, timeoutMs) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e.message || e)));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // Browser resource-load noise (favicon, an optional asset) is not a sim
    // error — only real uncaught exceptions (pageerror) and app-level
    // console.error should count.
    if (/Failed to load resource|favicon\.ico/i.test(t)) return;
    pageErrors.push('console.error: ' + t);
  });
  try {
    await page.goto(base + '/tools/sim.html', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.runSimulation === 'function', { timeout: 15000 });
    const report = await page.evaluate(c => window.runSimulation(c), cfg);
    // Fold in any errors the driver saw that the in-page listener missed.
    report.health.jsErrors = report.health.jsErrors || [];
    for (const e of pageErrors)
      if (!report.health.jsErrors.includes(e)) report.health.jsErrors.push(e);
    return report;
  } finally {
    await page.close().catch(() => {});
  }
}

// Group findings across a batch by shape (numbers → N) so near-identical
// findings from different seeds collapse into one count.
function aggregate(reports) {
  const findingCounts = {};
  const winners = {};
  for (const r of reports) {
    for (const f of r.findings || []) {
      const k = f.replace(/\d+/g, 'N');
      findingCounts[k] = (findingCounts[k] || 0) + 1;
    }
    const w = r.end.gameOver ? (r.end.won ? 'team0-side' : 'other-side') : 'unresolved';
    winners[w] = (winners[w] || 0) + 1;
  }
  const tps = reports.map(r => r.health.ticksPerSec).filter(x => x != null);
  return {
    batch: { runs: reports.length, config: { ...reports[0].config, seed: undefined } },
    winners,
    findingsAcrossRuns: findingCounts,
    avgTicksPerSec: tps.length ? Math.round(tps.reduce((a, b) => a + b, 0) / tps.length) : null,
    anyErrors: reports.some(r => (r.health.jsErrors || []).length > 0),
    runs: reports.map(r => ({
      seed: r.config.seed, tick: r.end.tick, gameOver: r.end.gameOver, won: r.end.won,
      ages: r.end.ages, checksum: r.end.checksum, ticksPerSec: r.health.ticksPerSec,
      findings: r.findings, jsErrors: r.health.jsErrors,
    })),
  };
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  const runs = Math.max(1, parseInt(a.runs || '1', 10));
  const ticks = parseInt(a.ticks || '60000', 10);
  const baseCfg = {
    mode: a.mode || '1v1',
    diff: a.diff || 'standard',
    map: a.map || undefined,
    ticks,
    seed: a.seed != null ? parseInt(a.seed, 10) : null,
    rollback: a.rollback === '1',
    bears: a.bears, // 'bears=0' disables wild bears (isolate eco/wave behavior from fauna losses)
  };
  // Generous evaluate timeout: the sim yields between batches, so this only
  // caps a genuinely wedged run. Scales with the tick budget.
  const timeoutMs = parseInt(a.timeout || String(Math.max(60000, ticks * 3)), 10);

  let srv, browser;
  const cleanup = () => {
    if (browser) browser.close().catch(() => {});
    if (srv) srv.close();
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  try {
    srv = await startServer();
    const base = 'http://127.0.0.1:' + srv.address().port;
    browser = await launchBrowser(a.headed === '1');
    browser.on('disconnected', () => { srv && srv.close(); });

    if (runs === 1) {
      const rep = await runOne(browser, base, baseCfg, timeoutMs);
      process.stdout.write(JSON.stringify(rep, null, 1) + '\n');
      process.exitCode = (rep.health.jsErrors || []).length ? 1 : 0;
    } else {
      const reports = [];
      const base0 = baseCfg.seed != null ? baseCfg.seed : 1;
      for (let i = 0; i < runs; i++) {
        const rep = await runOne(browser, base, { ...baseCfg, seed: base0 + i * 1000 }, timeoutMs);
        reports.push(rep);
        process.stderr.write(`run ${i + 1}/${runs} (seed ${base0 + i * 1000}): ` +
          `${rep.end.gameOver ? (rep.end.won ? 'team0 side won' : 'other side won') : 'unresolved'}` +
          `, ${rep.findings.length} finding(s)\n`);
      }
      process.stdout.write(JSON.stringify(aggregate(reports), null, 1) + '\n');
      process.exitCode = reports.some(r => (r.health.jsErrors || []).length) ? 1 : 0;
    }
  } catch (err) {
    console.error('SIM HARNESS ERROR: ' + (err && err.stack || err));
    process.exitCode = 2;
  } finally {
    cleanup();
  }
})();
