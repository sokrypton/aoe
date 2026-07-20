// Pose-matrix capture for the unit renderer: screenshots style.html across
// pose (idle/walk/attack) × age (dark/feudal/castle) × scroll bands so every
// soldier/villager direction row is on file, plus a __poseTraceDump() JSON
// (present once the pose rig lands; null before) recording per unit×dir the
// derived arm choice, grip anchor and part draw order.
//   node tools/shot-poses.js out=tools/shots/pose-baseline
const fs = require('fs');
const path = require('path');
const { ROOT, requireChromium, parseArgs, startServer, launchBrowser } = require('./lib/harness');

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.join(ROOT, args.out || 'tools/shots/pose-capture');
  fs.mkdirSync(outDir, { recursive: true });
  const chromium = requireChromium();
  const srv = await startServer('/style.html');
  const browser = await launchBrowser(chromium);
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`http://127.0.0.1:${srv.address().port}/style.html`);
  await page.waitForTimeout(1500);

  const POSES = ['idle', 'walk', 'attack'];
  for (const age of [0, 1, 2]) {
    await page.click(`button[data-age="${age}"]`);
    for (const pose of POSES) {
      await page.click(`button[data-pose="${pose}"]`);
      // soldiers: three scroll bands cover every unit row + tech ladders
      await page.click('button[data-jump="soldiers"]');
      await page.waitForTimeout(450);
      for (let band = 0; band < 3; band++) {
        if (band) { await page.mouse.wheel(0, 700); await page.waitForTimeout(350); }
        await page.screenshot({ path: path.join(outDir, `a${age}-${pose}-s${band}.png`) });
      }
      // villagers band (arms/tools matrix)
      await page.click('button[data-jump="villagers"]');
      await page.waitForTimeout(350);
      await page.screenshot({ path: path.join(outDir, `a${age}-${pose}-vil.png`) });
    }
  }

  const trace = await page.evaluate(() =>
    (typeof window.__poseTraceDump === 'function') ? window.__poseTraceDump() : null);
  fs.writeFileSync(path.join(outDir, 'pose-trace.json'), JSON.stringify(trace, null, 1));

  await browser.close();
  srv.close();
  console.log('captured to', outDir);
})().catch(e => { console.error(e); process.exit(1); });
