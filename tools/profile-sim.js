#!/usr/bin/env node
// V8 sampling profile of a headless sim run. Run from repo root:
//   node <scratchpad>/profile-sim.js [seed=42] [ticks=30000] [mode=2v2] [map=large]
const path = require('path');
const REPO = process.cwd();
const { requireChromium, parseArgs, startServer, launchBrowser } = require(path.join(REPO, 'tools/lib/harness'));
const chromium = requireChromium();

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cfg = { seed: args.seed || '42', ticks: args.ticks || '30000', mode: args.mode || '2v2', map: args.map || 'large', diff: 'hard' };
  const srv = await startServer('/tools/sim.html');
  const port = srv.address().port;
  const browser = await launchBrowser(chromium, false);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/tools/sim.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof runSimulation === 'function');

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await page.evaluate(c => window.runSimulation(c), cfg);
  const { profile } = await cdp.send('Profiler.stop');

  // self-time per function = hitCount aggregated by functionName+url
  const byFn = new Map();
  let total = 0;
  for (const n of profile.nodes) {
    const hits = n.hitCount || 0;
    if (!hits) continue;
    total += hits;
    const f = n.callFrame;
    const key = (f.functionName || '(anon)') + '  ' + (f.url || '').split('/').pop() + ':' + (f.lineNumber + 1);
    byFn.set(key, (byFn.get(key) || 0) + hits);
  }
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`total samples: ${total}`);
  for (const [k, v] of top) console.log((100 * v / total).toFixed(1).padStart(5) + '%  ' + k);
  await browser.close(); srv.close();
})();
