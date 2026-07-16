// Shared bootstrap for the Playwright-driven tools (screenshot.js,
// screenshot-hud.js, hud-tests.js): static file server over the repo,
// browser launch with system-Chrome fallbacks, and arg parsing. Was three
// identical copies — one change here serves every harness.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};

function requireChromium() {
  try {
    return require('playwright-core').chromium;
  } catch {
    console.error('playwright-core is not installed. Run:  (cd tools && npm install)');
    process.exit(2);
  }
}

function parseArgs(argv) {
  const o = {};
  for (const a of argv) {
    const m = a.match(/^([\w-]+)=(.*)$/);
    if (m) o[m[1]] = m[2];
    else console.error(`ignoring unrecognized arg: ${a}`);
  }
  return o;
}

// Serves the repo root; `/` resolves to defaultPath (e.g. '/index.html' or
// '/tools/sim.html').
function startServer(defaultPath) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/') rel = defaultPath;
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

async function launchBrowser(chromium, headed) {
  const attempts = [{ channel: 'chrome' }, { channel: 'chromium' }, {}];
  let lastErr;
  for (const opts of attempts) {
    try { return await chromium.launch({ headless: !headed, ...opts }); }
    catch (e) { lastErr = e; }
  }
  throw new Error('could not launch a browser (install Chrome, or: cd tools && npx playwright install chromium)\n' + lastErr.message);
}

module.exports = { ROOT, MIME, requireChromium, parseArgs, startServer, launchBrowser };
