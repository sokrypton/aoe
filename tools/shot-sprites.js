// Sprite-sheet PREVIEW: load index.html (runs page-shell.js → generated
// .icon-* / .icon-up-* CSS), inject a labeled grid of every full cell + upgrade
// sub-cell, screenshot to /tmp/sprite-grid.png. Handy while drawing art into the
// labeled placeholder slots (rerun to see each cell/quarter as it renders in-HUD).
//   node tools/shot-sprites.js
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png' };
(async () => {
  const server = http.createServer((req, res) => {
    let p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    if (p.endsWith('/')) p += 'index.html';
    fs.readFile(p, (e, buf) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, {'Content-Type': MIME[path.extname(p)] || 'application/octet-stream'}); res.end(buf); } });
  }).listen(0);
  const port = server.address().port;
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.SPRITE_CELLS && document.getElementById('sprite-cells'));
  await page.evaluate(() => {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#222;overflow:auto;display:flex;flex-wrap:wrap;align-content:flex-start;gap:4px;padding:8px;';
    for (const k in window.SPRITE_CELLS) {
      const c = document.createElement('div');
      c.style.cssText = 'width:52px;height:66px;display:flex;flex-direction:column;align-items:center;font:8px sans-serif;color:#fea;';
      c.innerHTML = `<div class="sprite-icon icon-${k}" style="width:52px;height:52px;background-color:#111;"></div><div>${k}</div>`;
      o.appendChild(c);
    }
    document.body.appendChild(o);
  });
  await page.screenshot({ path: '/tmp/sprite-grid.png' });
  await browser.close(); server.close();
  console.log('wrote /tmp/sprite-grid.png');
})();
