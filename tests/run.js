// `npm test` entry point: serves the repo on the port helpers.js expects
// (8471), runs every suite in tests/ sequentially, and exits non-zero if any
// fails. No dependencies beyond node + the playwright package the suites
// already use. AOE_URL still overrides the target (see helpers.js) if you
// want to point the suites at an already-running server instead.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8471;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

const SUITES = ['sp-garrison.js', 'sp-determinism.js', 'mp-menus.js', 'mp-sync.js', 'mp-features.js', 'mp-recovery.js', 'mp-audio.js', 'mp-lockstep.js'];

const server = http.createServer((req, res) => {
  let file = path.normalize(decodeURIComponent(req.url.split('?')[0]));
  if (file === '/' || file === '\\') file = '/index.html';
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
});

// spawn (async), NOT spawnSync: spawnSync blocks the event loop, which
// would freeze this same process's HTTP server and time out every suite.
function runSuite(suite){
  return new Promise(resolve => {
    console.log('\n=== ' + suite + ' ===');
    spawn(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' })
      .on('close', code => resolve(code === 0));
  });
}

server.listen(PORT, '127.0.0.1', async () => {
  let failures = 0;
  for (const suite of SUITES) {
    if (!await runSuite(suite)) failures++;
  }
  server.close();
  console.log('\n' + (failures ? failures + ' SUITE(S) FAILED' : 'ALL SUITES PASSED'));
  process.exit(failures ? 1 : 0);
});
server.on('error', (err) => {
  console.error('Could not bind 127.0.0.1:' + PORT + ' (' + err.code + ') — is another server already running?');
  process.exit(1);
});
