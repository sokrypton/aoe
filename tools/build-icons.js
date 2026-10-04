// Rebuild sprites.png from the icon studio (icons.html): every recipe there is rendered from the game's 3D models into
// its SPRITE_CELLS cell; cells without a recipe (UI chrome: back, cancel, scroll caps, …) keep the sheet's current art.
//   node tools/build-icons.js            → sprites.png (then optimized: Pillow, if python3 has it)
//   node tools/build-icons.js out.png    → elsewhere
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const { ROOT, requireChromium, startServer, launchBrowser } = require('./lib/harness');
const out = path.resolve(process.argv[2] || path.join(ROOT, 'sprites.png'));
(async () => {
  const srv = await startServer('/icons.html'), b = await launchBrowser(requireChromium(), false);
  const p = await (await b.newContext()).newPage(), errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${srv.address().port}/icons.html`);
  await p.waitForFunction(() => window.__iconsReady, null, { timeout: 300000 });
  const res = await p.evaluate(async () => {
    const sheet = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = bad; im.src = 'sprites.png?' + Date.now(); });
    const C = sheet.width / 8, c = document.createElement('canvas'); c.width = sheet.width; c.height = sheet.height;
    const x = c.getContext('2d'); x.drawImage(sheet, 0, 0); const done = [];
    for (const k of window.__iconKeys()) { const cell = window.SPRITE_CELLS[k]; if (!cell) continue;
      const im = await new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.src = window.__icon(k); });
      x.clearRect(cell[0] * C, cell[1] * C, C, C); x.drawImage(im, cell[0] * C, cell[1] * C, C, C); done.push(k); }
    return { png: c.toDataURL('image/png'), done };
  });
  fs.writeFileSync(out, Buffer.from(res.png.split(',')[1], 'base64'));
  console.log(`${res.done.length} cells rendered → ${path.relative(ROOT, out)}`, errs.length ? errs : '');
  await b.close(); srv.close();
  // smaller file, same pixels: Pillow's zlib at max effort (lossless)
  try { execFileSync('python3', ['-c', `from PIL import Image; im = Image.open(${JSON.stringify(out)}); im.load(); im.save(${JSON.stringify(out)}, optimize=True, compress_level=9)`]);
    console.log('optimized:', fs.statSync(out).size, 'bytes'); } catch (e) { console.log('(not optimized: python3 + Pillow needed)'); }
})();
