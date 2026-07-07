// ---- RENDERING ----

// Offscreen-culling check for a point already in pre-scale/logical screen
// space (before render()'s translate/scale(ZOOM)/translate transform is
// applied). The actual visible logical window grows/shrinks with 1/ZOOM
// (zooming out reveals more world), so the margin must scale with it too —
// a fixed-pixel margin here would wrongly cull tiles/entities that are
// genuinely on screen once zoomed out.
function isOffscreen(sx, sy, margin){
  let halfW = (W/2)/ZOOM + margin;
  let halfH = (H/2)/ZOOM + margin;
  let cy = H/2 + topH;
  return sx < W/2-halfW || sx > W/2+halfW || sy < cy-halfH || sy > cy+halfH;
}

// Returns the effective fog level for a building across its whole footprint:
//   0 = all tiles unexplored (skip drawing)
//   1 = some explored but none currently visible (draw with shadow)
//   2 = at least one tile actively visible (draw normally)
// Memoized per building until the fog actually changes (updateFog in
// js/core.js calls invalidateBuildingFogMemo) — the w×h tile scan used to
// re-run 2-3× per building per FRAME (render collect + draw loops, outline
// extent, minimap), pure waste since fog only mutates once per tick.
let _bflMemo = new Map();
function invalidateBuildingFogMemo(){ _bflMemo.clear(); }
function buildingFogLevel(e) {
  let memo = _bflMemo.get(e.id);
  if (memo !== undefined) return memo;
  let b = BLDGS[e.btype];
  let w = e.w !== undefined ? e.w : (b ? b.w : 1);
  let h = e.h !== undefined ? e.h : (b ? b.h : 1);
  let maxF = 0;
  outer: for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) {
      let tf = (fog[e.y+dy] && fog[e.y+dy][e.x+dx]) || 0;
      if (tf > maxF) maxF = tf;
      if (maxF === 2) break outer;
    }
  _bflMemo.set(e.id, maxF);
  return maxF;
}

function drawTile(x,y){
  let f = fog[y] && fog[y][x];
  if (f === 0) return; // unexplored (completely black)

  let iso=toIso(x,y);
  let sx=Math.round(iso.ix-camX+W/2), sy=Math.round(iso.iy-camY+topH+H/2);
  if(isOffscreen(sx,sy,TW*2))return;
  let t=map[y][x];
  let cols=TCOL[t.t]||TCOL[0];
  let col=cols[(x*7+y*13)%cols.length];

  X.fillStyle=col;
  X.beginPath();
  X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
  X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
  X.closePath();X.fill();
  let cy=sy+HALF_TH;

  // Faceted 3D boulder — a low-poly rock spire with a bright top facet, a
  // lit left face, and a shadowed right face, instead of a flat painted
  // dome. The apex sits well above the ground-contact point so, like the
  // berry bushes, a tall boulder visibly rises past the tile's own edge.
  const boulder=(cx0,cy0,r,cTop,cLeft,cRight)=>{
    let apex={x:cx0,        y:cy0-r*1.7};
    let topL={x:cx0-r*0.85, y:cy0-r*0.85};
    let topR={x:cx0+r*0.8,  y:cy0-r*0.9};
    let midL={x:cx0-r*1.15, y:cy0-r*0.05};
    let midR={x:cx0+r*1.1,  y:cy0-r*0.02};
    let baseL={x:cx0-r*0.65,y:cy0+r*0.4};
    let baseR={x:cx0+r*0.6, y:cy0+r*0.45};
    let baseC={x:cx0,       y:cy0+r*0.55};
    X.strokeStyle='#000';X.lineWidth=1.3;X.lineJoin='round';
    // Left-lit facet
    X.fillStyle=cLeft;X.beginPath();
    X.moveTo(apex.x,apex.y);X.lineTo(topL.x,topL.y);X.lineTo(midL.x,midL.y);X.lineTo(baseL.x,baseL.y);X.lineTo(baseC.x,baseC.y);X.closePath();X.fill();X.stroke();
    // Right-shadow facet
    X.fillStyle=cRight;X.beginPath();
    X.moveTo(apex.x,apex.y);X.lineTo(topR.x,topR.y);X.lineTo(midR.x,midR.y);X.lineTo(baseR.x,baseR.y);X.lineTo(baseC.x,baseC.y);X.closePath();X.fill();X.stroke();
    // Bright highlight sliver at the apex
    X.fillStyle=cTop;X.beginPath();
    X.moveTo(apex.x,apex.y);X.lineTo(topL.x,topL.y);X.lineTo(cx0,cy0-r*0.6);X.lineTo(topR.x,topR.y);X.closePath();X.fill();X.stroke();
  };
  // Rubble left where a mined-out boulder used to stand: a few small
  // faceted-ish pebbles, so depletion reads as "carted away", not "shrunk".
  const rubble=(ox,oy,col,colDark)=>{
    X.strokeStyle='#000';X.lineWidth=1;
    X.fillStyle=col;
    X.beginPath();X.ellipse(ox-2.5,oy,2.4,1.5,0,0,Math.PI*2);X.fill();X.stroke();
    X.beginPath();X.ellipse(ox+2.5,oy+1,1.9,1.2,0,0,Math.PI*2);X.fill();X.stroke();
    X.fillStyle=colDark;
    X.beginPath();X.ellipse(ox+0.5,oy-1.8,1.5,1.0,0,0,Math.PI*2);X.fill();X.stroke();
  };
  if(t.t===TERRAIN.GOLD){
    // Discrete depletion (AoE2 mine damage states): the flanking boulders
    // get mined away one at a time — leaving rubble — and the central spire
    // finally breaks to a stub, instead of the whole cluster scaling down.
    let pct=Math.min(t.res/800,1);
    let gy=cy-8; // centered on the tile — the tall spire's apex pokes into
                 // the tile above, same deliberate overflow as the bushes.
    // Same faceted boulder cluster as stone, just cast in solid gold —
    // reads as "this whole vein is gold" at a glance instead of grey rock
    // with a few small nuggets stuck on.
    if(pct>0.66) boulder(sx-9, gy+5, 6, '#f4d35e', '#d1a017', '#8f6607');
    else rubble(sx-9, gy+7, '#d1a017', '#8f6607');
    if(pct>0.33) boulder(sx+9, gy+5, 5.5, '#f4d35e', '#c99815', '#916d0a');
    else rubble(sx+9, gy+6, '#c99815', '#916d0a');
    boulder(sx, gy+6, pct>0.12?9.5:5.5, '#ffe066', '#e8b90f', '#a8790a'); // broken stub at the end
    // Sparkle glints scattered across the gold facets — small 4-point stars
    // so it unmistakably reads as shiny metal, not just yellow stone.
    // Fewer glints as the vein empties (they sit on the remaining rock).
    const sparkle=(ox,oy,r)=>{
      X.fillStyle='#fff8dc';X.strokeStyle='rgba(120,80,0,0.5)';X.lineWidth=0.6;
      X.beginPath();
      X.moveTo(ox,oy-r);X.lineTo(ox+r*0.28,oy-r*0.28);X.lineTo(ox+r,oy);
      X.lineTo(ox+r*0.28,oy+r*0.28);X.lineTo(ox,oy+r);X.lineTo(ox-r*0.28,oy+r*0.28);
      X.lineTo(ox-r,oy);X.lineTo(ox-r*0.28,oy-r*0.28);X.closePath();
      X.fill();X.stroke();
    };
    let glints=[[sx+1,gy+5,1.3],[sx-1.5,gy-13,2.6],[sx+4.5,gy-6,1.8],[sx-7,gy-2,1.6],[sx+8.5,gy+2,1.4]];
    if(pct<=0.12){glints=[[sx+1,gy+2,1.3]];} // only the stub remains to glint
    else if(pct<=0.33)glints=glints.slice(0,3);
    else if(pct<=0.66)glints=glints.slice(0,4);
    glints.forEach(g=>sparkle(g[0],g[1],g[2]));
  }
  if(t.t===TERRAIN.STONE){
    // Same discrete quarrying states as the gold vein above.
    let pct=Math.min(t.res/350,1);
    let gy=cy-8; // centered on the tile, matching gold — was bottom-heavy
    // Granite cluster: two flanking boulders, one tall central spire
    if(pct>0.66) boulder(sx-9, gy+5, 6, '#b0b0b0', '#8c8c8c', '#686868');
    else rubble(sx-9, gy+7, '#9d9d9d', '#767678');
    if(pct>0.33) boulder(sx+9, gy+5, 5.5, '#b0b0b0', '#95958f', '#6e6e6e');
    else rubble(sx+9, gy+6, '#95958f', '#6e6e6e');
    boulder(sx, gy+6, pct>0.12?9.5:5.5, '#c2c2c2', '#9d9d9d', '#767678'); // broken stub at the end
    // Cracks across the central spire (only while it still stands tall)
    if(pct>0.12){
      X.strokeStyle='rgba(0,0,0,0.45)';X.lineWidth=1;
      X.beginPath();X.moveTo(sx-2,gy-11);X.lineTo(sx-3.5,gy-5);X.lineTo(sx-2,gy-1);X.stroke();
      X.beginPath();X.moveTo(sx+3,gy-8);X.lineTo(sx+4.5,gy-3);X.stroke();
    }
    // Pebbles scattered at the base
    X.strokeStyle='#000';X.lineWidth=1;X.fillStyle='#8b8b8b';
    X.beginPath();X.ellipse(sx-4,gy+7,1.8,1.2,0,0,Math.PI*2);X.fill();X.stroke();
    X.beginPath();X.ellipse(sx+11,gy+6,1.5,1.0,0,0,Math.PI*2);X.fill();X.stroke();
  }
  if(t.t===TERRAIN.BERRIES){
    // Discrete depletion: the bush itself stays FULL SIZE while foragers
    // strip it — berries pop off one by one, then the crown puffs get
    // picked bare (removed) in two steps. Only the number of sub-elements
    // changes, never the scale, so a half-empty bush reads as "picked
    // over", not "smaller bush".
    let pct=Math.min(t.res/125,1);
    let gy=cy+2; // foliage ground line, low on the tile
    // Ground contact shadow so the bush sits ON the tile, not floats
    X.fillStyle='rgba(0,0,0,0.25)';
    X.beginPath();X.ellipse(sx,gy+1.5,10,3,0,0,Math.PI*2);X.fill();
    // Big scalloped foliage cloud rising well past the tile edge — one black
    // silhouette pass, then leaf fills (same one-piece-outline treatment as
    // the unit sprites). Lower puffs darker, crown brighter. The last two
    // puffs are the upper crown: gone below 2/3, then the mid pair below 1/3.
    let puffs=[[-7,-4,5.5],[7,-4,5],[0,-4.5,6.5],[-4,-10.5,5.5],[4.5,-10,5],[0,-14.5,4.5]];
    if(pct<=0.33)puffs=puffs.slice(0,3);
    else if(pct<=0.66)puffs=puffs.slice(0,5);
    X.fillStyle='#000';
    puffs.forEach(p=>{X.beginPath();X.arc(sx+p[0],gy+p[1],p[2]+1.2,0,Math.PI*2);X.fill();});
    puffs.forEach(p=>{
      X.fillStyle=p[1]>-7?'#2a631b':'#3c8a25';
      X.beginPath();X.arc(sx+p[0],gy+p[1],p[2],0,Math.PI*2);X.fill();
    });
    // Sunlit crown (only while the crown puff is still there)
    if(pct>0.66){
      X.fillStyle='rgba(255,255,210,0.20)';
      X.beginPath();X.arc(sx-1,gy-14.5,3.4,0,Math.PI*2);X.fill();
    }
    // Fat red berries with shiny glints, seeded per tile so neighboring
    // bushes don't look like clones. Count tracks remaining food 1:1-ish —
    // this IS the depletion animation, berries visibly popping off.
    let seed=x*7+y*13;
    let berryCount=Math.round(8*pct);
    let berryLift=pct<=0.33?4:0; // picked-low bush: berries sit on the low puffs
    for(let i=0;i<berryCount;i++){
      let a=(seed+i)*2.39996; // golden-angle scatter
      let rr=3.5+((seed+i*3)%4)*1.6;
      let bx=sx+Math.cos(a)*rr*1.6;
      let by=gy-8+berryLift+Math.sin(a)*rr;
      X.fillStyle='#000000';X.beginPath();X.arc(bx,by,3.4,0,Math.PI*2);X.fill(); // berry outline
      X.fillStyle='#cc3344';X.beginPath();X.arc(bx,by,2.6,0,Math.PI*2);X.fill();
      X.fillStyle='#ff99a8';X.beginPath();X.arc(bx-0.7,by-0.7,0.85,0,Math.PI*2);X.fill(); // shiny glint
    }
  }

  // Draw fog of war overlay to darken the tile and its static resources
  if (f === 1) {
    X.fillStyle = 'rgba(0,0,0,0.55)';
    X.beginPath();
    X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
    X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
    X.closePath();
    X.fill();
  }
}

function drawStump(sx, cy, s, darken = false) {
  X.fillStyle = '#000000';
  X.beginPath();
  X.moveTo(sx - 4.5 * s, cy + 2 * s);
  X.lineTo(sx + 4.5 * s, cy + 2 * s);
  X.lineTo(sx + 3.2 * s, cy - 8 * s);
  X.lineTo(sx - 3.2 * s, cy - 8 * s);
  X.closePath(); X.fill();
  
  X.fillStyle = darken ? '#3a1e08' : '#8B4513';
  X.beginPath();
  X.moveTo(sx - 3.5 * s, cy + 2 * s);
  X.lineTo(sx + 3.5 * s, cy + 2 * s);
  X.lineTo(sx + 2.2 * s, cy - 8 * s);
  X.lineTo(sx - 2.2 * s, cy - 8 * s);
  X.closePath(); X.fill();
  
  X.fillStyle = darken ? '#5a3a1b' : '#cd853f';
  X.beginPath();
  X.ellipse(sx, cy - 8 * s, 2.2 * s, 1.0 * s, 0, 0, Math.PI * 2); X.fill();
  X.strokeStyle = '#000000'; X.lineWidth = 1; X.stroke();
}

function drawFullTreeBody(sx, cy, s, darken = false) {
  // A. Trunk Outline (Dark)
  X.fillStyle = '#000000';
  X.beginPath();
  X.moveTo(sx - 3.5 * s, cy + 2 * s);
  X.lineTo(sx + 3.5 * s, cy + 2 * s);
  X.lineTo(sx + 1.5 * s, cy - 22 * s);
  X.lineTo(sx - 1.5 * s, cy - 22 * s);
  X.closePath();
  X.fill();
  
  // B. Trunk Fill (Warm Rich Wood Brown)
  X.fillStyle = darken ? '#3a1e08' : '#8B4513';
  X.beginPath();
  X.moveTo(sx - 2.5 * s, cy + 2 * s);
  X.lineTo(sx + 2.5 * s, cy + 2 * s);
  X.lineTo(sx + 0.8 * s, cy - 22 * s);
  X.lineTo(sx - 0.8 * s, cy - 22 * s);
  X.closePath();
  X.fill();
  
  // C. Puffy Cloud Canopy Circles
  let bubbles = [
    { x: 0, y: -22, r: 12 },    // Main center
    { x: -9, y: -20, r: 9 },     // Left cheek
    { x: 9, y: -20, r: 9 },      // Right cheek
    { x: -5, y: -29, r: 9 },     // Top-left cap
    { x: 5, y: -29, r: 9 }       // Top-right cap
  ];
  
  // 1. Bold Outline Border
  X.fillStyle = '#000000';
  bubbles.forEach(b => {
    X.beginPath();
    X.arc(sx + b.x * s, cy + b.y * s, b.r * s + 1.2, 0, Math.PI * 2);
    X.fill();
  });
  
  // 2. Vibrant Saturated Green Fill
  X.fillStyle = darken ? '#10300a' : '#2e8b1d';
  bubbles.forEach(b => {
    X.beginPath();
    X.arc(sx + b.x * s, cy + b.y * s, b.r * s, 0, Math.PI * 2);
    X.fill();
  });
  
  // 3. Cell-Shaded Mid-Light Highlights
  X.fillStyle = darken ? '#184010' : '#52be3a';
  bubbles.forEach(b => {
    X.beginPath();
    X.arc(sx + (b.x - b.r * 0.15) * s, cy + (b.y - b.r * 0.15) * s, b.r * 0.75 * s, 0, Math.PI * 2);
    X.fill();
  });
  
  // 4. Bright Lime Sunlit Tips (Extra pop)
  X.fillStyle = darken ? '#28551a' : '#99e550';
  bubbles.forEach(b => {
    X.beginPath();
    X.arc(sx + (b.x - b.r * 0.3) * s, cy + (b.y - b.r * 0.3) * s, b.r * 0.35 * s, 0, Math.PI * 2);
    X.fill();
  });
}

function drawTreeEntity(x,y){
  let f = fog[y] && fog[y][x];
  if (f === 0) return; // unexplored (black)

  let iso=toIso(x,y);
  let sx=Math.round(iso.ix-camX+W/2), sy=Math.round(iso.iy-camY+topH+H/2);
  let cy=sy+HALF_TH;
  let t=map[y][x];
  if(!t || t.res<=0) return;

  // 1. Organic height and scale variability
  let sizeNoise = 0.8 + ((x * 17 + y * 23) % 5) * 0.08;
  let s = 1.05 * sizeNoise;
  
  // 2. Dynamic Wind Sway — frozen in shroud (static snapshot when out of sight)
  let totalSway = 0;
  if (f === 2) {
    let windPhase = tick * 0.015 + x * 0.45 + y * 0.35;
    let sway = Math.sin(windPhase) * 0.035;
    let gust = Math.max(0, Math.sin(tick * 0.004 - (x + y) * 0.07) - 0.4) * 0.16;
    totalSway = sway + gust;
  }

  // Initialize fell tick for falling tree animation — treeFellTicks
  // (js/core.js), not a field on the tile itself; see its comment.
  let fellKey = x + ',' + y;
  if(t.res <= 60 && !treeFellTicks.has(fellKey)){
    treeFellTicks.set(fellKey, tick);
  }

  // Calculate fall progress and angle — frozen in shroud (static snapshot)
  let fallAngle = 0;
  let isFalling = false;
  let fellTick = treeFellTicks.get(fellKey);
  if(f === 2 && fellTick !== undefined && fellTick > 0){
    let dt = tick - fellTick;
    if(dt < 40){
      isFalling = true;
      let progress = dt / 40;
      fallAngle = progress * (Math.PI / 2.15); // Fall sideways
    }
  }

  let darken = (f === 1);

  if(t.res > 60 || isFalling){
    // Stage 1: Standing or falling full tree
    X.save();
    X.translate(sx, cy);
    X.rotate(totalSway + fallAngle);
    X.translate(-sx, -cy);
    drawFullTreeBody(sx, cy, s, darken);
    X.restore();
  } else if(t.res > 20){
    // Stage 2: Standing stump AND fallen tree lying on the ground
    drawStump(sx, cy, s, darken);
    X.save();
    X.translate(sx, cy);
    X.rotate(Math.PI / 2.15);
    X.translate(-sx, -cy);
    drawFullTreeBody(sx, cy, s, darken);
    X.restore();
  } else {
    // Stage 3: Standing stump only
    drawStump(sx, cy, s, darken);
  }
}

// ---- MODULAR ISOMETRIC RENDERING HELPERS ----

// Draws a half-length wall slab from a pillar center toward the midpoint with a neighbor.
// sx,sy: start screen pos (pillar center base)
// dx,dy: screen offset to the midpoint (half tile: ±16, ±8)
// wallH: height of the wall slab in pixels
function drawWallLink(sx, sy, dx, dy, wallH, darken=false, d1=5, d2=5, colorL=null, colorTop=null, thick=4, capNear=false, mat='wood') {

  let L = Math.sqrt(dx * dx + dy * dy);
  if (L === 0) return;
  let ux = dx / L, uy = dy / L;

  let nsx = sx + ux * d1;
  let nsy = sy + uy * d1;
  let nex = sx + dx - ux * d2;
  let ney = sy + dy - uy * d2;

  let isAlongIsoY = (dx > 0) !== (dy > 0);
  let px = isAlongIsoY ? thick : -thick;
  let py = thick / 2; // always positive (both perpendiculars have same Y component)

  X.strokeStyle = '#000'; X.lineWidth = 1.3; X.lineJoin = 'round';

  // Default palette by material: palisade wood (Dark age WALL/GATE) or the
  // stone greys (Feudal SWALL/SGATE — the original Stone Wall palette).
  let pal = mat === 'stone'
    ? { a: '#aca392', b: '#cfc8b6', top: '#b7ad97' }
    : { a: WOOD.R, b: WOOD.L, top: WOOD.top }; // shared timber palette (render-buildings.js)
  let fillL = colorL || (isAlongIsoY ? pal.a : pal.b);
  let fillTop = colorTop || pal.top;
  if (darken) {
    fillL = darkenColor(fillL);
    fillTop = darkenColor(fillTop);
  }

  // 1. Visible side face
  X.fillStyle = fillL;
  X.beginPath();
  X.moveTo(nsx + px, nsy + py);
  X.lineTo(nex + px, ney + py);
  X.lineTo(nex + px, ney + py - wallH);
  X.lineTo(nsx + px, nsy + py - wallH);
  X.closePath(); X.fill(); X.stroke();

  // Palisade texture: vertical stake seams across the visible side face,
  // so the wooden wall reads as driven beams rather than a flat slab
  if (mat === 'wood' && !colorL) {
    X.save();
    X.strokeStyle='rgba(0,0,0,0.28)';X.lineWidth=1;
    for (let t of [0.25, 0.5, 0.75]) {
      let vx = nsx + (nex - nsx) * t + px;
      let vy = nsy + (ney - nsy) * t + py;
      X.beginPath();X.moveTo(vx, vy);X.lineTo(vx, vy - wallH);X.stroke();
    }
    X.restore();
  }

  // Stone masonry texture: horizontal course lines with staggered vertical
  // joints (light strokes per the seam-weight convention — hard black is
  // reserved for silhouettes)
  if (mat === 'stone' && !colorL) {
    X.save();
    X.strokeStyle='rgba(0,0,0,0.13)';X.lineWidth=1;
    let courses = 3;
    for (let c = 1; c < courses; c++) {
      let hy = wallH * c / courses;
      X.beginPath();
      X.moveTo(nsx + px, nsy + py - hy);
      X.lineTo(nex + px, ney + py - hy);
      X.stroke();
      // staggered vertical joints on this course band
      let joints = c % 2 ? [0.2, 0.5, 0.8] : [0.35, 0.65];
      for (let t of joints) {
        let vx = nsx + (nex - nsx) * t + px;
        let vy = nsy + (ney - nsy) * t + py;
        X.beginPath();
        X.moveTo(vx, vy - hy);
        X.lineTo(vx, vy - hy + wallH / courses);
        X.stroke();
      }
    }
    // top course joints — offset from the middle course below
    for (let t of [0.2, 0.5, 0.8]) {
      let vx = nsx + (nex - nsx) * t + px;
      let vy = nsy + (ney - nsy) * t + py;
      X.beginPath();
      X.moveTo(vx, vy - wallH);
      X.lineTo(vx, vy - wallH + wallH / courses);
      X.stroke();
    }
    X.restore();
  }

  // 2. Top walkway face
  X.fillStyle = fillTop;
  X.beginPath();
  X.moveTo(nsx - px, nsy - py - wallH);
  X.lineTo(nsx + px, nsy + py - wallH);
  X.lineTo(nex + px, ney + py - wallH);
  X.lineTo(nex - px, ney - py - wallH);
  X.closePath(); X.fill(); X.stroke();

  // 3. End cap face — closes the cut end exposed when d1/d2 trims the
  // link back from its endpoint (e.g. the gate door not reaching its post).
  if (capNear) {
    X.fillStyle = fillL;
    X.beginPath();
    X.moveTo(nex - px, ney - py);
    X.lineTo(nex + px, ney + py);
    X.lineTo(nex + px, ney + py - wallH);
    X.lineTo(nex - px, ney - py - wallH);
    X.closePath(); X.fill(); X.stroke();
  }
}

const darkenCache = new Map();
function darkenColor(col) {
  if (!col) return col;
  let cached = darkenCache.get(col);
  if (cached) return cached;
  
  let result = col;
  if (col.startsWith('#')) {
    let hex = col.substring(1);
    let r, g, b;
    if (hex.length === 6) {
      r = parseInt(hex.substring(0, 2), 16);
      g = parseInt(hex.substring(2, 4), 16);
      b = parseInt(hex.substring(4, 6), 16);
      r = Math.floor(r * 0.45);
      g = Math.floor(g * 0.45);
      b = Math.floor(b * 0.45);
      result = `rgb(${r},${g},${b})`;
    } else if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      r = Math.floor(r * 0.45);
      g = Math.floor(g * 0.45);
      b = Math.floor(b * 0.45);
      result = `rgb(${r},${g},${b})`;
    }
  } else if (col.startsWith('rgb')) {
    let parts = col.match(/\d+/g);
    if (parts && parts.length >= 3) {
      let r = Math.floor(parseInt(parts[0]) * 0.45);
      let g = Math.floor(parseInt(parts[1]) * 0.45);
      let b = Math.floor(parseInt(parts[2]) * 0.45);
      result = `rgb(${r},${g},${b})`;
    }
  }
  darkenCache.set(col, result);
  return result;
}
