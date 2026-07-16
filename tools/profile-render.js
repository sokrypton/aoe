#!/usr/bin/env node
// ---- Render profiler (Playwright driver) ----
// Loads tools/sim.html, builds a DENSE viewport (forest + buildings + a big
// army, many units occluded + a selection), times render() over N frames, and
// breaks the cost down per component by stubbing each to a no-op and diffing
// against the full baseline (diffs are approximate — components interact, e.g.
// stubbing drawUnit also empties the behind-occluder ring shapes).
//
//   node tools/profile-render.js                 # zoom 1 + 2, default density
//   node tools/profile-render.js frames=300 zoom=2
//
// Reports ms/frame full + per-component, plus scene counts (units/occluded/
// active-occluders/trees/buildings). No assertions — a measurement tool.

const { ROOT, requireChromium, parseArgs, startServer, launchBrowser } = require('./lib/harness');
const chromium = requireChromium();

const SCENE = (frames) => `(() => {
  // ---- dense stage ----
  NUM_TEAMS = 4; window.__pendingMatchSeed = 7;
  setMapSize('large'); restartGame('standard');
  gameStarted = true; gamePaused = true;
  window.playSound = ()=>{}; window.showMsg = ()=>{}; window.updateUI = ()=>{};
  entities.length = 0; entitiesById.clear(); selected.length = 0; corpses.length = 0;
  for (let y=0;y<MAP;y++) for (let x=0;x<MAP;x++){ let t=map[y][x]; t.occupied=null; t.res=0; t.t=TERRAIN.GRASS; markMapDirty(x,y); }
  window.fogDisabled=true; updateFog(); // BEFORE canPlace — it fog-gates placement (tileHiddenForTeam)

  const CX=60, CY=60;                       // scene center
  // Forest: a 16x16 block (256 trees) offset down-right of center.
  for (let y=CY;y<CY+16;y++) for (let x=CX;x<CX+16;x++){ map[y][x].t=TERRAIN.FOREST; map[y][x].res=100; markMapDirty(x,y); }
  // Buildings: a scattered ring around the center (complete).
  const BT=['TC','BARRACKS','HOUSE','HOUSE','TOWER','MILL','HOUSE','BARRACKS'];
  let nb=0;
  for (let i=0;i<18;i++){
    let bx=CX-24+((i*7)%40), by=CY-24+((i*5)%40);
    if (canPlace(BT[i%BT.length], bx, by, i%4, true)){ let b=createBuilding(BT[i%BT.length],bx,by,i%4); b.complete=true; nb++; }
  }
  // Army: units spread across the region, MANY positioned up-left of the forest
  // (behind it) so the behind-occluder pass is genuinely exercised.
  const U=['militia','spearman','archer','scout','villager'];
  let nu=0;
  for (let i=0;i<200;i++){
    let ux=CX-20+((i*13)%50), uy=CY-20+((i*11)%50);
    let u=createUnit(U[i%U.length], ux+0.3, uy+0.3, i%4);
    if(u){ u.dir=i%8; nu++; }
  }
  selected.length=0;                        // a 24-unit selection (selection-outline cost)
  entities.filter(e=>e.type==='unit').slice(0,24).forEach(e=>selected.push(e));
  updateFog();
  tick=40;
  let iso=toIso(CX+4, CY+4); camX=iso.ix; camY=iso.iy; window.targetCamX=camX; window.targetCamY=camY;

  const N=${frames};
  const time=(fn)=>{ for(let i=0;i<8;i++) render(); let t0=performance.now(); for(let i=0;i<N;i++) fn(); return (performance.now()-t0)/N; };
  const stubDiff=(name, full)=>{
    if(typeof window[name]!=='function' && typeof eval(name)!=='function') return null;
    let orig=eval(name); let ms;
    try { eval(name+'=function(){}'); ms=time(render); } finally { eval(name+'=orig'); }
    return +(full-ms).toFixed(3);
  };

  let full=time(render);
  render(); // one more so the group counters reflect a real frame
  let occluded=0, activeSet=new Set();
  try{ _bsilGroups.forEach(g=>{ occluded+=g.infos.length; g.occIdx.forEach(j=>activeSet.add(j)); }); }catch(e){}
  let groups=0; try{ groups=_bsilGroups.size; }catch(e){}

  return {
    zoom: ZOOM, frames: N,
    scene: { units: nu, buildings: nb, trees: 256, selected: selected.length, occludedUnits: occluded, activeOccluders: activeSet.size, outlineGroups: groups },
    msPerFrame: +full.toFixed(3),
    breakdown: {
      behindOccluderOutlines: stubDiff('drawBehindBuildingOutlines', full),
      selectionOutlines: stubDiff('drawOutlines', full),
      trees: stubDiff('drawTreeEntity', full),
      units: stubDiff('drawUnit', full),
      buildings: stubDiff('drawBuilding', full),
      terrainTile: stubDiff('drawTile', full),
    },
  };
})()`;

(async () => {
  const a = parseArgs(process.argv.slice(2));
  const frames = parseInt(a.frames || '200', 10);
  const zooms = a.zoom ? [parseFloat(a.zoom)] : [1, 2];
  const srv = await startServer('/tools/sim.html');
  const port = srv.address().port;
  const browser = await launchBrowser(chromium, false);
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('http://127.0.0.1:' + port + '/tools/sim.html', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof render === 'function', { timeout: 15000 });
    for (const z of zooms) {
      const r = await page.evaluate('ZOOM=' + z + ';\n' + SCENE(frames));
      console.log(JSON.stringify(r, null, 2));
    }
  } finally {
    await browser.close(); srv.close();
  }
})();
