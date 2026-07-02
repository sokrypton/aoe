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
function buildingFogLevel(e) {
  let b = BLDGS[e.btype];
  let w = e.w !== undefined ? e.w : (b ? b.w : 1);
  let h = e.h !== undefined ? e.h : (b ? b.h : 1);
  let maxF = 0;
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) {
      let tf = (fog[e.y+dy] && fog[e.y+dy][e.x+dx]) || 0;
      if (tf > maxF) maxF = tf;
      if (maxF === 2) return 2;
    }
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

  // Rounded boulder dome with flat base, outline, and top-left highlight —
  // shared by the gold and stone mine tiles.
  const dome=(rx,ry,rw,rh,c)=>{
    X.strokeStyle='#000';X.lineWidth=1.2;X.fillStyle=c;
    X.beginPath();X.ellipse(rx,ry,rw,rh,0,Math.PI,Math.PI*2);X.closePath();X.fill();X.stroke();
    X.fillStyle='rgba(255,255,255,0.14)';
    X.beginPath();X.ellipse(rx-rw*0.3,ry-rh*0.45,rw*0.35,rh*0.3,-0.3,0,Math.PI*2);X.fill();
  };
  if(t.t===TERRAIN.GOLD){
    let s=0.3+0.7*Math.min(t.res/800,1);
    // Rock mounds
    dome(sx-7*s, cy+3, 6.5*s, 8*s, '#6d675d');
    dome(sx+7*s, cy+3, 6*s, 7*s, '#7a746a');
    dome(sx,     cy+4, 8.5*s, 12*s, '#736d63');
    // Shiny gold ore embedded in the rock
    const ore=(ox,oy,r)=>{
      X.strokeStyle='#000';X.lineWidth=1;
      X.fillStyle='#e8b90f';X.beginPath();X.arc(ox,oy,r,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle='#ffe14d';X.beginPath();X.arc(ox-r*0.3,oy-r*0.3,r*0.45,0,Math.PI*2);X.fill();
      X.fillStyle='#fff';X.beginPath();X.arc(ox-r*0.45,oy-r*0.5,r*0.2,0,Math.PI*2);X.fill();
    };
    ore(sx-1.5*s, cy-4*s, 2.6*s);
    ore(sx+3.5*s, cy-0.5*s, 2.1*s);
    ore(sx-6*s,   cy+0.5, 1.9*s);
    ore(sx+8*s,   cy+0.5, 1.6*s);
    ore(sx+1.5*s, cy+3, 1.4*s); // loose nugget at the base
  }
  if(t.t===TERRAIN.STONE){
    let s=0.3+0.7*Math.min(t.res/350,1);
    // Granite mounds
    dome(sx-7*s, cy+3, 6.5*s, 7.5*s, '#7e7e7e');
    dome(sx+7*s, cy+3, 6*s, 6.5*s, '#8b8b8b');
    dome(sx,     cy+4, 8.5*s, 11*s, '#979797');
    // Cracks
    X.strokeStyle='rgba(0,0,0,0.45)';X.lineWidth=1;
    X.beginPath();X.moveTo(sx-2*s,cy-6*s);X.lineTo(sx-3.5*s,cy-2*s);X.lineTo(sx-2*s,cy+1);X.stroke();
    X.beginPath();X.moveTo(sx+3*s,cy-4*s);X.lineTo(sx+4.5*s,cy-1*s);X.stroke();
    // Pebbles at the base
    X.strokeStyle='#000';X.lineWidth=1;X.fillStyle='#8b8b8b';
    X.beginPath();X.ellipse(sx-3*s,cy+4,1.8*s,1.2*s,0,0,Math.PI*2);X.fill();X.stroke();
    X.beginPath();X.ellipse(sx+9*s,cy+3,1.5*s,1.0*s,0,0,Math.PI*2);X.fill();X.stroke();
  }
  if(t.t===TERRAIN.BERRIES){
    let s=0.4+0.6*Math.min(t.res/200,1);
    // Dark outline around foliage cloud
    X.fillStyle='#000000';
    X.beginPath();X.arc(sx-4*s, cy-3*s, 6*s+1.2, 0, Math.PI*2);X.fill();
    X.beginPath();X.arc(sx+4*s, cy-2*s, 5*s+1.2, 0, Math.PI*2);X.fill();
    X.beginPath();X.arc(sx, cy-7*s, 7*s+1.2, 0, Math.PI*2);X.fill();

    // Textured bushy leaves (overlapping circle cluster)
    X.fillStyle='#1e4c12';X.beginPath();X.arc(sx-4*s, cy-3*s, 6*s, 0, Math.PI*2);X.fill(); // shadow puff
    X.fillStyle='#2a631b';X.beginPath();X.arc(sx+4*s, cy-2*s, 5*s, 0, Math.PI*2);X.fill(); // shadow puff
    X.fillStyle='#367f22';X.beginPath();X.arc(sx, cy-7*s, 7*s, 0, Math.PI*2);X.fill(); // highlight puff
    
    // Red berries with specular reflection highlights
    let berryCount=Math.max(2,Math.ceil(5*s));
    for(let i=0;i<berryCount;i++){
      let a=i*1.2+0.4;
      let bx = sx + Math.cos(a)*6*s;
      let by = cy - 4*s + Math.sin(a)*4*s;
      X.fillStyle='#000000';X.beginPath();X.arc(bx,by,2*s+0.8,0,Math.PI*2);X.fill(); // berry outline
      X.fillStyle='#cc3344';X.beginPath();X.arc(bx,by,2*s,0,Math.PI*2);X.fill();
      X.fillStyle='#ff99a8';X.beginPath();X.arc(bx-0.5*s,by-0.5*s,0.7*s,0,Math.PI*2);X.fill(); // shiny glint
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
    X.arc(sx + b.x * s, cy + b.y * s, b.r * s + 1.5, 0, Math.PI * 2);
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

  // Initialize fell tick for falling tree animation
  if(t.res <= 60 && t.fellTick === undefined){
    t.fellTick = tick;
  }

  // Calculate fall progress and angle — frozen in shroud (static snapshot)
  let fallAngle = 0;
  let isFalling = false;
  if(f === 2 && t.fellTick !== undefined && t.fellTick > 0){
    let dt = tick - t.fellTick;
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
function drawWallLink(sx, sy, dx, dy, wallH, darken=false, d1=5, d2=5, colorL=null, colorTop=null, thick=4, capNear=false) {

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

  let fillL = colorL || (isAlongIsoY ? '#aca392' : '#cfc8b6');
  let fillTop = colorTop || '#b7ad97';
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

// Draws a 3D isometric building block with Left/Right walls and Flat or Peaked roof
function drawBuildingBlock(sx,sy,bw,bhh,bh,wallL,wallR,roofType,roofH,roofL,roofR,darken=false){
  let strokeColor = '#000000';
  X.strokeStyle = strokeColor;
  X.lineWidth = 1.3;
  X.lineJoin = 'round';

  if (darken) {
    wallL = darkenColor(wallL);
    wallR = darkenColor(wallR);
    roofL = darkenColor(roofL);
    roofR = darkenColor(roofR);
  }

  // 1. Left Wall Face (skewed 2:1)
  X.fillStyle=wallL;X.beginPath();
  X.moveTo(sx-bw,sy+bhh-bh);X.lineTo(sx,sy+bhh*2-bh);
  X.lineTo(sx,sy+bhh*2);X.lineTo(sx-bw,sy+bhh);X.closePath();X.fill();X.stroke();

  // 2. Right Wall Face (skewed 2:1)
  X.fillStyle=wallR;X.beginPath();
  X.moveTo(sx,sy+bhh*2-bh);X.lineTo(sx+bw,sy+bhh-bh);
  X.lineTo(sx+bw,sy+bhh);X.lineTo(sx,sy+bhh*2);X.closePath();X.fill();X.stroke();

  // 3. Roof (Flat top face or Peaked gable slopes)
  if(roofType==='flat'){
    // Fill left half facet
    X.fillStyle=roofL;X.beginPath();
    X.moveTo(sx-bw,sy+bhh-bh);X.lineTo(sx,sy-bh);
    X.lineTo(sx,sy+bhh*2-bh);X.closePath();X.fill();
    // Fill right half facet
    X.fillStyle=roofR;X.beginPath();
    X.moveTo(sx,sy-bh);X.lineTo(sx+bw,sy+bhh-bh);
    X.lineTo(sx,sy+bhh*2-bh);X.closePath();X.fill();
    // Stroke outer boundary only
    X.beginPath();
    X.moveTo(sx,sy-bh);X.lineTo(sx+bw,sy+bhh-bh);
    X.lineTo(sx,sy+bhh*2-bh);X.lineTo(sx-bw,sy+bhh-bh);X.closePath();X.stroke();
  } else if(roofType==='peaked'){
    // Left roof slope
    X.fillStyle=roofL;X.beginPath();
    X.moveTo(sx,sy-bh-roofH);X.lineTo(sx,sy+bhh*2-bh-roofH);
    X.lineTo(sx,sy+bhh*2-bh);X.lineTo(sx-bw,sy+bhh-bh);X.closePath();X.fill();X.stroke();
    // Right roof slope
    X.fillStyle=roofR;X.beginPath();
    X.moveTo(sx,sy-bh-roofH);X.lineTo(sx,sy+bhh*2-bh-roofH);
    X.lineTo(sx,sy+bhh*2-bh);X.lineTo(sx+bw,sy+bhh-bh);X.closePath();X.fill();X.stroke();
  } else if(roofType==='conical'){
    // Left conical slope
    X.fillStyle=roofL;X.beginPath();
    X.moveTo(sx,sy-bh-roofH);X.lineTo(sx-bw,sy+bhh-bh);
    X.lineTo(sx,sy+bhh*2-bh);X.closePath();X.fill();X.stroke();
    // Right conical slope
    X.fillStyle=roofR;X.beginPath();
    X.moveTo(sx,sy-bh-roofH);X.lineTo(sx+bw,sy+bhh-bh);
    X.lineTo(sx,sy+bhh*2-bh);X.closePath();X.fill();X.stroke();
  }

  // Material pass: translucent overlays that work with any wall/roof color —
  // horizontal course lines (stone courses / plank rows), a shadow band at
  // the wall base, a highlight under the roofline, and a ridge highlight on
  // peaked roofs.
  X.save();
  X.lineWidth = 1;
  X.strokeStyle = 'rgba(0,0,0,0.13)';
  for (let t of [0.3, 0.55, 0.8]) {
    X.beginPath();
    X.moveTo(sx - bw, sy + bhh - bh + bh * t);
    X.lineTo(sx, sy + bhh * 2 - bh + bh * t);
    X.lineTo(sx + bw, sy + bhh - bh + bh * t);
    X.stroke();
  }
  X.fillStyle = 'rgba(0,0,0,0.10)';
  X.beginPath();
  X.moveTo(sx - bw, sy + bhh - bh + bh * 0.8); X.lineTo(sx, sy + bhh * 2 - bh + bh * 0.8);
  X.lineTo(sx, sy + bhh * 2); X.lineTo(sx - bw, sy + bhh); X.closePath(); X.fill();
  X.beginPath();
  X.moveTo(sx, sy + bhh * 2 - bh + bh * 0.8); X.lineTo(sx + bw, sy + bhh - bh + bh * 0.8);
  X.lineTo(sx + bw, sy + bhh); X.lineTo(sx, sy + bhh * 2); X.closePath(); X.fill();
  X.strokeStyle = 'rgba(255,255,255,0.18)';
  X.beginPath();
  X.moveTo(sx - bw, sy + bhh - bh + 1.5); X.lineTo(sx, sy + bhh * 2 - bh + 1.5);
  X.lineTo(sx + bw, sy + bhh - bh + 1.5);
  X.stroke();
  if (roofType === 'peaked') {
    X.strokeStyle = 'rgba(255,255,255,0.3)'; X.lineWidth = 1.5;
    X.beginPath();
    X.moveTo(sx, sy - bh - roofH); X.lineTo(sx, sy + bhh * 2 - bh - roofH);
    X.stroke();
  }
  X.restore();
}

// Worn dirt clearing a camp's footprint sits on, so an open-sided shelter
// (no walls of its own to ground it) doesn't look like it's floating on
// untouched grass.
function drawCampClearing(sx,sy,bw,bhh,darken=false){
  X.fillStyle = darken ? darkenColor('#8a7252') : '#8a7252';
  X.strokeStyle = 'rgba(0,0,0,0.25)';
  X.lineWidth = 1;
  // The full tile diamond — (sx,sy)/(sx+bw,sy+bhh)/(sx,sy+bhh*2)/(sx-bw,sy+bhh)
  // are exactly the building's footprint tile corners (same shape drawTile()
  // uses for terrain), not a smaller inset shape. In iso view the building's
  // base should cover its whole ground tile, not float as a patch within it.
  X.beginPath();
  X.moveTo(sx,sy);X.lineTo(sx+bw,sy+bhh);X.lineTo(sx,sy+bhh*2);X.lineTo(sx-bw,sy+bhh);X.closePath();
  X.fill();X.stroke();
}

// Open-sided "camp" shelter: a peaked roof on visible corner posts with no
// wall faces, so the prop pile underneath reads through — distinguishes
// resource camps from solid buildings (TC/Barracks/etc.) in silhouette.
//
// Draws only the roof + pennant — NOT any of the 3 support posts. All posts
// sit at the same ground level as (or in front of) the prop pile placed
// between them, so they must be painted *after* the props or the pile's
// fills (e.g. a log's end-cap) paint over them. Call drawCampPosts() once
// the props are drawn to finish the shelter.
function drawCampShelter(sx,sy,bw,bhh,postH,roofH,postColor,roofL,roofR,teamColor,teamColorDark,darken=false){
  if (darken) { roofL = darkenColor(roofL); roofR = darkenColor(roofR); }
  X.lineJoin='round';

  // Peaked roof sitting atop the posts (same math as drawBuildingBlock's
  // peaked roof, anchored at eave height postH instead of a solid wall's bh)
  let bh=postH;
  X.strokeStyle='#000000';X.lineWidth=1.3;
  X.fillStyle=roofL;X.beginPath();
  X.moveTo(sx,sy-bh-roofH);X.lineTo(sx,sy+bhh*2-bh-roofH);
  X.lineTo(sx,sy+bhh*2-bh);X.lineTo(sx-bw,sy+bhh-bh);X.closePath();X.fill();X.stroke();
  X.fillStyle=roofR;X.beginPath();
  X.moveTo(sx,sy-bh-roofH);X.lineTo(sx,sy+bhh*2-bh-roofH);
  X.lineTo(sx,sy+bhh*2-bh);X.lineTo(sx+bw,sy+bhh-bh);X.closePath();X.fill();X.stroke();

  // Small team-colored pennant at the ridge apex so the camp's owner reads
  // at a glance, same as every other building's team trim/flag.
  let tcc = darken ? darkenColor(teamColor) : teamColor;
  let tccD = darken ? darkenColor(teamColorDark) : teamColorDark;
  let apexX=sx, apexY=sy-bh-roofH;
  X.strokeStyle='#000000';X.lineWidth=1.3;
  X.beginPath();X.moveTo(apexX,apexY);X.lineTo(apexX,apexY-10);X.stroke();
  X.fillStyle=tcc;X.beginPath();
  X.moveTo(apexX,apexY-10);X.lineTo(apexX+9,apexY-7);X.lineTo(apexX,apexY-4);X.closePath();
  X.fill();X.stroke();
  X.fillStyle=tccD;X.beginPath();
  X.moveTo(apexX,apexY-9);X.lineTo(apexX+6,apexY-7);X.lineTo(apexX,apexY-5);X.closePath();
  X.fill();
}

// Draws all 3 of the camp shelter's support posts (left, right, front-center).
// Must be called AFTER any props placed under the canopy, not as part of
// drawCampShelter() — every post shares ground level with (or is nearer the
// camera than) the prop pile between them, so drawing posts first let a
// prop's fill (e.g. a log's end-cap) paint right over a post.
function drawCampPosts(sx,sy,bw,bhh,postH,postColor,darken=false){
  let pc = darken ? darkenColor(postColor) : postColor;
  X.lineJoin='round';
  [[sx-bw,sy+bhh],[sx+bw,sy+bhh],[sx,sy+bhh*2]].forEach(([gx,gy])=>{
    X.strokeStyle=pc;X.lineWidth=4;
    X.beginPath();X.moveTo(gx,gy);X.lineTo(gx,gy-postH);X.stroke();
    X.strokeStyle='#000000';X.lineWidth=1;
    X.beginPath();X.moveTo(gx,gy);X.lineTo(gx,gy-postH);X.stroke();
  });
}

// Draws a skewed wooden door sits flat against the Left Wall
function drawDoorLeft(sx,sy,bw,bhh,color,darken=false){
  let c = darken ? darkenColor(color) : color;
  X.fillStyle=c;X.beginPath();
  X.moveTo(sx-bw*0.625,sy+bhh*1.375);X.lineTo(sx-bw*0.375,sy+bhh*1.625);
  X.lineTo(sx-bw*0.375,sy+bhh*1.625-8);X.lineTo(sx-bw*0.625,sy+bhh*1.375-8);X.closePath();
  X.fill();
  X.strokeStyle='#000000';X.lineWidth=1;X.stroke();
}

// Draws a double gate wrapping the bottom corner of a building block
function drawCornerDoubleGate(sx,sy,bhh,gateH,colorL,colorR,darken=false){
  X.strokeStyle='#000000';X.lineWidth=1;
  let cL = darken ? darkenColor(colorL) : colorL;
  let cR = darken ? darkenColor(colorR) : colorR;
  // Left leaf
  X.fillStyle=cL;X.beginPath();
  X.moveTo(sx-6,sy+bhh*2-3);X.lineTo(sx,sy+bhh*2);
  X.lineTo(sx,sy+bhh*2-gateH);X.lineTo(sx-6,sy+bhh*2-gateH-3);X.closePath();X.fill();X.stroke();
  // Right leaf
  X.fillStyle=cR;X.beginPath();
  X.moveTo(sx,sy+bhh*2);X.lineTo(sx+6,sy+bhh*2-3);
  X.lineTo(sx+6,sy+bhh*2-gateH-3);X.lineTo(sx,sy+bhh*2-gateH);X.closePath();X.fill();X.stroke();
}

// Draws a flagpole and team-colored waving flag on top of a keep
function drawWavingFlag(sx,sy,bh,color,colorDark){
  X.strokeStyle='#000000';X.lineWidth=1.5;
  X.beginPath();X.moveTo(sx,sy-bh-2);X.lineTo(sx,sy-bh-24);X.stroke(); // pole
  let wave=Math.sin(tick*0.1)*3;
  X.fillStyle=color;X.beginPath();
  X.moveTo(sx,sy-bh-24);X.lineTo(sx-16,sy-bh-20+wave);
  X.lineTo(sx-16,sy-bh-12+wave);X.lineTo(sx,sy-bh-16);X.closePath();
  X.fill();X.stroke();
}

// Timber building under a gable roof: the ridge runs back-left to
// front-right, showing one roof slope to the camera and a triangular
// gable end above the front-right wall. Overhangs are pure translations
// along the ridge / down-slope directions so all edges stay iso-parallel.
// Returns key anchor points so callers can place props.
function drawGableBlock(sx, sy0, W, hh, wallH, roofH, wallL, wallR, roofC, beamC, darken){
  let wl=darken?darkenColor(wallL):wallL;
  let wr=darken?darkenColor(wallR):wallR;
  let rl=darken?darkenColor(roofC):roofC;
  let beam=darken?darkenColor(beamC):beamC;
  X.strokeStyle='#000';X.lineWidth=1.3;X.lineJoin='round';
  // Walls
  X.fillStyle=wl;X.beginPath();
  X.moveTo(sx-W,sy0+hh-wallH);X.lineTo(sx,sy0+hh*2-wallH);X.lineTo(sx,sy0+hh*2);X.lineTo(sx-W,sy0+hh);X.closePath();X.fill();X.stroke();
  X.fillStyle=wr;X.beginPath();
  X.moveTo(sx,sy0+hh*2-wallH);X.lineTo(sx+W,sy0+hh-wallH);X.lineTo(sx+W,sy0+hh);X.lineTo(sx,sy0+hh*2);X.closePath();X.fill();X.stroke();
  // Corner post
  X.strokeStyle=beam;X.lineWidth=1.6;
  X.beginPath();X.moveTo(sx,sy0+hh*2-wallH);X.lineTo(sx,sy0+hh*2);X.stroke();
  // Gable-end triangle above the front-right wall, with a center stud
  let Rp={x:sx+W,y:sy0+hh-wallH}, Bp={x:sx,y:sy0+hh*2-wallH}, Lp={x:sx-W,y:sy0+hh-wallH};
  let M1={x:sx+W*0.5,y:sy0+hh*1.5-wallH-roofH};
  let M2={x:sx-W*0.5,y:sy0+hh*0.5-wallH-roofH};
  X.fillStyle=wr;X.strokeStyle='#000';X.lineWidth=1.3;
  X.beginPath();X.moveTo(Bp.x,Bp.y);X.lineTo(Rp.x,Rp.y);X.lineTo(M1.x,M1.y);X.closePath();X.fill();X.stroke();
  X.strokeStyle=beam;X.lineWidth=1.6;
  X.beginPath();X.moveTo((Bp.x+Rp.x)/2,(Bp.y+Rp.y)/2);X.lineTo(M1.x,M1.y);X.stroke();
  // Roof slope with iso-parallel overhangs
  let vR={x:(M2.x-M1.x)*0.10, y:(M2.y-M1.y)*0.10};
  let vF={x:(M1.x-M2.x)*0.02, y:(M1.y-M2.y)*0.02};
  let vS={x:(Lp.x-M2.x)*0.10, y:(Lp.y-M2.y)*0.10};
  let M2e={x:M2.x+vR.x, y:M2.y+vR.y};
  let M1e={x:M1.x+vF.x, y:M1.y+vF.y};
  let EL={x:Lp.x+vR.x+vS.x, y:Lp.y+vR.y+vS.y};
  let EB={x:Bp.x+vF.x+vS.x, y:Bp.y+vF.y+vS.y};
  X.fillStyle=rl;X.strokeStyle='#000';X.lineWidth=1.3;
  X.beginPath();X.moveTo(M2e.x,M2e.y);X.lineTo(M1e.x,M1e.y);X.lineTo(EB.x,EB.y);X.lineTo(EL.x,EL.y);X.closePath();X.fill();X.stroke();
  // Course lines parallel to the ridge
  X.strokeStyle='rgba(0,0,0,0.15)';X.lineWidth=1;
  for(let t of [0.35,0.7]){
    X.beginPath();
    X.moveTo(M2e.x+(EL.x-M2e.x)*t, M2e.y+(EL.y-M2e.y)*t);
    X.lineTo(M1e.x+(EB.x-M1e.x)*t, M1e.y+(EB.y-M1e.y)*t);
    X.stroke();
  }
  return {M1,M2,Rp,Bp,Lp};
}

// Small team pennant on a short pole (for houses/small buildings)
function drawPennant(px,py,color,darken){
  let c = darken ? darkenColor(color) : color;
  X.strokeStyle='#000';X.lineWidth=1.2;
  X.beginPath();X.moveTo(px,py);X.lineTo(px,py-8);X.stroke();
  X.fillStyle=c;X.beginPath();
  X.moveTo(px,py-8);X.lineTo(px+7,py-6);X.lineTo(px,py-4);X.closePath();X.fill();X.stroke();
}

// Draws animated chimney smoke puffs
function drawChimneySmoke(cx,cy){
  X.fillStyle='rgba(180,180,180,0.4)';
  let smokeOffset = (tick % 60) / 60;
  let syy = cy - smokeOffset * 18;
  let sxx = cx + Math.sin(tick*0.08)*2;
  X.beginPath();X.arc(sxx,syy,2.5+smokeOffset*4,0,Math.PI*2);X.fill();
}

// Draws animated rotating windmill sails
function drawWindmillSails(hx,hy,id){
  let rot = tick * 0.035 + id*0.5; // slightly faster for more drama!
  
  for(let i=0; i<4; i++){
    let a = rot + i * Math.PI / 2;
    
    // Direction vectors — the fan is mounted on the mill cap facing the
    // camera, so it spins in a (slightly flattened) screen-plane circle;
    // opposite sails stay perfectly symmetric around the hub.
    let dx = Math.cos(a);
    let dy = Math.sin(a) * 0.95;
    let px = -Math.sin(a);
    let py = Math.cos(a) * 0.95;
    
    let L = 27; // Spar length (increased from 14 for massive drama!)
    let tx = hx + dx * L;
    let ty = hy + dy * L;
    
    // 1. Spar wood outline (thick black)
    X.strokeStyle = '#000000';
    X.lineWidth = 3;
    X.beginPath(); X.moveTo(hx, hy); X.lineTo(tx, ty); X.stroke();
    
    // 2. Spar wood fill (brown)
    X.strokeStyle = '#8B4513';
    X.lineWidth = 1.5;
    X.beginPath(); X.moveTo(hx, hy); X.lineTo(tx, ty); X.stroke();
    
    // 3. Canvas sail sheet (quadrilateral)
    let x1 = hx + dx * 5;
    let y1 = hy + dy * 5;
    let x2 = tx;
    let y2 = ty;
    let x3 = tx + px * 8;
    let y3 = ty + py * 8;
    let x4 = x1 + px * 6;
    let y4 = y1 + py * 6;
    
    X.fillStyle = '#f5f2e9';
    X.beginPath();
    X.moveTo(x1, y1);
    X.lineTo(x2, y2);
    X.lineTo(x3, y3);
    X.lineTo(x4, y4);
    X.closePath();
    X.fill();
    
    X.strokeStyle = '#000000';
    X.lineWidth = 1.3;
    X.stroke();
  }
  
  // Center pivot pin
  X.fillStyle='#866840';
  X.beginPath();X.arc(hx,hy,3.5,0,Math.PI*2);X.fill();
  X.strokeStyle='#000000';X.lineWidth=1;X.stroke();
}
// Main function to draw building entities
// Shared by TOWER/WALL/GATE for locating an adjacent building to link to.
function getConnectedBuilding(tx, ty){
  return entities.find(en => en.type === 'building' && tx >= en.x && tx < en.x + (en.w || BLDGS[en.btype]?.w || 1) && ty >= en.y && ty < en.y + (en.h || BLDGS[en.btype]?.h || 1));
}
function isWallLike(b){
  return !!b && (b.btype === 'WALL' || b.btype === 'TOWER' || b.btype === 'GATE');
}
// GATE's 4-merlon battlement cap, shared between its back and front posts.
function drawBastionMerlons(cx, cy, colorL, colorR, darken){
  let m = [
    { x: cx,      y: cy - 35 }, // Top
    { x: cx - 10, y: cy - 30 }, // Left
    { x: cx + 10, y: cy - 30 }, // Right
    { x: cx,      y: cy - 25 }  // Bottom
  ];
  m.forEach(p => drawBuildingBlock(p.x, p.y, 4, 2, 5, '#c8c0ae', '#a89f8d', 'flat', 0, colorL, colorR, darken));
}

function drawBuilding(e, part = null){
  let b=BLDGS[e.btype];
  let cx=e.x+b.w/2,cy=e.y+b.h/2;
  let iso=toIso(cx,cy);
  let sx=Math.round(iso.ix-camX+W/2), sy=Math.round(iso.iy-camY+topH+H/2);
  if(isOffscreen(sx,sy,100))return;
  let bw=b.w*HALF_TW, bhh=b.h*HALF_TH;
  sy-=bhh;
  // Compute fog level once for the full footprint; used to gate animations and overlay
  let f = window._ghostDraw ? 2 : buildingFogLevel(e);
  let visible = f === 2; // actively in sight — show live animations
  let darken = !window._ghostDraw && f === 1;
  if(!e.complete && !window._ghostDraw) X.globalAlpha=0.5+e.buildProgress/e.buildTime*0.5;
  let tc=e.team===0?'#2266bb':'#cc4444';
  let tcD=e.team===0?'#1a4488':'#993333';
  let bh=10;

  let strokeColor = '#000000';
  X.strokeStyle = strokeColor;
  X.lineWidth = 1.3;
  X.lineJoin = 'round';

  if(e.btype==='TC'){
    bh=60; // 40 * 1.5 = 60

    // Draw stone foundation pavement covering the keep footprint in the back quadrant
    X.fillStyle = darken ? darkenColor('#8d8577') : '#b7ad97';
    X.strokeStyle = '#000000';
    X.lineWidth = 1.3;
    X.beginPath();
    X.moveTo(sx, sy);
    X.lineTo(sx + 48, sy + 24);
    X.lineTo(sx, sy + 48);
    X.lineTo(sx - 48, sy + 24);
    X.closePath();
    X.fill();
    X.stroke();

    // 1. Tall Main Keep Tower (solid stone, centered in the back quadrant)
    drawBuildingBlock(sx, sy, 48, 24, 60, '#ded5c2','#bcb29b','flat',0,'#b7ad97','#b7ad97', darken);
    // 3D Castle battlements (crenellations) on flat top edges
    let merlons = [
      { x: sx,      y: sy - 56 }, // Top corner (0px gap to top)
      { x: sx - 20, y: sy - 46 }, // Back-left (perfectly centered on top-left edge)
      { x: sx + 20, y: sy - 46 }, // Back-right (perfectly centered on top-right edge)
      { x: sx - 40, y: sy - 36 }, // Left corner (0px gap to left)
      { x: sx + 40, y: sy - 36 }, // Right corner (0px gap to right)
      { x: sx - 20, y: sy - 26 }, // Front-left (perfectly centered on bottom-left edge)
      { x: sx + 20, y: sy - 26 }, // Front-right (perfectly centered on bottom-right edge)
      { x: sx,      y: sy - 16 }  // Bottom corner (0px gap to bottom)
    ];

    let drawMerlon = (mx, my) => {
      let wl = '#ded5c2', wr = '#bcb29b', rf = '#b7ad97';
      if (darken) {
        wl = darkenColor(wl);
        wr = darkenColor(wr);
        rf = darkenColor(rf);
      }
      X.strokeStyle = '#000000';
      X.lineWidth = 1.3;
      X.lineJoin = 'round';

      // 1. Left Wall (fully outlined)
      X.fillStyle = wl;
      X.beginPath();
      X.moveTo(mx - 8, my - 10);
      X.lineTo(mx, my - 6);
      X.lineTo(mx, my + 4);
      X.lineTo(mx - 8, my);
      X.closePath();
      X.fill();
      X.stroke();

      // 2. Right Wall (fully outlined)
      X.fillStyle = wr;
      X.beginPath();
      X.moveTo(mx, my - 6);
      X.lineTo(mx + 8, my - 10);
      X.lineTo(mx + 8, my);
      X.lineTo(mx, my + 4);
      X.closePath();
      X.fill();
      X.stroke();

      // 3. Flat Top (fully outlined)
      X.fillStyle = rf;
      X.beginPath();
      X.moveTo(mx, my - 14);
      X.lineTo(mx + 8, my - 10);
      X.lineTo(mx, my - 6);
      X.lineTo(mx - 8, my - 10);
      X.closePath();
      X.fill();
      X.stroke();
    };

    merlons.forEach(m => {
      drawMerlon(m.x, m.y);
    });

    // 3D Recessed arrow-loop windows on keep walls (perfectly aligned with wall perspective & depth)
    let winFill = darken ? darkenColor('#1c1c1c') : '#1c1c1c';
    let stoneShadow = darken ? darkenColor('#a0a098') : '#bcb29b';
    let stoneDark = darken ? darkenColor('#8c8c84') : '#a8a8a0';

    X.strokeStyle = '#000000';
    X.lineWidth = 1.3;
    X.lineJoin = 'round';

    // 1. Left Wall Window (skewed 2:1 up-right, recessed inwards-right)
    let lwx = sx - 24, lwy = sy - 6;
    let lO1 = { x: lwx - 4, y: lwy - 9 };
    let lO2 = { x: lwx + 4, y: lwy - 5 };
    let lO3 = { x: lwx + 4, y: lwy + 9 };
    let lO4 = { x: lwx - 4, y: lwy + 5 };

    let lB1 = { x: lwx - 2, y: lwy - 8 };
    let lB2 = { x: lwx + 6, y: lwy - 4 };
    let lB3 = { x: lwx + 6, y: lwy + 10 };
    let lB4 = { x: lwx - 2, y: lwy + 6 };

    // Fill inside left wall depth panel
    X.fillStyle = stoneShadow;
    X.beginPath();
    X.moveTo(lO1.x, lO1.y);
    X.lineTo(lB1.x, lB1.y);
    X.lineTo(lB4.x, lB4.y);
    X.lineTo(lO4.x, lO4.y);
    X.closePath(); X.fill(); X.stroke();

    // Fill inside bottom ledge depth panel
    X.fillStyle = stoneDark;
    X.beginPath();
    X.moveTo(lO4.x, lO4.y);
    X.lineTo(lB4.x, lB4.y);
    X.lineTo(lB3.x, lB3.y);
    X.lineTo(lO3.x, lO3.y);
    X.closePath(); X.fill(); X.stroke();

    // Fill dark back wall opening
    X.fillStyle = winFill;
    X.beginPath();
    X.moveTo(lB1.x, lB1.y);
    X.lineTo(lB2.x, lB2.y);
    X.lineTo(lB3.x, lB3.y);
    X.lineTo(lB4.x, lB4.y);
    X.closePath(); X.fill(); X.stroke();

    // Outer frame outline
    X.beginPath();
    X.moveTo(lO1.x, lO1.y);
    X.lineTo(lO2.x, lO2.y);
    X.lineTo(lO3.x, lO3.y);
    X.lineTo(lO4.x, lO4.y);
    X.closePath(); X.stroke();

    // 2. Right Wall Window (skewed 2:1 down-right, recessed inwards-left)
    let rwx = sx + 24, rwy = sy - 6;
    let rO1 = { x: rwx - 4, y: rwy - 5 };
    let rO2 = { x: rwx + 4, y: rwy - 9 };
    let rO3 = { x: rwx + 4, y: rwy + 5 };
    let rO4 = { x: rwx - 4, y: rwy + 9 };

    let rB1 = { x: rwx - 6, y: rwy - 4 };
    let rB2 = { x: rwx + 2, y: rwy - 8 };
    let rB3 = { x: rwx + 2, y: rwy + 6 };
    let rB4 = { x: rwx - 6, y: rwy + 10 };

    // Fill inside right wall depth panel
    X.fillStyle = stoneShadow;
    X.beginPath();
    X.moveTo(rO2.x, rO2.y);
    X.lineTo(rB2.x, rB2.y);
    X.lineTo(rB3.x, rB3.y);
    X.lineTo(rO3.x, rO3.y);
    X.closePath(); X.fill(); X.stroke();

    // Fill inside bottom ledge depth panel
    X.fillStyle = stoneDark;
    X.beginPath();
    X.moveTo(rO4.x, rO4.y);
    X.lineTo(rB4.x, rB4.y);
    X.lineTo(rB3.x, rB3.y);
    X.lineTo(rO3.x, rO3.y);
    X.closePath(); X.fill(); X.stroke();

    // Fill dark back wall opening
    X.fillStyle = winFill;
    X.beginPath();
    X.moveTo(rB1.x, rB1.y);
    X.lineTo(rB2.x, rB2.y);
    X.lineTo(rB3.x, rB3.y);
    X.lineTo(rB4.x, rB4.y);
    X.closePath(); X.fill(); X.stroke();

    // Outer frame outline
    X.beginPath();
    X.moveTo(rO1.x, rO1.y);
    X.lineTo(rO2.x, rO2.y);
    X.lineTo(rO3.x, rO3.y);
    X.lineTo(rO4.x, rO4.y);
    X.closePath(); X.stroke();



    // 2. Left Annex Roof (open-sided shelter roof covering left quadrant, matching team color)
    let laX = sx - 48, laY = sy + 24;
    let laH = 16, laRoofH = 12;
    let laL = '#a8845c', laR = '#8a6a48';
    if (darken) { laL = darkenColor(laL); laR = darkenColor(laR); }
    X.strokeStyle='#000000';X.lineWidth=1.3; X.lineJoin='round';
    X.fillStyle=laL;X.beginPath();
    X.moveTo(laX,laY-laH-laRoofH); X.lineTo(laX,laY+24*2-laH-laRoofH);
    X.lineTo(laX,laY+24*2-laH); X.lineTo(laX-48,laY+24-laH); X.closePath(); X.fill(); X.stroke();
    X.fillStyle=laR;X.beginPath();
    X.moveTo(laX,laY-laH-laRoofH); X.lineTo(laX,laY+24*2-laH-laRoofH);
    X.lineTo(laX,laY+24*2-laH); X.lineTo(laX+48,laY+24-laH); X.closePath(); X.fill(); X.stroke();

    // 3. Right Annex Roof (open-sided shelter roof covering right quadrant, matching team color)
    let raX = sx + 48, raY = sy + 24;
    let raH = 16, raRoofH = 12;
    let raL = '#a8845c', raR = '#8a6a48';
    if (darken) { raL = darkenColor(raL); raR = darkenColor(raR); }
    X.fillStyle=raL;X.beginPath();
    X.moveTo(raX,raY-raH-raRoofH); X.lineTo(raX,raY+24*2-raH-raRoofH);
    X.lineTo(raX,raY+24*2-raH); X.lineTo(raX-48,raY+24-raH); X.closePath(); X.fill(); X.stroke();
    X.fillStyle=raR;X.beginPath();
    X.moveTo(raX,raY-raH-raRoofH); X.lineTo(raX,raY+24*2-raH-raRoofH);
    X.lineTo(raX,raY+24*2-raH); X.lineTo(raX+48,raY+24-raH); X.closePath(); X.fill(); X.stroke();

    // 5. Draw all wooden posts (sorted back-to-front for perfect depth overlap)
    let posts = [
      // Left Annex posts (height 16)
      { x: sx - 96, y: sy + 48, h: 16 }, // Left-most
      { x: sx - 48, y: sy + 72, h: 16 }, // Bottom-left

      // Right Annex posts (height 16)
      { x: sx + 96, y: sy + 48, h: 16 }, // Right-most
      { x: sx + 48, y: sy + 72, h: 16 }, // Bottom-right

      // Shared Center Post (height 16)
      { x: sx,      y: sy + 48, h: 16 }  // Center
    ];
    posts.sort((a, b) => a.y - b.y);

    let postColor = '#8a6a4a';
    let pc = darken ? darkenColor(postColor) : postColor;
    X.lineJoin = 'round';
    posts.forEach(p => {
      X.strokeStyle = pc; X.lineWidth = 3.5;
      X.beginPath(); X.moveTo(p.x, p.y); X.lineTo(p.x, p.y - p.h); X.stroke();
      X.strokeStyle = '#000000'; X.lineWidth = 1;
      X.beginPath(); X.moveTo(p.x, p.y); X.lineTo(p.x, p.y - p.h); X.stroke();
    });

    // Team banner flying from the keep top
    if(e.complete) drawWavingFlag(sx, sy, 72, darken ? darkenColor(tc) : tc, darken ? darkenColor(tcD) : tcD);
  }
  else if(e.btype==='HOUSE'){
    // Timber-framed cottage under a big yellow hay gable roof
    let W=22, hh=11, wallH=14, roofH=18;
    bh=26;
    let sy0=sy+bhh-hh; // center on tile
    let wl=darken?darkenColor('#ebd2b0'):'#ebd2b0';
    let wr=darken?darkenColor('#d2b48c'):'#d2b48c';
    let beam=darken?darkenColor('#7a5a38'):'#7a5a38';
    X.strokeStyle='#000';X.lineWidth=1.3;X.lineJoin='round';
    // Plaster walls
    X.fillStyle=wl;X.beginPath();
    X.moveTo(sx-W,sy0+hh-wallH);X.lineTo(sx,sy0+hh*2-wallH);X.lineTo(sx,sy0+hh*2);X.lineTo(sx-W,sy0+hh);X.closePath();X.fill();X.stroke();
    X.fillStyle=wr;X.beginPath();
    X.moveTo(sx,sy0+hh*2-wallH);X.lineTo(sx+W,sy0+hh-wallH);X.lineTo(sx+W,sy0+hh);X.lineTo(sx,sy0+hh*2);X.closePath();X.fill();X.stroke();
    // Half-timber framing: front corner post, studs, and a mid-rail per face
    X.strokeStyle=beam;X.lineWidth=1.6;
    X.beginPath();X.moveTo(sx,sy0+hh*2-wallH);X.lineTo(sx,sy0+hh*2);X.stroke();
    [0.35,0.7].forEach(t=>{
      X.beginPath();X.moveTo(sx-W+W*t,sy0+hh-wallH+hh*t);X.lineTo(sx-W+W*t,sy0+hh+hh*t);X.stroke();
      X.beginPath();X.moveTo(sx+W*t,sy0+hh*2-wallH-hh*t);X.lineTo(sx+W*t,sy0+hh*2-hh*t);X.stroke();
    });
    X.beginPath();X.moveTo(sx-W,sy0+hh-wallH*0.5);X.lineTo(sx,sy0+hh*2-wallH*0.5);X.lineTo(sx+W,sy0+hh-wallH*0.5);X.stroke();
    // Door on the left wall, shuttered window on the right wall
    drawDoorLeft(sx,sy0,W,hh,'#5c3d24', darken);
    let wx=sx+W*0.5, wy=sy0+hh*2-wallH-hh*0.5+wallH*0.3;
    X.fillStyle=darken?darkenColor('#3a2a18'):'#3a2a18';X.strokeStyle='#000';X.lineWidth=1;
    X.beginPath();X.moveTo(wx-3,wy+1.5);X.lineTo(wx+3,wy-1.5);X.lineTo(wx+3,wy+3.5);X.lineTo(wx-3,wy+6.5);X.closePath();X.fill();X.stroke();
    // Gable hay roof: the ridge runs from back-left to front-right, so we
    // see one big hay slope (facing lower-left) and a triangular plaster
    // gable end above the front-right wall.
    let rl=darken?darkenColor('#e8c04a'):'#e8c04a';
    let ridgeC=darken?darkenColor('#b58a2e'):'#b58a2e';
    // Wall-top rim corners and the two gable peaks over the wall midlines
    let Rp={x:sx+W,y:sy0+hh-wallH}, Bp={x:sx,y:sy0+hh*2-wallH}, Lp={x:sx-W,y:sy0+hh-wallH};
    let M1={x:sx+W*0.5,y:sy0+hh*1.5-wallH-roofH};   // front gable peak
    let M2={x:sx-W*0.5,y:sy0+hh*0.5-wallH-roofH};   // back gable peak
    // Gable-end triangle above the front-right wall, with a center stud
    X.fillStyle=wr;X.strokeStyle='#000';X.lineWidth=1.3;
    X.beginPath();X.moveTo(Bp.x,Bp.y);X.lineTo(Rp.x,Rp.y);X.lineTo(M1.x,M1.y);X.closePath();X.fill();X.stroke();
    X.strokeStyle=beam;X.lineWidth=1.6;
    X.beginPath();X.moveTo((Bp.x+Rp.x)/2,(Bp.y+Rp.y)/2);X.lineTo(M1.x,M1.y);X.stroke();
    // Hay slope with overhang. Overhangs are pure translations along the
    // ridge direction (vR back / vF front) and down-slope direction (vS),
    // so every roof edge stays parallel to its wall — iso-correct.
    let vR={x:(M2.x-M1.x)*0.10, y:(M2.y-M1.y)*0.10}; // back ridge extension
    let vF={x:(M1.x-M2.x)*0.02, y:(M1.y-M2.y)*0.02}; // front ridge extension
    let vS={x:(Lp.x-M2.x)*0.10, y:(Lp.y-M2.y)*0.10}; // down-slope eave extension
    let M2e={x:M2.x+vR.x, y:M2.y+vR.y};
    let M1e={x:M1.x+vF.x, y:M1.y+vF.y};
    let EL={x:Lp.x+vR.x+vS.x, y:Lp.y+vR.y+vS.y};
    let EB={x:Bp.x+vF.x+vS.x, y:Bp.y+vF.y+vS.y};
    X.fillStyle=rl;X.strokeStyle='#000';X.lineWidth=1.3;
    X.beginPath();X.moveTo(M2e.x,M2e.y);X.lineTo(M1e.x,M1e.y);X.lineTo(EB.x,EB.y);X.lineTo(EL.x,EL.y);X.closePath();X.fill();X.stroke();
    // Thatch strand lines parallel to the ridge
    X.strokeStyle='rgba(0,0,0,0.15)';X.lineWidth=1;
    [0.35,0.7].forEach(t=>{
      X.beginPath();
      X.moveTo(M2e.x+(EL.x-M2e.x)*t, M2e.y+(EL.y-M2e.y)*t);
      X.lineTo(M1e.x+(EB.x-M1e.x)*t, M1e.y+(EB.y-M1e.y)*t);
      X.stroke();
    });
    // Ragged straw fringe hanging past the eave
    X.strokeStyle=ridgeC;X.lineWidth=1.2;X.lineCap='round';
    for(let i=0;i<=4;i++){
      let t=i/4;
      let fx2=EL.x+(EB.x-EL.x)*t, fy2=EL.y+(EB.y-EL.y)*t;
      X.beginPath();X.moveTo(fx2,fy2);X.lineTo(fx2-0.5,fy2+2.5);X.stroke();
    }
    X.lineCap='butt';
    // Team pennant at the front gable peak
    drawPennant(M1.x,M1.y,tc,darken);
    // Chimney poking through the hay slope + smoke
    let cru={x:M2.x+(M1.x-M2.x)*0.3, y:M2.y+(M1.y-M2.y)*0.3};
    let cre={x:EL.x+(EB.x-EL.x)*0.3, y:EL.y+(EB.y-EL.y)*0.3};
    let chx=cru.x+(cre.x-cru.x)*0.3, chTop=cru.y+(cre.y-cru.y)*0.3-9;
    X.fillStyle=darken?darkenColor('#8a4030'):'#8a4030';X.fillRect(chx-2,chTop,4,9);
    X.strokeStyle='#000';X.lineWidth=1;X.strokeRect(chx-2,chTop,4,9);
    X.fillStyle=darken?darkenColor('#602820'):'#602820';X.fillRect(chx-2.6,chTop-2.5,5.2,2.5);X.strokeRect(chx-2.6,chTop-2.5,5.2,2.5);
    if(e.complete && visible) drawChimneySmoke(chx,chTop-3);
  }
  else if(e.btype==='BARRACKS'){
    bh=32;
    // 1. Sleeping-quarters annex at the back
    drawGableBlock(sx+2, sy+10, 20, 10, 13, 12, '#b89868','#987848','#7d5f43','#6e5138', darken);
    // 2. Main garrison longhouse in front-left
    drawGableBlock(sx-32, sy+22, 26, 13, 16, 15, '#b89868','#987848','#7d5f43','#6e5138', darken);
    // Hanging shields on the longhouse left wall
    X.strokeStyle='#000000';X.lineWidth=1;
    [[-46,25],[-38,29]].forEach(([dx2,dy2])=>{
      X.fillStyle=darken ? darkenColor('#a0a0a0') : '#a0a0a0';
      X.beginPath();X.arc(sx+dx2, sy+dy2, 3.2, 0, Math.PI*2);X.fill();X.stroke();
      X.fillStyle=darken ? darkenColor(tc) : tc;
      X.beginPath();X.arc(sx+dx2, sy+dy2, 1.6, 0, Math.PI*2);X.fill();X.stroke();
    });
    // Door on the longhouse left wall
    drawDoorLeft(sx-32, sy+22, 26, 13, '#5c3d24', darken);

    // 3. Corner stone watchtower
    drawBuildingBlock(sx+32, sy+32, 16, 8, 30, '#cfc8b6','#aca392','flat',0,'#9a9184','#867d70', darken);
    X.fillStyle=darken ? darkenColor('#8d8577') : '#8d8577';
    X.fillRect(sx+32-13, sy+32-30+6, 3.5, 4);
    X.strokeStyle='#000000';X.lineWidth=1;X.strokeRect(sx+32-13, sy+32-30+6, 3.5, 4);
    X.fillRect(sx+32+9.5, sy+32-30+6, 3.5, 4);
    X.strokeRect(sx+32+9.5, sy+32-30+6, 3.5, 4);
    // Flagpole planted at the center of the tower's top face, not its back
    // corner, so the flag visibly connects to the roof.
    if(e.complete && visible) drawWavingFlag(sx+32, sy+40, 28, tc, tcD);

    // 4. Fenced training yard
    X.fillStyle=darken ? darkenColor('#bfa38a') : '#bfa38a';X.beginPath();
    X.moveTo(sx,sy+32);X.lineTo(sx+32,sy+48);
    X.lineTo(sx,sy+64);X.lineTo(sx-32,sy+48);X.closePath();
    X.fill();
    X.strokeStyle='#000000';X.lineWidth=1.2;X.stroke();

    // Straw training dummy in the yard
    let dxp=sx-10, dyp=sy+52;
    X.strokeStyle='#000';X.lineWidth=2.8;X.lineCap='round';
    X.beginPath();X.moveTo(dxp,dyp);X.lineTo(dxp,dyp-13);X.stroke();
    X.beginPath();X.moveTo(dxp-6,dyp-9.5);X.lineTo(dxp+6,dyp-9.5);X.stroke();
    X.strokeStyle=darken ? darkenColor('#8a6a4a') : '#8a6a4a';X.lineWidth=1.4;
    X.beginPath();X.moveTo(dxp,dyp);X.lineTo(dxp,dyp-13);X.stroke();
    X.beginPath();X.moveTo(dxp-6,dyp-9.5);X.lineTo(dxp+6,dyp-9.5);X.stroke();
    X.lineCap='butt';
    X.fillStyle=darken ? darkenColor('#c8ab7a') : '#c8ab7a'; // burlap torso
    X.strokeStyle='#000';X.lineWidth=1;
    X.beginPath();X.ellipse(dxp,dyp-6,3.2,4.2,0,0,Math.PI*2);X.fill();X.stroke();
    X.fillStyle=darken ? darkenColor('#e8c04a') : '#e8c04a'; // straw head
    X.beginPath();X.arc(dxp,dyp-14.5,2.6,0,Math.PI*2);X.fill();X.stroke();

    // Archery target board
    let tgx=sx+12, tgy=sy+46;
    X.strokeStyle='#000000';X.lineWidth=1.5;
    X.beginPath();X.moveTo(tgx,tgy);X.lineTo(tgx,tgy-8);X.stroke();
    X.fillStyle=darken ? darkenColor('#fff') : '#fff';X.beginPath();X.arc(tgx,tgy-8,3.5,0,Math.PI*2);X.fill();X.stroke();
    X.fillStyle=darken ? darkenColor('#c00') : '#c00';X.beginPath();X.arc(tgx,tgy-8,1.5,0,Math.PI*2);X.fill();X.stroke();

    // Fence around front edges
    X.strokeStyle='#000000';X.lineWidth=1.5;
    X.beginPath();X.moveTo(sx,sy+64);X.lineTo(sx+32,sy+48);X.stroke();
    X.beginPath();X.moveTo(sx,sy+64);X.lineTo(sx-32,sy+48);X.stroke();
    X.beginPath();
    X.moveTo(sx,sy+64);X.lineTo(sx,sy+59);
    X.moveTo(sx+16,sy+56);X.lineTo(sx+16,sy+51);
    X.moveTo(sx-16,sy+56);X.lineTo(sx-16,sy+51);
    X.stroke();
  }
  else if(e.btype==='LCAMP'){
    bh=30;
    // Worn dirt clearing, enlarged past the tile so the oversized props
    // (log pile / ore cart) still sit on worked ground
    drawCampClearing(sx, sy+bhh-bhh*1.45, bw*1.45, bhh*1.45, darken);
    // Small plank shack in the back-right quadrant
    drawBuildingBlock(sx+14, sy+8, 20, 10, 14, '#b89868','#987848','peaked',8,'#8a6a48','#715539', darken);
    drawDoorLeft(sx+14, sy+8, 20, 10, '#5c3d24', darken);
    drawPennant(sx+14, sy+6, tc, darken);
    if(e.complete){
      let logCol=darken ? darkenColor('#6e473b') : '#6e473b';
      let endCol=darken ? darkenColor('#ebd2b0') : '#ebd2b0';
      X.strokeStyle='#000000';X.lineWidth=1.2;
      // Big log pile filling the front-left quadrant
      let lx=sx-20, ly=sy+bhh*1.0;
      [[0,8],[-5,0],[2,-7]].forEach(([dx,dy])=>{
        let x=lx+dx, y=ly+dy;
        X.fillStyle=logCol;X.fillRect(x-13,y-4,26,8);X.strokeRect(x-13,y-4,26,8);
        X.fillStyle=endCol;
        X.beginPath();X.ellipse(x-13,y,3.2,4,0,0,Math.PI*2);X.fill();X.stroke();
        X.beginPath();X.ellipse(x+13,y,3.2,4,0,0,Math.PI*2);X.fill();X.stroke();
        X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8;
        X.beginPath();X.arc(x+13,y,1.6,0,Math.PI*2);X.stroke();
        X.strokeStyle='#000';X.lineWidth=1.2;
      });
      // Chopping stump with an axe planted in it
      let cbx=sx+6, cby=sy+bhh*1.55;
      X.fillStyle=darken ? darkenColor('#8a5a3a') : '#8a5a3a';X.fillRect(cbx-5,cby-7,10,9);
      X.strokeRect(cbx-5,cby-7,10,9);
      X.fillStyle=endCol;X.beginPath();X.ellipse(cbx,cby-7,5,2.6,0,0,Math.PI*2);X.fill();X.stroke();
      // Axe: handle angled up-right, head buried in the stump face
      X.strokeStyle='#000';X.lineWidth=2.6;X.lineCap='round';
      X.beginPath();X.moveTo(cbx+1,cby-8);X.lineTo(cbx+8,cby-17);X.stroke();
      X.strokeStyle='#8B4513';X.lineWidth=1.3;
      X.beginPath();X.moveTo(cbx+1,cby-8);X.lineTo(cbx+8,cby-17);X.stroke();
      X.lineCap='butt';
      X.fillStyle=darken ? darkenColor('#b0b0b0') : '#b0b0b0';
      X.beginPath();X.moveTo(cbx+1,cby-8);X.lineTo(cbx-3,cby-11);X.lineTo(cbx-1,cby-5);X.closePath();
      X.fill();X.strokeStyle='#000';X.lineWidth=1;X.stroke();
    }
  }
  else if(e.btype==='MCAMP'){
    bh=30;
    // Worn dirt clearing, enlarged past the tile so the oversized props
    // (log pile / ore cart) still sit on worked ground
    drawCampClearing(sx, sy+bhh-bhh*1.45, bw*1.45, bhh*1.45, darken);
    // Dark timber mine shed in the back-right quadrant
    drawBuildingBlock(sx+14, sy+8, 20, 10, 12, '#7a6a55','#635546','peaked',7,'#55483a','#463b2f', darken);
    drawDoorLeft(sx+14, sy+8, 20, 10, '#2e2519', darken);
    drawPennant(sx+14, sy+7, tc, darken);
    if(e.complete){
      X.strokeStyle='#000000';X.lineWidth=1.2;
      // Ore cart heaped with gold in the front-left quadrant
      let mx=sx-18, my=sy+bhh*1.15;
      // Ore heap first (behind the cart's front wall)
      let gcol=darken ? darkenColor('#e8b90f') : '#e8b90f';
      let gtop=darken ? darkenColor('#ffe14d') : '#ffe14d';
      [[-4,-9],[0,-11],[4,-9],[-2,-7],[3,-6]].forEach(([dx,dy])=>{
        X.fillStyle=gcol;X.beginPath();X.arc(mx+dx,my+dy,3,0,Math.PI*2);X.fill();X.stroke();
        X.fillStyle=gtop;X.beginPath();X.arc(mx+dx-1,my+dy-1,1.3,0,Math.PI*2);X.fill();
      });
      // Cart body (inverted trapezoid) with plank lines
      X.fillStyle=darken ? darkenColor('#6e5138') : '#6e5138';
      X.beginPath();X.moveTo(mx-10,my-8);X.lineTo(mx+10,my-8);X.lineTo(mx+7,my+1);X.lineTo(mx-7,my+1);X.closePath();
      X.fill();X.stroke();
      X.strokeStyle='rgba(0,0,0,0.3)';X.lineWidth=0.9;
      X.beginPath();X.moveTo(mx-9,my-5);X.lineTo(mx+9,my-5);X.stroke();
      X.beginPath();X.moveTo(mx-8,my-2);X.lineTo(mx+8,my-2);X.stroke();
      X.strokeStyle='#000';X.lineWidth=1.2;
      // Wheels
      X.fillStyle=darken ? darkenColor('#3a2f24') : '#3a2f24';
      X.beginPath();X.arc(mx-5,my+2.5,2.6,0,Math.PI*2);X.fill();X.stroke();
      X.beginPath();X.arc(mx+5,my+2.5,2.6,0,Math.PI*2);X.fill();X.stroke();
      // Stone boulder pile beside the cart
      let scol=darken ? darkenColor('#8b8b8b') : '#8b8b8b';
      let scol2=darken ? darkenColor('#9a9a9a') : '#9a9a9a';
      X.fillStyle=scol;X.beginPath();X.arc(sx+2,sy+bhh*1.55,5.5,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle=scol2;X.beginPath();X.arc(sx+9,sy+bhh*1.45,4,0,Math.PI*2);X.fill();X.stroke();
    }
  }
  else if(e.btype==='MILL'){
    bh=52; // tapered tower (36) + conical cap (16)
    let by = sy + bhh*0.55;           // base diamond top corner
    let W0 = bw*0.75, W1 = bw*0.55;   // half-width at the base / top (taper)
    let hh0 = W0*0.5, hh1 = W1*0.5;   // 2:1 iso front-corner drops
    let H = 36, ty = by - H;
    let wl = darken?darkenColor('#dcd0a0'):'#dcd0a0';
    let wr = darken?darkenColor('#bca880'):'#bca880';
    X.strokeStyle='#000';X.lineWidth=1.3;X.lineJoin='round';
    // Tapered left/right faces
    X.fillStyle=wl;X.beginPath();
    X.moveTo(sx-W0,by);X.lineTo(sx,by+hh0);X.lineTo(sx,ty+hh1);X.lineTo(sx-W1,ty);X.closePath();X.fill();X.stroke();
    X.fillStyle=wr;X.beginPath();
    X.moveTo(sx,by+hh0);X.lineTo(sx+W0,by);X.lineTo(sx+W1,ty);X.lineTo(sx,ty+hh1);X.closePath();X.fill();X.stroke();
    // Plank courses following the taper
    X.strokeStyle='rgba(0,0,0,0.13)';X.lineWidth=1;
    for(let t of [0.22,0.44,0.66,0.88]){
      let rw = W0+(W1-W0)*t;
      let ey = by+(ty-by)*t;                       // edge corner y at this height
      let fy2 = (by+hh0)+((ty+hh1)-(by+hh0))*t;    // front corner y at this height
      X.beginPath();X.moveTo(sx-rw,ey);X.lineTo(sx,fy2);X.lineTo(sx+rw,ey);X.stroke();
    }
    // Door on the front-left face
    let dA={x:sx-W0*0.55, y:by+hh0*0.5}, dB={x:sx-W0*0.15, y:by+hh0*0.86};
    X.fillStyle=darken?darkenColor('#5c3d24'):'#5c3d24';
    X.strokeStyle='#000';X.lineWidth=1;
    X.beginPath();X.moveTo(dA.x,dA.y);X.lineTo(dB.x,dB.y);
    X.lineTo(dB.x,dB.y-9);X.lineTo(dA.x,dA.y-9);X.closePath();X.fill();X.stroke();
    // Conical shingled cap with a small overhang
    let capH=18, ov=3;
    let cl=darken?darkenColor('#a65c3b'):'#a65c3b', cr=darken?darkenColor('#863c20'):'#863c20';
    X.strokeStyle='#000';X.lineWidth=1.3;
    X.fillStyle=cl;X.beginPath();
    X.moveTo(sx,ty-capH);X.lineTo(sx-W1-ov,ty);X.lineTo(sx,ty+hh1+ov*0.5);X.closePath();X.fill();X.stroke();
    X.fillStyle=cr;X.beginPath();
    X.moveTo(sx,ty-capH);X.lineTo(sx+W1+ov,ty);X.lineTo(sx,ty+hh1+ov*0.5);X.closePath();X.fill();X.stroke();
    // Team pennant at the apex
    drawPennant(sx,ty-capH,tc,darken);
    // Sails & flour sacks
    if(e.complete){
      if(visible) drawWindmillSails(sx, ty+hh1, e.id); // hub on the cap's front face center

      // Flour sacks piled at the base
      let fx = sx+W0*0.55, fy = by+hh0*0.9;
      X.strokeStyle='#000000';X.lineWidth=1;
      X.fillStyle=darken ? darkenColor('#e5dcd0') : '#e5dcd0';X.beginPath();X.ellipse(fx,fy,4,3,0,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle=darken ? darkenColor('#c8bdae') : '#c8bdae';X.beginPath();X.ellipse(fx,fy-2,3,2,0,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle=darken ? darkenColor('#d5ccbe') : '#d5ccbe';X.beginPath();X.ellipse(fx-5,fy+2,4,3,0,0,Math.PI*2);X.fill();X.stroke();
    }
  }
  else if(e.btype==='TOWER'){
    bh=36;
    let linkY = sy + 16;
    let wallH = 14;

    // Castle Age Watch Tower — 3 stacked blocks. Base is shifted so its
    // front-bottom vertex lands on linkY (sy+16), same as wall pillars,
    // so the wall link's near edge meets the tower with no gap. Drawn
    // before the links (like WALL's pillar) since the links extend
    // toward the viewer and should overlap the tower's base, not be
    // hidden behind it.
    drawBuildingBlock(sx, sy+2+7, 14, 7, 30, '#c8c0ae', '#a89f8d', 'flat', 0, '#b0b0a4', '#989890', darken);
    drawBuildingBlock(sx, sy+2-22, 16, 8, 6, '#b89868', '#987848', 'flat', 0, '#a08050', '#806030', darken);
    drawBuildingBlock(sx, sy+2-28, 12, 6, 8, '#c8c0ae', '#a89f8d', 'peaked', 6, tc, tcD, darken);

    // South and East links can both originate from this same corner
    // point, same as GATE's front post (which also has two links
    // diverging from one vertex) — use d1=8 there too so the two stubs
    // clear each other instead of clipping at the shared vertex.
    // South neighbor (y+1)
    if (isWallLike(getConnectedBuilding(e.x, e.y + 1))) {
      drawWallLink(sx, linkY, -32, 16, wallH, darken, 8);
    }

    // East neighbor (x+1)
    if (isWallLike(getConnectedBuilding(e.x + 1, e.y))) {
      drawWallLink(sx, linkY, 32, 16, wallH, darken, 8);
    }

    if (e.complete && visible) drawWavingFlag(sx, sy+2, 40, tc, tcD);
  }
  else if(e.btype==='WALL'){
    bh=14;
    let pillarH = 22;
    let wallH = 14;   // lower than pillar to create bastion crenellated effect
    let linkY = sy + 16;

    // 1. Draw central pillar first (centered concentrically at sy+16)
    // Colors match drawWallLink's palette so the pillar reads as part of
    // the same wall run instead of a separately-shaded block; top is a
    // single flat color rather than a two-tone faceted cap.
    drawBuildingBlock(sx, sy+11, 9, 4.5, pillarH, '#cfc8b6', '#aca392', 'flat', 0, '#b7ad97', '#b7ad97', darken);

    // 2. Draw South and East links second (running towards the front, overlapping the pillar)
    // South neighbor (y+1)
    if (isWallLike(getConnectedBuilding(e.x, e.y + 1))) {
      drawWallLink(sx, linkY, -32, 16, wallH, darken);
    }

    // East neighbor (x+1)
    if (isWallLike(getConnectedBuilding(e.x + 1, e.y))) {
      drawWallLink(sx, linkY, 32, 16, wallH, darken);
    }
  }

  else if(e.btype==='GATE'){
    let pillarH = 28;
    bh = pillarH;
    let t1sx, t1sy, t2sx, t2sy;
    let sx_center, sy_center;
    let wallLineNS = e.h > e.w;

    if (wallLineNS) {
      // N-S Gate (footprint 1x2) - NE-SW direction
      t1sx = sx; t1sy = sy + 16;
      t2sx = sx - 32; t2sy = sy + 32;
      sx_center = sx - 16; sy_center = sy + 24;
    } else {
      // E-W Gate (footprint 2x1) - NW-SE direction
      t1sx = sx; t1sy = sy + 16;
      t2sx = sx + 32; t2sy = sy + 32;
      sx_center = sx + 16; sy_center = sy + 24;
    }

    let dx = t2sx - t1sx, dy = t2sy - t1sy;
    let gp = visible ? (e.gateProgress || 0) : 0; // frozen closed in shroud
    let slideY = gp * 26;

    if (part === 'back' || part === null) {
      // 1. Draw back post (Tower 1 - larger bastion centered at t1sy-7)
      drawBuildingBlock(t1sx, t1sy - 7, 14, 7, pillarH, '#c8c0ae', '#a89f8d', 'flat', 0, '#b0b0a4', '#b0b0a4', darken);

      // Draw battlements (merlons) on Tower 1 top
      drawBastionMerlons(t1sx, t1sy, '#b0b0a4', '#b0b0a4', darken);

      if (e.complete) {
        // Sliding solid wood gate door — same style/placement as a wall
        // extension (drawWallLink), just wood-brown and sliding up into
        // the bastion as gateProgress goes from closed (0) to open (1).
        drawWallLink(t1sx, t1sy - slideY, dx, dy, 20, darken, 7, 0, '#8b5a2b', '#a5723a', 2, true);
      }

      // 1. Draw connection links for Post 1 (back post centered at t1sy)
      let wallH = 14;
      if (wallLineNS) {
        // N-S Gate: Post 1 is at (e.x, e.y). Perpendicular connection goes East (x+1).
        if (isWallLike(getConnectedBuilding(e.x + 1, e.y))) {
          drawWallLink(t1sx, t1sy, 32, 16, wallH, darken);
        }
      } else {
        // E-W Gate: Post 1 is at (e.x, e.y). Perpendicular connection goes South (y+1).
        if (isWallLike(getConnectedBuilding(e.x, e.y + 1))) {
          drawWallLink(t1sx, t1sy, -32, 16, wallH, darken);
        }
      }

      if (part === 'back') {
        X.globalAlpha = 1;
        return;
      }
    }

    if (part === 'front' || part === null) {
      // 2. Draw front post (Tower 2 - larger bastion centered at t2sy-7)
      drawBuildingBlock(t2sx, t2sy - 7, 14, 7, pillarH, '#c8c0ae', '#a89f8d', 'flat', 0, '#b0b0a4', '#b0b0a4', darken);

      // Draw battlements (merlons) on Tower 2 top
      drawBastionMerlons(t2sx, t2sy, '#b0b0a4', '#989890', darken);

      // Draw connection links for Post 2 (front post centered at t2sy)
      let wallH = 14;
      if (wallLineNS) {
        // N-S Gate: Post 2 is at (e.x, e.y+1). Parallel connection goes South (y+2), Perpendicular goes East (x+1, y+1).
        if (isWallLike(getConnectedBuilding(e.x, e.y + 2))) {
          drawWallLink(t2sx, t2sy, -32, 16, wallH, darken, 8);
        }
        if (isWallLike(getConnectedBuilding(e.x + 1, e.y + 1))) {
          drawWallLink(t2sx, t2sy, 32, 16, wallH, darken, 8);
        }
      } else {
        // E-W Gate: Post 2 is at (e.x+1, e.y). Parallel connection goes East (x+2, y), Perpendicular goes South (x+1, y+1).
        if (isWallLike(getConnectedBuilding(e.x + 2, e.y))) {
          drawWallLink(t2sx, t2sy, 32, 16, wallH, darken, 8);
        }
        if (isWallLike(getConnectedBuilding(e.x + 1, e.y + 1))) {
          drawWallLink(t2sx, t2sy, -32, 16, wallH, darken, 8);
        }
      }
    }
  }
  else if(e.btype==='FARM'){
    bh=0;
    let tileRes=map[e.y]&&map[e.y][e.x]?map[e.y][e.x].res:0;
    let growth=tileRes/(e.maxFood||300);
    // Footprint diamond corners
    let cT={x:sx,y:sy}, cR={x:sx+bw,y:sy+bhh}, cB={x:sx,y:sy+bhh*2}, cL={x:sx-bw,y:sy+bhh};
    // Tilled soil bed covering the footprint
    X.fillStyle = darken?darkenColor('#7a5a38'):'#7a5a38';
    X.beginPath();X.moveTo(cT.x,cT.y);X.lineTo(cR.x,cR.y);X.lineTo(cB.x,cB.y);X.lineTo(cL.x,cL.y);X.closePath();X.fill();
    X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=1.2;X.stroke();
    // Furrows parallel to the top-right edge
    let rows=[0.2,0.4,0.6,0.8];
    let rowEnds=t=>[
      {x:cT.x+(cL.x-cT.x)*t, y:cT.y+(cL.y-cT.y)*t},
      {x:cR.x+(cB.x-cR.x)*t, y:cR.y+(cB.y-cR.y)*t}
    ];
    X.strokeStyle='rgba(0,0,0,0.18)';X.lineWidth=1.2;
    rows.forEach(t=>{
      let [a,b2]=rowEnds(t);
      X.beginPath();X.moveTo(a.x,a.y);X.lineTo(b2.x,b2.y);X.stroke();
    });
    if(growth>0 && !e.exhausted){
      // Wheat planted in rows along the furrows: green sprouts that grow
      // into tall golden stalks with grain heads as the field ripens.
      let cropH=2+growth*7;
      let ripe=growth>0.55;
      let stalkCol = ripe ? '#c9a227' : '#6fa03a';
      let headCol  = ripe ? '#e8c84a' : '#8fbf55';
      if(darken){ stalkCol=darkenColor(stalkCol); headCol=darkenColor(headCol); }
      rows.forEach((t,ri)=>{
        let [a,b2]=rowEnds(t);
        for(let i=1;i<=4;i++){
          let u=i/5+((ri%2)?0.05:-0.05);
          let px=a.x+(b2.x-a.x)*u, py=a.y+(b2.y-a.y)*u;
          X.strokeStyle=stalkCol;X.lineWidth=1.4;
          X.beginPath();X.moveTo(px,py);X.lineTo(px,py-cropH);X.stroke();
          X.beginPath();X.moveTo(px,py);X.lineTo(px-2,py-cropH*0.75);X.stroke();
          X.beginPath();X.moveTo(px,py);X.lineTo(px+2,py-cropH*0.75);X.stroke();
          if(growth>0.3){
            X.fillStyle=headCol;
            X.beginPath();X.ellipse(px,py-cropH,1.3,2.0,0,0,Math.PI*2);X.fill();
            X.strokeStyle='rgba(0,0,0,0.5)';X.lineWidth=0.7;X.stroke();
          }
        }
      });
    } else {
      // Withered, exhausted stalks slumped along the furrows
      X.strokeStyle = darken ? '#251e16' : '#3f2f22';X.lineWidth=1.0;
      rows.forEach((t,ri)=>{
        let [a,b2]=rowEnds(t);
        for(let i=1;i<=3;i++){
          let u=i/4+((ri%2)?0.06:-0.06);
          let px=a.x+(b2.x-a.x)*u, py=a.y+(b2.y-a.y)*u;
          X.beginPath();X.moveTo(px,py);X.lineTo(px+3,py-3);X.stroke();
        }
      });
    }
    // Low fence posts at the corners
    let pc = darken?darkenColor('#6e4f33'):'#6e4f33';
    [cT,cR,cB,cL].forEach(c=>{
      X.strokeStyle='#000';X.lineWidth=2.6;X.lineCap='round';
      X.beginPath();X.moveTo(c.x,c.y);X.lineTo(c.x,c.y-5);X.stroke();
      X.strokeStyle=pc;X.lineWidth=1.3;
      X.beginPath();X.moveTo(c.x,c.y);X.lineTo(c.x,c.y-5);X.stroke();
      X.lineCap='butt';
    });
  }

  X.globalAlpha=1;

  // Progress bars, HP, selection — only when actively visible (not in fog)
  if (!window._ghostDraw && (f === 2 || e.team === 0)) {
  // Construction Progress Bar
  if(!e.complete){
    let bww=b.w*24;
    let pct=e.buildProgress/e.buildTime;
    X.fillStyle='#000000';X.fillRect(sx-bww/2-1,sy-bh-15,bww+2,6); // black border box
    X.fillStyle='#5c1505';X.fillRect(sx-bww/2,sy-bh-14,bww,4);
    X.fillStyle='#00ffff';X.fillRect(sx-bww/2,sy-bh-14,bww*pct,4);
  }

  // HP bar — shift up by 8px when the construction bar is also showing to avoid overlap
  if(e.hp<e.maxHp&&bh>0){
    let bww=b.w*24;
    let hpY=!e.complete?sy-bh-19:sy-bh-11;
    X.fillStyle='#000000';X.fillRect(sx-bww/2-1,hpY,bww+2,6); // black border box
    X.fillStyle='#300';X.fillRect(sx-bww/2,hpY+1,bww,4);
    X.fillStyle=e.hp/e.maxHp>0.5?'#0c0':'#c00';X.fillRect(sx-bww/2,hpY+1,bww*e.hp/e.maxHp,4);
  }
  // Selection — outlines the entity's actual footprint (e.w/e.h), not the
  // building type's default template size, so multi-tile footprints that
  // differ from the template (e.g. a 1x2/2x1 GATE vs BLDGS.GATE's 1x1)
  // still get an outline spanning every tile they occupy.
  if(selected.includes(e)){
    X.strokeStyle='#fff';X.lineWidth=2;X.setLineDash([3,3]);
    let fw=e.w||b.w, fh=e.h||b.h;
    let toScr=(wx,wy)=>{let p=toIso(wx,wy);return{x:p.ix-camX+W/2,y:p.iy-camY+topH+H/2};};
    let pN=toScr(e.x,e.y), pE=toScr(e.x+fw,e.y), pS=toScr(e.x+fw,e.y+fh), pW=toScr(e.x,e.y+fh);
    X.beginPath();
    X.moveTo(pN.x,pN.y);X.lineTo(pE.x+2,pE.y);X.lineTo(pS.x,pS.y+2);X.lineTo(pW.x-2,pW.y);X.closePath();X.stroke();
    X.setLineDash([]);
  }
  // Train progress
  if(e.queue&&e.queue.length>0){
    let pct=e.trainTick/(UNITS[e.queue[0]].trainTime);
    let bww=b.w*24;
    X.fillStyle='#000000';X.fillRect(sx-bww/2-1,sy+bhh*2+3,bww+2,5); // black border box
    X.fillStyle='#003';X.fillRect(sx-bww/2,sy+bhh*2+4,bww,3);
    X.fillStyle='#0af';X.fillRect(sx-bww/2,sy+bhh*2+4,bww*pct,3);
  }
  } // end fog-aware UI
}



// Big readable broadsword, drawn with the context translated to the grip.
// Combat swing is shaped: slow overhead wind-up, fast slash (like the
// villagers' work swing) instead of a symmetric sine wobble.
function drawBigSword(swinging, id){
  if(swinging){
    let ph=((tick*0.07+id*0.4)%1+1)%1;
    let u=ph<0.72?ph/0.72:1-(ph-0.72)/0.28;
    X.rotate(0.9-2.1*u);
  } else X.rotate(0.5); // rest: blade leans outward, away from the head
  X.strokeStyle='#000';X.lineWidth=1.2;X.lineJoin='round';
  // Grip and pommel
  X.fillStyle='#6a4a20';X.beginPath();X.rect(-1.5,0,4,6);X.fill();X.stroke();
  X.fillStyle='#e8c84a';X.beginPath();X.arc(0.5,6.8,1.6,0,Math.PI*2);X.fill();X.stroke();
  // Wide crossguard
  X.fillStyle='#e8c84a';X.beginPath();X.rect(-4.5,-2,10,2.6);X.fill();X.stroke();
  // Broad blade with a bright fuller
  X.fillStyle='#dde3ea';
  X.beginPath();X.moveTo(-2.4,-2);X.lineTo(0.5,-22);X.lineTo(3.4,-2);X.closePath();X.fill();X.stroke();
  X.fillStyle='#fff';X.beginPath();X.rect(0,-18.5,1.3,13);X.fill();
}

function drawCorpse(c){
  let iso=toIso(c.x,c.y);
  let sx=Math.round(iso.ix-camX+W/2), sy=Math.round(iso.iy-camY+topH+H/2+HALF_TH);
  if(isOffscreen(sx,sy,50))return;
  
  let { ox, oy } = getUnitGroupOffset(c.id);
  sx += ox; sy += oy;
  let tc=TEAM_COLORS[c.team];
  
  let age = performance.now() - c.deathTime;
  let alpha = Math.max(0, 1 - age / 5000);
  
  X.save();
  X.globalAlpha = alpha;
  
  // 1. Blood pool under the collapsed corpse
  X.fillStyle = 'rgba(120, 0, 0, 0.7)';
  X.beginPath();
  X.ellipse(sx, sy + 3, 9, 4.5, 0, 0, Math.PI * 2);
  X.fill();
  
  // 2. Rotate corpse flat on the ground plane
  X.translate(sx, sy);
  X.scale(c.facing, 1);
  X.rotate(Math.PI / 2.25);
  
  // Render flattened body parts
  if(c.utype==='militia'){
    X.fillStyle='#6b6b6b';
    X.beginPath();X.arc(0,-3,4,0,Math.PI*2);X.fill();
    X.fillStyle=tc;
    X.fillRect(-2,-6,4,6);
  } else {
    X.fillStyle=tc;
    X.beginPath();X.arc(0,-3,4,0,Math.PI*2);X.fill();
    X.fillStyle='#5c3d24';
    X.fillRect(-2,-5,4,4);
  }
  // Head
  X.fillStyle='#edc9a0';
  X.beginPath();X.arc(0,-9,3.2,0,Math.PI*2);X.fill();
  // Headwear
  if(c.utype==='militia'){
    X.fillStyle='#8a8a8a';
    X.beginPath();X.arc(0,-10,3.6,Math.PI,0);X.fill();
  } else {
    X.fillStyle='#4a2e1b';
    X.beginPath();X.arc(0,-10,3.6,Math.PI,0);X.fill();
  }
  
  // Dropped weapons next to corpse
  X.strokeStyle='#5c3d24';X.lineWidth=1.5;
  X.beginPath();X.moveTo(3,-2);X.lineTo(8,1);X.stroke();
  
  X.restore();
}

function drawUnit(e){
  let iso=toIso(e.x,e.y);
  let sx=Math.round(iso.ix-camX+W/2), sy=Math.round(iso.iy-camY+topH+H/2+HALF_TH);
  if(isOffscreen(sx,sy,50))return;
  // Group spread: offset based on unit ID so stacked units are visible
  let { ox, oy } = getUnitGroupOffset(e.id);
  sx += ox; sy += oy;
  let tc=TEAM_COLORS[e.team];
  let anim=Math.sin(tick*0.15+e.id*2);
  let isActive=e.task||e.target||e.path.length>0;

  // Shadow
  X.fillStyle='rgba(0,0,0,0.3)';
  X.beginPath();X.ellipse(sx,sy+2,6,3,0,0,Math.PI*2);X.fill();

  // Smart Face Direction: defaults to right, automatically flips based on movement or target location
  if(e.facing===undefined) e.facing = 1;
  let targetDx = 0;
  let tx = -1, ty = -1;
  if(e.target){
    let t = entities.find(en => en.id === e.target);
    if(t) { tx = t.x; ty = t.y; }
  } else if(e.buildTarget){
    let t = entities.find(en => en.id === e.buildTarget);
    if(t) { tx = t.x; ty = t.y; }
  } else if(e.gatherX !== undefined && e.gatherY !== undefined && e.task && e.task !== 'return'){
    tx = e.gatherX + 0.5;
    ty = e.gatherY + 0.5;
  } else if(e.path && e.path.length > 0){
    // Look 3 steps ahead to smooth out diagonal paths that alternate N+E or S+W steps
    let ahead = Math.min(3, e.path.length - 1);
    tx = e.path[ahead].x;
    ty = e.path[ahead].y;
  }
  if(e.facingNorth===undefined) e.facingNorth = false;
  let dx = 0, dy = 0;
  if(tx !== -1 && ty !== -1){
    dx = tx - e.x;
    dy = ty - e.y;
  } else if(e.lastX!==undefined && e.lastY!==undefined){
    let diffX = e.x - e.lastX;
    let diffY = e.y - e.lastY;
    if (Math.abs(diffX) > 0.005 || Math.abs(diffY) > 0.005) {
      dx = diffX;
      dy = diffY;
    }
  }
  if(dx !== 0 || dy !== 0){
    let angle = Math.atan2(dy, dx);
    let dir = Math.round(angle / (Math.PI / 4));
    if (dir < 0) dir += 8;
    dir = dir % 8;
    e.dir = dir;

    // Map 8-direction index (0: SE, 1: S, 2: SW, 3: W, 4: NW, 5: N, 6: NE, 7: E) to quadrants:
    if (dir === 0 || dir === 1 || dir === 7) {
      e.facing = 1; e.facingNorth = false; // SE, S, E (facing front-right)
    } else if (dir === 2 || dir === 3) {
      e.facing = -1; e.facingNorth = false; // SW, W (facing front-left)
    } else if (dir === 4) {
      e.facing = -1; e.facingNorth = true; // NW (facing back-left)
    } else if (dir === 5 || dir === 6) {
      e.facing = 1; e.facingNorth = true; // N, NE (facing back-right)
    }
  }
  e.lastX = e.x;
  e.lastY = e.y;

  // Torso / Head bobbing
  let bob=e.path.length>0?Math.sin(tick*0.3+e.id)*1.5:0;
  let sbob=e.path.length>0?Math.sin(tick*0.2+e.id)*1:0;

  // Save context and apply horizontal flipping based on facing direction
  X.save();
  if(e.utype==='sheep') X.translate(sx, sy + sbob);
  else if(e.utype==='sheep_carcass') X.translate(sx, sy);
  else X.translate(sx, sy + bob);
  X.scale(e.facing, 1);

  // --- DRAW FLIPPABLE STUFF ---
  if(e.utype==='sheep_carcass'){
    let dt = performance.now() - (e.deathTime || 0);
    let duration = 750; // 0.75 seconds collapse
    if(dt < duration){
      let progress = dt / duration;
      
      X.save();
      X.translate(0, progress * 4.5);
      X.rotate(progress * (Math.PI / 2.2));
      
      // Draw 4 legs twitching/kicking
      let legKick = Math.sin(tick * 0.7 + e.id) * 3 * (1 - progress);
      X.strokeStyle='#000000'; X.lineWidth=1.8;
      X.beginPath();
      X.moveTo(-4, 0); X.lineTo(-4 + legKick, 5 * (1 - progress));
      X.moveTo(-1, 1); X.lineTo(-1 - legKick, 5 * (1 - progress));
      X.moveTo(2, 1);  X.lineTo(2  + legKick, 5 * (1 - progress));
      X.moveTo(5, 0);  X.lineTo(5  - legKick, 5 * (1 - progress));
      X.stroke();

      // Fluffy wool body
      X.fillStyle='#000000';
      X.beginPath();X.arc(-4,-3,5,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(4,-3,5,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(0,-6,5.5,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(0,-1,5.5,0,Math.PI*2);X.fill();
      
      X.fillStyle='#f2eddd';
      X.beginPath();X.arc(-4,-3,4,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(4,-3,4,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(0,-6,4.5,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(0,-1,4.5,0,Math.PI*2);X.fill();

      // Head falling
      let headX = 6, headY = -3 + progress * 4.5;
      let earX = 7, earY = -5 + progress * 4.5;
      X.fillStyle='#333';
      X.beginPath();X.arc(headX,headY,2.5,0,Math.PI*2);X.fill();
      X.strokeStyle='#000000';X.lineWidth=1;X.stroke();
      X.fillStyle='#e0d8c0';
      X.beginPath();X.arc(earX,earY,1.1,0,Math.PI*2);X.fill();X.stroke();
      
      X.restore();
      X.restore();
      return;
    }

    // --- FULLY COLLAPSED ROUND CARCASS ---
    X.save();
    X.translate(0, 3.5);

    // Tail dropped to ground
    X.save();
    X.translate(-8, -1.0);
    X.rotate(-0.5);
    X.fillStyle = '#000000';
    X.beginPath(); X.ellipse(-2, 0, 3, 2, 0, 0, Math.PI*2); X.fill();
    X.fillStyle = '#f2eddd';
    X.beginPath(); X.ellipse(-2, 0, 2, 1.2, 0, 0, Math.PI*2); X.fill();
    X.restore();

    // Round fluffy wool body (identical to live sheep, but no legs)
    X.fillStyle='#000000';
    X.beginPath();X.arc(-4,-3,5,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(4,-3,5,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(0,-6,5.5,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(0,-1,5.5,0,Math.PI*2);X.fill();
    
    X.fillStyle='#e8e2d2'; // slightly dirtier/darker wool for carcass
    X.beginPath();X.arc(-4,-3,4,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(4,-3,4,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(0,-6,4.5,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(0,-1,4.5,0,Math.PI*2);X.fill();

    // Head dropped flat to ground
    let headX = 6, headY = 1.0;
    let earX = 7, earY = -0.5;

    // Team bandana just below head
    X.fillStyle = tc;
    X.beginPath(); X.ellipse(headX, headY + 3, 3, 1.8, 0, 0, Math.PI*2); X.fill();

    X.fillStyle='#333';
    X.beginPath();X.arc(headX,headY,2.5,0,Math.PI*2);X.fill();
    X.strokeStyle='#000000';X.lineWidth=1;X.stroke();
    X.fillStyle='#e0d8c0';
    X.beginPath();X.arc(earX,earY,1.1,0,Math.PI*2);X.fill();X.stroke();

    // Partially eaten raw meat/ribs in the center of the round wool body
    let foodPct = e.hp / e.maxHp;
    if(foodPct < 0.75){
      X.fillStyle='#c84b4b'; // raw meat
      X.beginPath();X.ellipse(0, -3.5, 4.2 * (1 - foodPct), 2.8 * (1 - foodPct), 0, 0, Math.PI*2);X.fill();
      X.strokeStyle='#000000';X.lineWidth=0.85;X.stroke();
      
      if(foodPct < 0.4){
        X.strokeStyle='#ffffff';X.lineWidth=1.1;
        X.beginPath();X.moveTo(-1.2, -5);X.lineTo(-1.2, -2);X.stroke();
        X.beginPath();X.moveTo(1.2, -5.5);X.lineTo(1.2, -2.5);X.stroke();
      }
    }
    
    X.restore();
    X.restore();
    return;
  } else if(e.utype!=='sheep'){
    let humanXOffset = e.utype === 'scout' ? -3 : 0;
    let humanYOffset = e.utype === 'scout' ? -11 : 0;

    // Walking leg cycle (swinging legs with constant leg length)
    if(e.utype==='scout'){
      let walk = e.path.length>0 ? Math.sin(tick*0.45+e.id)*4.5 : 0;
      X.save(); X.translate(0,-1); X.scale(1.35,1.35); // horse is drawn larger than the rider grid
      X.beginPath();
      
      let useDir = e.dir;
      if (e.facing === -1) {
        if (e.dir === 2) useDir = 0;      // SW -> SE
        else if (e.dir === 3) useDir = 7; // W -> E
        else if (e.dir === 4) useDir = 6; // NW -> NE
      }
      
      if (useDir === 1 || useDir === 5) {
        // South / North: Centered legs
        // Front pair
        X.moveTo(-3, -4); X.lineTo(-3, 4.4 + walk);
        X.moveTo(3, -4); X.lineTo(3, 4.4 - walk);
        // Back pair
        X.moveTo(-4.5, -4); X.lineTo(-4.5, 3.4 - walk);
        X.moveTo(4.5, -4); X.lineTo(4.5, 3.4 + walk);
      } else if (useDir === 7) {
        // East (Profile)
        X.moveTo(3.5, -4); X.lineTo(3.5 + walk, 4.4);
        X.moveTo(5.5, -4); X.lineTo(5.5 - walk, 4.4);
        X.moveTo(-4.5, -4); X.lineTo(-4.5 + walk, 4.4);
        X.moveTo(-6.5, -4); X.lineTo(-6.5 - walk, 4.4);
      } else {
        // Southeast / Northeast (Diagonal)
        X.moveTo(2.8, -4); X.lineTo(2.8 + walk, 4.4);
        X.moveTo(4.6, -4); X.lineTo(4.6 - walk, 4.4);
        X.moveTo(-3.8, -4); X.lineTo(-3.8 + walk, 4.4);
        X.moveTo(-5.6, -4); X.lineTo(-5.6 - walk, 4.4);
      }
      X.strokeStyle = '#000000'; X.lineWidth = 3.0; X.lineCap='round'; X.stroke();
      X.strokeStyle = '#6e4520'; X.lineWidth = 1.5; X.stroke();
      X.lineCap='butt';
      // Hooves: dark caps at each leg endpoint
      let hoofPts;
      if (useDir === 1 || useDir === 5) hoofPts=[[-3,4.4+walk],[3,4.4-walk],[-4.5,3.4-walk],[4.5,3.4+walk]];
      else if (useDir === 7) hoofPts=[[3.5+walk,4.4],[5.5-walk,4.4],[-4.5+walk,4.4],[-6.5-walk,4.4]];
      else hoofPts=[[2.8+walk,4.4],[4.6-walk,4.4],[-3.8+walk,4.4],[-5.6-walk,4.4]];
      X.fillStyle='#241408';
      hoofPts.forEach(p=>{X.beginPath();X.ellipse(p[0],p[1]+0.5,1.5,1.1,0,0,Math.PI*2);X.fill();});
      X.restore();
    } else {
      // Human legs (visible both when standing and walking)
        let walk = e.path.length>0 ? Math.sin(tick*0.4+e.id)*2.5 : 0;
      X.beginPath();
      X.moveTo(-2+humanXOffset, -bob); X.lineTo(-2-walk+humanXOffset, 3-bob);
      X.moveTo(2+humanXOffset, -bob); X.lineTo(2+walk+humanXOffset, 3-bob);
      X.strokeStyle = '#000000'; X.lineWidth = 3.0; X.lineCap='round'; X.stroke();
      X.strokeStyle = '#5b3a1e'; X.lineWidth = 1.5; X.stroke();
      // Boots
      X.fillStyle='#3a2412';
      X.beginPath();X.arc(-2-walk+humanXOffset,3.4-bob,1.4,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(2+walk+humanXOffset,3.4-bob,1.4,0,Math.PI*2);X.fill();
      X.lineCap='butt';
    }
    // When the horse faces the camera its head hangs in front of the
    // rider, so that part is deferred and drawn after the rider.
    let horseHeadFront = null;

    // Horse drawn under the rider. The neck+head are one arched silhouette
    // (curved crest, jaw, squared muzzle) — the key to reading "horse" at
    // icon size. Idle horses nod gently, swish their tail and flick an ear.
    if(e.utype==='scout'){
      let useDir = e.dir;
      if (e.facing === -1) {
        if (e.dir === 2) useDir = 0;      // SW -> SE
        else if (e.dir === 3) useDir = 7; // W -> E
        else if (e.dir === 4) useDir = 6; // NW -> NE
      }
      const coat='#8b5a2b', maneC='#3f2810';
      let idle = e.path.length===0;
      let nod = idle ? Math.sin(tick*0.05+e.id)*0.8 : 0;
      let swish = Math.sin(tick*0.08+e.id)*(idle?0.2:0.08);
      X.save(); X.translate(0,-1); X.scale(1.35,1.35); // match the enlarged legs
      const ear=(x,y,ang)=>{ X.save(); X.translate(x,y); X.rotate(ang);
        X.beginPath(); X.moveTo(-1.2,0.6); X.lineTo(0,-2.8); X.lineTo(1.2,0.6); X.closePath();
        X.fillStyle=coat; X.strokeStyle='#000'; X.lineWidth=1.2; X.fill(); X.stroke(); X.restore(); };
      X.strokeStyle='#000'; X.lineWidth=1.2;

      if (useDir === 7 || useDir === 0) {
        // East profile / Southeast diagonal (same construction, SE compressed)
        let k = useDir === 7 ? 1 : 0.85;
        // Swishing tail
        X.save(); X.translate(-6.6*k,-7); X.rotate(swish);
        X.beginPath(); X.moveTo(0,0); X.quadraticCurveTo(-2.7*k,3,-2.2*k,9);
        X.strokeStyle='#000'; X.lineWidth=3.4; X.lineCap='round'; X.stroke();
        X.strokeStyle=maneC; X.lineWidth=1.8; X.stroke(); X.lineCap='butt';
        X.restore();
        // Body capsule
        X.strokeStyle='#000'; X.lineWidth=1.2; X.fillStyle=coat;
        X.beginPath(); X.ellipse(0,-6,7.4*k,4.9,0,0,Math.PI*2); X.fill(); X.stroke();
        // Neck + head silhouette, anchored at the front of the body
        // (nods gently while idle)
        X.save(); X.translate(2.6*k,nod);
        ear(8.5*k,-13.9,-0.2); ear(10.1*k,-13.3,0.3);
        X.fillStyle=coat; X.strokeStyle='#000'; X.lineWidth=1.2;
        X.beginPath();
        X.moveTo(2.2*k,-2.6);
        X.quadraticCurveTo(6.6*k,-4.6, 7.8*k,-9);        // front of neck up to the throat
        X.quadraticCurveTo(10.5*k,-8.6, 14.2*k,-8.6);    // long flat jaw out to the muzzle
        X.lineTo(14.8*k,-12);                            // tall squared nose end
        X.quadraticCurveTo(12.5*k,-13.6, 9.6*k,-13.9);   // long flat forehead back to the poll
        X.quadraticCurveTo(4.6*k,-14.4, 1.6*k,-11);      // arched crest of the neck
        X.quadraticCurveTo(-0.4*k,-8.5, -0.6*k,-5.5);    // down into the withers
        X.closePath(); X.fill(); X.stroke();
        // Mane along the crest
        X.strokeStyle=maneC; X.lineWidth=2.4; X.lineCap='round';
        X.beginPath(); X.moveTo(0.2*k,-7.5); X.quadraticCurveTo(4.4*k,-13.2, 8.4*k,-13); X.stroke();
        X.lineCap='butt';
        // Eye high on the head, nostril at the nose
        X.fillStyle='#000';
        X.beginPath(); X.arc(9.7*k,-11.7,0.6,0,Math.PI*2); X.fill();
        X.fillStyle='rgba(0,0,0,0.45)';
        X.beginPath(); X.arc(13.9*k,-10.3,0.5,0,Math.PI*2); X.fill();
        X.restore();
      } else if (useDir === 6) {
        // Northeast diagonal (back view): arched neck seen from behind
        X.save(); X.translate(-5.8,-6.5); X.rotate(swish);
        X.beginPath(); X.moveTo(0,0); X.quadraticCurveTo(-2.7,3,-2.2,9);
        X.strokeStyle='#000'; X.lineWidth=3.4; X.lineCap='round'; X.stroke();
        X.strokeStyle=maneC; X.lineWidth=1.8; X.stroke(); X.lineCap='butt';
        X.restore();
        X.strokeStyle='#000'; X.lineWidth=1.2; X.fillStyle=coat;
        X.beginPath(); X.ellipse(0,-6,6.6,4.9,0,0,Math.PI*2); X.fill(); X.stroke();
        X.save(); X.translate(1.6,nod);
        ear(4.2,-16.6,-0.2); ear(6.4,-16.2,0.25);
        X.fillStyle=coat;
        X.beginPath();
        X.moveTo(1.5,-5); X.quadraticCurveTo(1.8,-11, 3.4,-14.6);
        X.lineTo(6.6,-14);
        X.quadraticCurveTo(6.6,-9, 6,-4);
        X.closePath(); X.fill(); X.stroke();
        // Round skull from behind, dipped forward
        X.beginPath(); X.ellipse(5.2,-14.5,2.3,2.4,0.15,0,Math.PI*2); X.fill(); X.stroke();
        // Mane down the crest
        X.strokeStyle=maneC; X.lineWidth=2.2; X.lineCap='round';
        X.beginPath(); X.moveTo(2.6,-5.5); X.quadraticCurveTo(3.2,-10.5,4,-14.6); X.stroke();
        X.lineCap='butt';
        X.restore();
      } else if (useDir === 1) {
        // South (front view): body behind the rider; the hanging head is
        // deferred so it renders in front of the rider.
        X.fillStyle=coat;
        X.beginPath(); X.ellipse(0,-5.5,5.6,5.2,0,0,Math.PI*2); X.fill(); X.stroke();
        horseHeadFront = () => {
          let nod2 = (e.path.length===0) ? Math.sin(tick*0.05+e.id)*0.8 : 0;
          X.save(); X.translate(0,-1+nod2); X.scale(1.35,1.35);
          X.strokeStyle='#000'; X.lineWidth=1.2; X.fillStyle=coat;
          ear(2,-12.4,-0.3); ear(6.2,-12.2,0.3);
          // Face tapers from a broad skull to a narrow muzzle
          X.beginPath();
          X.moveTo(1.3,-10.8);
          X.quadraticCurveTo(1.2,-6.4, 2.4,-4.4);
          X.quadraticCurveTo(4.1,-3.2, 5.8,-4.4);
          X.quadraticCurveTo(7,-6.4, 6.9,-10.8);
          X.quadraticCurveTo(4.1,-13.6, 1.3,-10.8);
          X.closePath(); X.fill(); X.stroke();
          // Forelock tuft
          X.fillStyle=maneC;
          X.beginPath(); X.arc(4.1,-11.9,1.8,Math.PI*0.9,Math.PI*0.1,true); X.fill();
          // Eyes wide on the skull, darker muzzle with nostrils
          X.fillStyle='#000';
          X.beginPath(); X.arc(2.6,-9.4,0.6,0,Math.PI*2); X.fill();
          X.beginPath(); X.arc(5.6,-9.4,0.6,0,Math.PI*2); X.fill();
          X.fillStyle='#6e4520';
          X.beginPath(); X.ellipse(4.1,-4.7,1.7,1.2,0,0,Math.PI*2); X.fill(); X.stroke();
          X.restore();
        };
      } else {
        // North (back view): neck/head face away, body and tail closest
        X.save(); X.translate(0,nod);
        X.fillStyle=coat;
        X.beginPath(); X.ellipse(3,-10,2.9,4.6,0,0,Math.PI*2); X.fill(); X.stroke(); // neck
        ear(1.5,-15,-0.25); ear(4.7,-14.9,0.25);
        X.beginPath(); X.ellipse(3,-13.1,2.6,2.8,0,0,Math.PI*2); X.fill(); X.stroke(); // back of head
        X.fillStyle=maneC;
        X.beginPath(); X.ellipse(3,-11.8,1.3,4.2,0,0,Math.PI*2); X.fill(); // mane down the crest
        X.restore();
        // Body drawn over the neck base
        X.fillStyle=coat;
        X.beginPath(); X.ellipse(0,-5,5.8,5.3,0,0,Math.PI*2); X.fill(); X.stroke();
        // Swishing tail down the center
        X.save(); X.translate(0,-3); X.rotate(swish);
        X.beginPath(); X.moveTo(0,0); X.quadraticCurveTo(-0.8,4.5,0,8.5);
        X.strokeStyle='#000'; X.lineWidth=3.2; X.lineCap='round'; X.stroke();
        X.strokeStyle=maneC; X.lineWidth=1.6; X.stroke(); X.lineCap='butt';
        X.restore();
      }
      X.restore();
    }

    // Torso
    X.strokeStyle='#000000';X.lineWidth=1;
    if(e.utype==='militia'){
      // Iron chainmail torso
      X.fillStyle='#6b6b6b';
      X.beginPath();X.arc(humanXOffset,-6+humanYOffset,5,0,Math.PI*2);X.fill();X.stroke();
      // Team-colored surcoat tunic
      X.fillStyle=tc;
      X.beginPath();X.rect(-2.5+humanXOffset,-10+humanYOffset,5,8);X.fill();X.stroke();
    } else {
      // Team-colored peasant shirt
      X.fillStyle=tc;
      X.beginPath();X.arc(humanXOffset,-6+humanYOffset,5,0,Math.PI*2);X.fill();X.stroke();
    }

    // Torso volume: soft highlight upper-left, shade lower-right
    X.save();
    X.beginPath();X.arc(humanXOffset,-6+humanYOffset,4.6,0,Math.PI*2);X.clip();
    X.fillStyle='rgba(255,255,255,0.22)';
    X.beginPath();X.arc(humanXOffset-2,-8.5+humanYOffset,3.6,0,Math.PI*2);X.fill();
    X.fillStyle='rgba(0,0,0,0.18)';
    X.beginPath();X.arc(humanXOffset+2.5,-3+humanYOffset,3.6,0,Math.PI*2);X.fill();
    X.restore();

    // Arms: rear arm hangs at the side, front arm reaches toward the weapon/tool hand
    {
      let armSwing = e.path.length>0 ? Math.sin(tick*0.4+e.id)*1.5 : 0;
      // While a villager works a tool, the front hand grips the handle base
      // (the tool's rotation anchor at (3,-9)) instead of hanging loose.
      let gripping = e.utype==='villager' && e.path.length===0 &&
        (e.task==='chop'||e.task==='mine_gold'||e.task==='mine_stone'||e.task==='build');
      // Picking (berries/farm): no tool — the front arm just reaches out and
      // down repeatedly, like plucking.
      let picking = e.utype==='villager' && e.path.length===0 &&
        (e.task==='forage'||e.task==='farm');
      let pick = Math.sin(tick*0.18+e.id);
      X.beginPath();
      X.moveTo(-3.5+humanXOffset,-8+humanYOffset); X.lineTo(-5+humanXOffset-armSwing,-3.5+humanYOffset);
      X.moveTo(3.5+humanXOffset,-8+humanYOffset);
      if(gripping) X.lineTo(3,-8.8);
      else if(picking) X.lineTo(5.6+humanXOffset+pick*0.8, -5.5+humanYOffset-pick*3.5);
      else X.lineTo(4.5+humanXOffset+armSwing,-4.5+humanYOffset);
      X.strokeStyle='#000000';X.lineWidth=3.0;X.lineCap='round';X.stroke();
      X.strokeStyle='#edc9a0';X.lineWidth=1.5;X.stroke();
      X.lineCap='butt';
      // Head/headwear drawing below relies on the black outline stroke set
      // before the torso — restore it after the skin-colored arm pass.
      X.strokeStyle='#000000';X.lineWidth=1;
    }
    if (e.facingNorth) {
      // Facing North (away from camera): Draw back of headwear/hair covering the head (no face)
      if(e.utype==='militia'){
        // Back of Norman iron helm
        X.fillStyle='#8a8a8a';
        X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.5,0,Math.PI*2);X.fill();X.stroke();
        X.fillStyle='#daa520';
        X.beginPath();X.rect(-4.5+humanXOffset,-14.5+humanYOffset,9,1.5);X.fill();X.stroke();
      } else if(e.utype==='archer') {
        // Back of archer hood
        X.fillStyle='#2e8b57';
        X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.5,0,Math.PI*2);X.fill();X.stroke();
      } else if(e.utype==='villager') {
        // Back of blonde hair
        X.fillStyle = '#b58e3d';
        X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.2,0,Math.PI*2);X.fill();X.stroke();
      } else {
        // Back of leather hood cap
        X.fillStyle='#4a2e1b';
        X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.5,0,Math.PI*2);X.fill();X.stroke();
      }
    } else {
      // Facing South (towards camera): Draw flesh face and headwear cap
      // Flesh Head
      X.fillStyle='#edc9a0';
      X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4,0,Math.PI*2);X.fill();X.stroke();

      // Draw 8-direction friendly facial features (eyes)
      if (e.dir === 7 || e.dir === 3) {
        // East/West profile: single eye toward the facing side
        X.fillStyle='#000';
        X.beginPath(); X.arc(humanXOffset + 2, -14.5 + humanYOffset, 0.55, 0, Math.PI*2); X.fill();
      } else if (e.dir === 1) {
        // South: Draw two centered eyes (facing straight forward)
        X.fillStyle='#000';
        X.beginPath(); X.arc(humanXOffset - 1.2, -14.5 + humanYOffset, 0.55, 0, Math.PI*2); X.fill();
        X.beginPath(); X.arc(humanXOffset + 1.2, -14.5 + humanYOffset, 0.55, 0, Math.PI*2); X.fill();
      } else if (e.dir === 0 || e.dir === 2) {
        // Southeast/Southwest: Draw two eyes shifted to the front-right/front-left
        X.fillStyle='#000';
        X.beginPath(); X.arc(humanXOffset + 0.5, -14.5 + humanYOffset, 0.55, 0, Math.PI*2); X.fill();
        X.beginPath(); X.arc(humanXOffset + 2.2, -14.5 + humanYOffset, 0.55, 0, Math.PI*2); X.fill();
      }
      
      // Headwear Cap
      if(e.utype==='militia'){
        // Norman iron helm
        X.fillStyle='#8a8a8a';
        X.beginPath();X.arc(humanXOffset,-15+humanYOffset,4.5,Math.PI,0);X.fill();X.stroke();
        X.fillStyle='#daa520';
        X.beginPath();X.rect(-4.5+humanXOffset,-15+humanYOffset,9,1.5);X.fill();X.stroke();
        X.fillStyle='#8a8a8a';
        X.beginPath();X.rect(-0.75+humanXOffset,-15+humanYOffset,1.5,4);X.fill();X.stroke();
      } else if(e.utype==='archer') {
        X.fillStyle='#2e8b57'; // green archer hood
        X.beginPath();X.arc(humanXOffset,-15+humanYOffset,4.5,Math.PI,0);X.fill();X.stroke();
      } else if(e.utype==='villager') {
        // No helmet/hood: just natural blonde hair!
        X.fillStyle = '#b58e3d';
        X.beginPath();
        X.arc(humanXOffset, -16+humanYOffset, 3.2, Math.PI, 0);
        X.fill(); X.stroke();
      } else {
        // Peasant leather hood cap for spearman/scout
        X.fillStyle='#4a2e1b';
        X.beginPath();X.arc(humanXOffset,-15+humanYOffset,4.5,Math.PI,0);X.fill();X.stroke();
      }
    }

    // Head/helmet highlight: small crescent on the upper-left for volume
    X.save();
    X.beginPath();X.arc(humanXOffset,-14.5+humanYOffset,4.1,0,Math.PI*2);X.clip();
    X.fillStyle='rgba(255,255,255,0.25)';
    X.beginPath();X.arc(humanXOffset-1.8,-16.5+humanYOffset,2.6,0,Math.PI*2);X.fill();
    X.restore();

    // Horse head in front of the rider (front-facing scout)
    if(horseHeadFront) horseHeadFront();

    // Tools & weapons (animated swinging swings during active tasks)
    if(e.utype==='villager'){
      // Shaped work swing: slow wind-up (70% of the cycle), fast strike
      // (30%), instead of a symmetric sine wobble. swing is the tool's
      // rotation: -1.1 fully raised, +0.5 at the moment of impact.
      let working = isActive && e.path.length===0;
      let phRaw = tick*0.055 + e.id*0.37;
      let ph = ((phRaw % 1) + 1) % 1;
      let u = ph < 0.7 ? ph/0.7 : 1-(ph-0.7)/0.3;
      let swing = working ? (0.5 - 1.6*u) : 0;
      // One impact burst per cycle, right as the tool lands
      let swingCyc = Math.floor(phRaw);
      let impact = working && ph > 0.93 && e._swingCyc !== swingCyc;
      if(impact) e._swingCyc = swingCyc;
      // Impact point in tile coords: the gather tile if known, else just ahead
      let hitX = (e.gatherX >= 0 && e.gatherX !== undefined) ? e.gatherX + 0.5 : e.x + e.facing*0.4;
      let hitY = (e.gatherY >= 0 && e.gatherY !== undefined) ? e.gatherY + 0.3 : e.y;
      if(e.task==='chop'&&e.path.length===0){
        if(impact) spawnParticles(hitX, hitY, '#c9a15e', 2, 0.02, 1.5); // wood chips
        X.save();X.translate(3,-9);X.rotate(swing);
        // Long handle
        X.strokeStyle='#000000';X.lineWidth=3.4;X.lineCap='round';
        X.beginPath();X.moveTo(0,1);X.lineTo(9,-13);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.8;
        X.beginPath();X.moveTo(0,1);X.lineTo(9,-13);X.stroke();X.lineCap='butt';
        // Big wedge axe head with a bright cutting edge
        X.fillStyle='#b8bfc6';
        X.beginPath();
        X.moveTo(8,-14.5);
        X.lineTo(14.5,-17);
        X.lineTo(13,-6.5);
        X.lineTo(7.4,-9.5);
        X.closePath();X.fill();
        X.strokeStyle='#000000';X.lineWidth=1.2;X.lineJoin='round';X.stroke();
        X.strokeStyle='#fff';X.lineWidth=1.4;
        X.beginPath();X.moveTo(13.9,-15.9);X.lineTo(12.7,-7.9);X.stroke();
        X.restore();
      } else if((e.task==='mine_gold'||e.task==='mine_stone')&&e.path.length===0){
        if(impact) spawnParticles(hitX, hitY, e.task==='mine_gold' ? '#ffd700' : '#c0c0c0', 2, 0.02, 1.3); // sparks
        X.save();X.translate(3,-9);X.rotate(swing);
        // Long handle
        X.strokeStyle='#000000';X.lineWidth=3.4;X.lineCap='round';
        X.beginPath();X.moveTo(0,1);X.lineTo(9,-13);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.8;
        X.beginPath();X.moveTo(0,1);X.lineTo(9,-13);X.stroke();X.lineCap='butt';
        // Big curved pick head, points tapering both ways
        X.strokeStyle='#000000';X.lineWidth=5;X.lineCap='round';
        X.beginPath();X.moveTo(2.5,-17.5);X.quadraticCurveTo(9.5,-16,15.5,-9);X.stroke();
        X.strokeStyle='#b8bfc6';X.lineWidth=2.4;
        X.beginPath();X.moveTo(2.5,-17.5);X.quadraticCurveTo(9.5,-16,15.5,-9);X.stroke();
        X.lineCap='butt';
        X.restore();
      } else if(e.task==='build'&&e.path.length===0){
        if(impact) spawnParticles(e.x + e.facing*0.35, e.y - 0.1, '#cbbca0', 2, 0.015, 1.2); // dust
        X.save();X.translate(3,-9);X.rotate(swing);
        // Handle
        X.strokeStyle='#000000';X.lineWidth=3.2;X.lineCap='round';
        X.beginPath();X.moveTo(0,1);X.lineTo(7.5,-11);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.7;
        X.beginPath();X.moveTo(0,1);X.lineTo(7.5,-11);X.stroke();X.lineCap='butt';
        // Big square mallet head with a bright face
        X.fillStyle='#9aa0a6';
        X.beginPath();X.rect(4,-15.5,7,5.5);X.fill();
        X.strokeStyle='#000000';X.lineWidth=1.2;X.stroke();
        X.fillStyle='#fff';
        X.beginPath();X.rect(9.8,-15,1.2,4.5);X.fill();
        X.restore();
      }
      if(e.carrying>0){
        X.strokeStyle='#000';X.lineWidth=1;
        if(e.carryType==='wood'){
          // Bundle of three logs over the shoulder: two below, one on top,
          // round end grain facing the camera.
          X.save();X.translate(-6,-8);X.rotate(-0.18);
          const log=(lx,ly)=>{
            X.fillStyle='#6e473b';X.beginPath();X.rect(lx-9.5,ly-1.7,10,3.4);X.fill();X.stroke();
            X.fillStyle='#ebd2b0';X.beginPath();X.ellipse(lx+0.5,ly,1.8,2.0,0,0,Math.PI*2);X.fill();X.stroke();
            X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8;
            X.beginPath();X.arc(lx+0.5,ly,0.8,0,Math.PI*2);X.stroke();
            X.strokeStyle='#000';X.lineWidth=1;
          };
          log(0.5,1.8); log(4,1.6); log(2.2,-1.6);
          X.restore();
        } else if(e.carryType==='stone'){
          // Comically oversized haul: a big cut block with a smaller one
          // stacked on top, hoisted on the shoulder.
          X.save();X.translate(-7.5,-9);
          const block=(bx,by,s)=>{
            X.fillStyle='#b3b3b3';X.beginPath(); // top face
            X.moveTo(bx,by-2.2*s);X.lineTo(bx+3.4*s,by-0.6*s);X.lineTo(bx,by+1*s);X.lineTo(bx-3.4*s,by-0.6*s);X.closePath();X.fill();X.stroke();
            X.fillStyle='#8f8f8f';X.beginPath(); // left face
            X.moveTo(bx-3.4*s,by-0.6*s);X.lineTo(bx,by+1*s);X.lineTo(bx,by+4.6*s);X.lineTo(bx-3.4*s,by+3*s);X.closePath();X.fill();X.stroke();
            X.fillStyle='#787878';X.beginPath(); // right face
            X.moveTo(bx+3.4*s,by-0.6*s);X.lineTo(bx,by+1*s);X.lineTo(bx,by+4.6*s);X.lineTo(bx+3.4*s,by+3*s);X.closePath();X.fill();X.stroke();
            X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8; // crack
            X.beginPath();X.moveTo(bx-1.8*s,by+1.2*s);X.lineTo(bx-1.2*s,by+2.6*s);X.lineTo(bx-1.9*s,by+3.6*s);X.stroke();
            X.strokeStyle='#000';X.lineWidth=1;
          };
          block(0,0,1.5);          // big base block
          block(1.2,-4.6,0.95);    // smaller block stacked on top
          X.restore();
        } else if(e.carryType==='gold'){
          // Overflowing armful of gold: heaped shiny nuggets with twinkles
          X.save();X.translate(-6.5,-7.5);
          const nug=(nx,ny,r)=>{
            X.fillStyle='#e8b90f';X.beginPath();X.arc(nx,ny,r,0,Math.PI*2);X.fill();X.stroke();
            X.fillStyle='#ffe14d';X.beginPath();X.arc(nx-r*0.3,ny-r*0.3,r*0.5,0,Math.PI*2);X.fill();
          };
          nug(-2.2,0.5,2.2); nug(2,0.8,2.0); nug(0,-0.6,2.4);
          nug(-1,-2.6,1.9); nug(1.6,-2.2,1.7); nug(0.3,-4,1.5);
          // Twinkling 4-point sparkles
          let tw=(Math.sin(tick*0.25+e.id)+1)/2;
          X.fillStyle='rgba(255,255,255,'+(0.5+0.5*tw).toFixed(2)+')';
          const spark=(px,py,r)=>{
            X.beginPath();
            X.moveTo(px,py-r);X.lineTo(px+r*0.3,py-r*0.3);X.lineTo(px+r,py);X.lineTo(px+r*0.3,py+r*0.3);
            X.lineTo(px,py+r);X.lineTo(px-r*0.3,py+r*0.3);X.lineTo(px-r,py);X.lineTo(px-r*0.3,py-r*0.3);
            X.closePath();X.fill();
          };
          spark(-1.5,-3.6,0.6+1.6*tw); spark(2.4,-0.6,0.5+1.2*(1-tw));
          X.restore();
        } else {
          // Food — carry the goods themselves, big and readable, no basket.
          // What shows depends on where the food came from.
          X.save();X.translate(-7,-7);
          if(e.foodSrc==='meat'){
            // Fluffy white wool bundle (from sheep): scalloped cloud like
            // the sheep's own coat — silhouette pass, then wool fill
            let puffs=[[-1.8,-0.8,1.9],[1.8,-1,1.9],[0,-2.8,1.9],[0,0.6,2.0]];
            X.fillStyle='#000';
            puffs.forEach(p=>{X.beginPath();X.arc(p[0],p[1],p[2]+1,0,Math.PI*2);X.fill();});
            X.fillStyle='#f2eddd';
            puffs.forEach(p=>{X.beginPath();X.arc(p[0],p[1],p[2],0,Math.PI*2);X.fill();});
            X.fillStyle='rgba(255,255,255,0.5)';
            X.beginPath();X.arc(-0.6,-2.2,1.2,0,Math.PI*2);X.fill();
          } else if(e.foodSrc==='wheat'){
            // Tied wheat sheaf over the shoulder
            X.save();X.rotate(-0.25);
            X.strokeStyle='#c9a227';X.lineWidth=1.4;
            for(let i=-2;i<=2;i++){
              X.beginPath();X.moveTo(0,3);X.lineTo(i*1.7,-4);X.stroke();
            }
            X.strokeStyle='#000';X.lineWidth=1.2;
            X.beginPath();X.moveTo(-1.7,1);X.lineTo(1.7,1);X.stroke();
            X.fillStyle='#e8c84a';X.strokeStyle='#000';X.lineWidth=0.8;
            for(let i=-2;i<=2;i++){
              X.beginPath();X.ellipse(i*1.7,-4.7,0.9,1.7,i*0.15,0,Math.PI*2);X.fill();X.stroke();
            }
            X.restore();
          } else {
            // Armful of big glossy berries
            X.fillStyle='#cc3344';X.strokeStyle='#000';X.lineWidth=1;
            [[-1.6,-0.8],[1.6,-1.1],[0,-3.2],[0,1]].forEach(([bx2,by2])=>{
              X.beginPath();X.arc(bx2,by2,2.2,0,Math.PI*2);X.fill();X.stroke();
            });
            X.fillStyle='#ff99a8';
            X.beginPath();X.arc(-2.2,-1.4,0.7,0,Math.PI*2);X.fill();
            X.beginPath();X.arc(-0.6,-3.8,0.7,0,Math.PI*2);X.fill();
          }
          X.restore();
        }
      }
    } else if(e.utype==='militia'){
      // Militia broadsword (shaped combat slash)
      let swinging=e.target&&e.path.length===0;
      X.save();X.translate(6.5,-6);
      drawBigSword(swinging, e.id);
      X.restore();

      // Big steel kite shield with a team-colored cross
      let shx = -6, shy = -6;
      if (e.dir === 4 || e.dir === 5 || e.dir === 6) {
        shx = -2.5; // Shift to the back center when facing North directions
        shy = -7;
      }
      X.strokeStyle='#000000';X.lineWidth=1.2;X.lineJoin='round';
      X.fillStyle='#a8adb3';X.beginPath();
      X.moveTo(shx-4.2, shy-5.5);X.lineTo(shx+4.2, shy-5.5);
      X.lineTo(shx+5.6, shy);X.lineTo(shx, shy+8.5);X.lineTo(shx-5.6, shy);X.closePath();X.fill();X.stroke();
      X.fillStyle=tc;X.beginPath();
      X.fillRect(shx-4.2, shy-0.8, 8.4, 1.7);
      X.fillRect(shx-0.85, shy-4.5, 1.7, 9);
      X.strokeStyle='#000000';X.lineWidth=0.8;X.stroke();
    } else if(e.utype==='spearman'){
      // Long spear with a big leaf-shaped head; the thrust is shaped —
      // slow pull-back, fast jab along the shaft.
      let swinging=e.target&&e.path.length===0;
      X.save(); X.translate(3, -6+humanYOffset);
      if(swinging){
        let ph=((tick*0.07+e.id*0.4)%1+1)%1;
        let u=ph<0.72?ph/0.72:1-(ph-0.72)/0.28;
        let off=-2.5*u+4.5*(1-u);
        X.translate(off*0.75, -off*0.75);
      }
      X.strokeStyle='#000'; X.lineWidth=3.2; X.lineCap='round';
      X.beginPath(); X.moveTo(-8, 10); X.lineTo(12, -10); X.stroke();
      X.strokeStyle='#8B4513'; X.lineWidth=1.6;
      X.beginPath(); X.moveTo(-8, 10); X.lineTo(12, -10); X.stroke();
      X.lineCap='butt';
      X.fillStyle='#dde3ea'; X.strokeStyle='#000'; X.lineWidth=1.1; X.lineJoin='round';
      // Leaf head symmetric about the shaft axis: base corners sit at
      // shaft-end ± perpendicular, tip continues along the shaft direction.
      X.beginPath();
      X.moveTo(10, -12); X.lineTo(17.6, -15.6); X.lineTo(13.9, -8.1); X.closePath();
      X.fill(); X.stroke();
      X.restore();
    } else if(e.utype==='archer'){
      // Big bow with a full draw cycle: nock and pull back slowly, release,
      // string snaps forward and vibrates until the next arrow.
      let swinging=e.target&&e.path.length===0;
      let ph=((tick*0.06+e.id*0.4)%1+1)%1;
      X.save(); X.translate(4, -8+humanYOffset);
      // Thick recurve limbs
      X.strokeStyle='#000'; X.lineWidth=4.2; X.lineCap='round';
      X.beginPath(); X.arc(0, 0, 10, -Math.PI/2.15, Math.PI/2.15); X.stroke();
      X.strokeStyle='#8B4513'; X.lineWidth=2.3;
      X.beginPath(); X.arc(0, 0, 10, -Math.PI/2.15, Math.PI/2.15); X.stroke();
      X.lineCap='butt';
      let tipX = 10*Math.cos(Math.PI/2.15), tipY = 10*Math.sin(Math.PI/2.15);
      if(swinging && ph < 0.72){
        let d = ph/0.72;
        let pull = -2 - 5.5*d;
        // Drawn string
        X.strokeStyle='#e8e8e8'; X.lineWidth=1;
        X.beginPath(); X.moveTo(tipX, -tipY); X.lineTo(pull, 0); X.lineTo(tipX, tipY); X.stroke();
        // Nocked arrow: thick shaft, steel head, red fletching
        X.strokeStyle='#000'; X.lineWidth=2.6; X.lineCap='round';
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull+16, 0); X.stroke();
        X.strokeStyle='#f5f2e9'; X.lineWidth=1.3;
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull+16, 0); X.stroke();
        X.lineCap='butt';
        X.fillStyle='#dde3ea'; X.strokeStyle='#000'; X.lineWidth=1;
        X.beginPath(); X.moveTo(pull+18.5, 0); X.lineTo(pull+13.6, -2.5); X.lineTo(pull+13.6, 2.5); X.closePath(); X.fill(); X.stroke();
        X.fillStyle='#cc4444';
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull-3.2, -2.8); X.lineTo(pull+1.4, -0.5); X.closePath(); X.fill();
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull-3.2, 2.8); X.lineTo(pull+1.4, 0.5); X.closePath(); X.fill();
      } else {
        // String at rest — vibrates briefly right after the release
        let vib = swinging ? Math.sin(tick*1.2)*2.2*(1-(ph-0.72)/0.28) : 0;
        X.strokeStyle='#e8e8e8'; X.lineWidth=1;
        X.beginPath(); X.moveTo(tipX, -tipY); X.quadraticCurveTo(vib, 0, tipX, tipY); X.stroke();
      }
      X.restore();
    } else if(e.utype==='scout'){
      // Scout broadsword (same big sword as the militia, shaped slash).
      // At rest it parks on the rider's LEFT side, mirrored — the right is
      // where the horse's head rises, and the blade would point into it.
      let swinging=e.target&&e.path.length===0;
      X.save();
      if(swinging){
        X.translate(6+humanXOffset, -6+humanYOffset);
        drawBigSword(true, e.id);
      } else {
        X.translate(-4.5+humanXOffset, -6+humanYOffset);
        X.scale(-1,1);
        drawBigSword(false, e.id);
      }
      X.restore();
    }
  } else {
    // Sheep — scalloped wool cloud; head tracks movement direction
    let waddle = e.path.length > 0 ? Math.sin(tick * 0.2 + e.id) * 0.06 : 0;
    let breath = e.path.length === 0 ? Math.sin(tick * 0.06 + e.id) * 0.12 : 0;

    X.save();
    X.rotate(waddle);

    // 4-leg walk cycle: outlined stubby legs with hooves
    let hw1 = e.path.length > 0 ? Math.sin(tick * 0.45 + e.id) * 3.0 : 0;
    let hw2 = -hw1;
    let legPts = [[-4, 0, hw1], [-1, 1, hw2], [2, 1, hw1], [5, 0, hw2]];
    X.beginPath();
    legPts.forEach(p => { X.moveTo(p[0], p[1]); X.lineTo(p[0] + p[2], 5); });
    X.strokeStyle='#000'; X.lineWidth=2.6; X.lineCap='round'; X.stroke();
    X.strokeStyle='#8a8378'; X.lineWidth=1.3; X.stroke(); X.lineCap='butt';
    X.fillStyle='#241f18';
    legPts.forEach(p => { X.beginPath(); X.ellipse(p[0] + p[2], 5.3, 1.2, 0.9, 0, 0, Math.PI*2); X.fill(); });

    // Waggable wool-puff tail at the rear
    let tailRate = e.eatingGrass ? 0.35 : (e.path.length > 0 ? 0.25 : 0.08);
    let tailAngle = Math.sin(tick * tailRate + e.id) * 0.4;
    X.save();
    X.translate(-7.5, -4);
    X.rotate(tailAngle - 0.2);
    X.fillStyle='#000';
    X.beginPath(); X.arc(-1.5, 0, 2.6, 0, Math.PI*2); X.fill();
    X.fillStyle='#f2eddd';
    X.beginPath(); X.arc(-1.5, 0, 1.7, 0, Math.PI*2); X.fill();
    X.restore();

    // Scalloped wool cloud: black silhouette pass, then wool fill pass
    let puffs = [[-4.5,-3.5,3.4],[-1.5,-6.5,3.5],[2.5,-6,3.4],[5,-3,3.2],[2,-0.5,3.3],[-2,-0.5,3.4],[0,-3.5,4.4]];
    X.fillStyle='#000';
    puffs.forEach(p => { X.beginPath(); X.arc(p[0], p[1], p[2]+1.1+breath, 0, Math.PI*2); X.fill(); });
    X.fillStyle='#f2eddd';
    puffs.forEach(p => { X.beginPath(); X.arc(p[0], p[1], p[2]+breath, 0, Math.PI*2); X.fill(); });
    // Wool shading: highlight on top, ground shade underneath
    X.fillStyle='rgba(255,255,255,0.5)';
    X.beginPath(); X.arc(-1, -6.5, 2.6, 0, Math.PI*2); X.fill();
    X.fillStyle='rgba(110,95,70,0.20)';
    X.beginPath(); X.ellipse(0, 1.6, 5.8, 2, 0, 0, Math.PI*2); X.fill();

    let earWiggle = e.eatingGrass ? Math.sin(tick * 0.5 + e.id) * 1.2 : Math.sin(tick * 0.1 + e.id) * 0.4;

    // Sheep head: dark face, droopy ears, wool tuft on top, team bandana.
    // mode: 'front' (two eyes), 'side' (one eye), 'back' (no face)
    const sheepHead = (hx, hy, mode) => {
      X.strokeStyle='#000'; X.lineWidth=1;
      // Team bandana under the chin
      X.fillStyle=tc;
      X.beginPath(); X.ellipse(hx, hy+3.6, 3, 1.8, 0, 0, Math.PI*2); X.fill();
      // Droopy ears
      X.fillStyle = mode==='back' ? '#4a463e' : '#57534a';
      X.save(); X.translate(hx-2.6, hy-0.6+earWiggle); X.rotate(-0.5);
      X.beginPath(); X.ellipse(0, 0, 2.0, 1.1, 0, 0, Math.PI*2); X.fill(); X.stroke(); X.restore();
      X.save(); X.translate(hx+2.6, hy-0.6-earWiggle); X.rotate(0.5);
      X.beginPath(); X.ellipse(0, 0, 2.0, 1.1, 0, 0, Math.PI*2); X.fill(); X.stroke(); X.restore();
      // Head
      X.fillStyle = mode==='back' ? '#3a362f' : '#4a463e';
      X.beginPath(); X.ellipse(hx, hy, 2.7, 3.1, 0, 0, Math.PI*2); X.fill(); X.stroke();
      // Wool tuft on top of the head
      X.fillStyle='#000';
      X.beginPath(); X.arc(hx, hy-2.9, 2.2, 0, Math.PI*2); X.fill();
      X.fillStyle='#f2eddd';
      X.beginPath(); X.arc(hx, hy-2.9, 1.6, 0, Math.PI*2); X.fill();
    };

    let headX = 0, headY = 0;
    if (e.eatingGrass) {
      let chew = Math.sin(tick * 0.6);
      headX = 6; headY = 2 + chew;
      sheepHead(headX, headY, 'side');
    } else if (e.dir === 1) {
      // Strictly South: head center-front
      headX = 0; headY = 1.5;
      sheepHead(headX, headY, 'front');
    } else if (e.dir === 5) {
      // Strictly North: head center-back, no face
      headX = 0; headY = -8;
      sheepHead(headX, headY, 'back');
    } else {
      // Side and diagonal directions
      let useDir = e.dir;
      if (e.facing === -1) {
        if (e.dir === 2) useDir = 0;      // SW -> SE
        else if (e.dir === 3) useDir = 7; // W -> E
        else if (e.dir === 4) useDir = 6; // NW -> NE
      }
      if (useDir === 7)      { headX = 6.5; headY = -3.5; sheepHead(headX, headY, 'side'); }
      else if (useDir === 0) { headX = 5.5; headY = -1.5; sheepHead(headX, headY, 'side'); }
      else                   { headX = 3.5; headY = -7.5; sheepHead(headX, headY, 'back'); }
    }

    if(e.eatingGrass){
      X.strokeStyle='#4e8c2d'; X.lineWidth=1.2;
      X.beginPath();X.moveTo(headX,headY+1.2);X.lineTo(headX+4,headY+3);X.stroke();
      X.beginPath();X.moveTo(headX-0.5,headY+1.5);X.lineTo(headX+3,headY+4);X.stroke();
      
      // Spawn tiny grass particle puffs
      if(tick % 24 === 0){
        spawnParticles(e.x + (e.facing * 0.25), e.y + 0.1, '#4e8c2d', 1, 0.008, 0.9);
      }
    }
    X.restore();
  }

  X.restore(); // restore to absolute coordinates so text and UI aren't mirrored

  // HP bar (higher for the scout — horse and rider stand taller)
  if(e.hp<e.maxHp){
    let hpTop = e.utype==='scout' ? sy-33 : sy-23;
    X.fillStyle='#000000';X.fillRect(sx-9,hpTop,18,5);
    X.fillStyle='#300';X.fillRect(sx-8,hpTop+1,16,3);
    X.fillStyle=e.hp/e.maxHp>0.5?'#0c0':'#c00';X.fillRect(sx-8,hpTop+1,16*e.hp/e.maxHp,3);
  }
  // Selection circle
  if(selected.includes(e)){
    X.strokeStyle='#fff';X.lineWidth=1.5;
    X.beginPath();X.ellipse(sx,sy+2,8,4,0,0,Math.PI*2);X.stroke();
  }
  // Idle indicator — keep showing while walking too, as long as no
  // task/target is actually assigned (a bare move order isn't "working").
  if(e.team===0&&e.utype==='villager'&&!e.task&&!e.target){
    X.fillStyle='#ffd700';X.strokeStyle='#000';X.lineWidth=2;
    X.font='bold 16px sans-serif';X.textAlign='center';
    X.strokeText('?',sx,sy-20);
    X.fillText('?',sx,sy-20);
  }
}

function drawGhost(){
  if(!placing)return;
  let tile=screenToTile(mouseX,mouseY);

  // Wall drag: show the actual wall pillars/links along the drag line
  // (same ghost style as a single hovered wall), not just flat tint tiles.
  if (placing === 'WALL' && window.isDraggingWall && window.wallDragStart && window.wallDragEnd) {
    let line = getWallElbowTiles(window.wallDragStart, window.wallDragCorner || window.wallDragEnd, window.wallDragEnd);
    let pillarH = 22, wallH = 14;
    let toScr = (tx, ty) => {
      let iso = toIso(tx + 0.5, ty + 0.5);
      return { x: iso.ix - camX + W/2, y: iso.iy - camY + topH + H/2 - HALF_TH };
    };
    X.globalAlpha = 0.55;
    window._ghostDraw = true;
    line.forEach((t, i) => {
      let p = toScr(t.x, t.y);
      let linkY = p.y + 16;
      drawBuildingBlock(p.x, p.y+11, 9, 4.5, pillarH, '#cfc8b6', '#aca392', 'flat', 0, '#b7ad97', '#b7ad97', false);
      let next = line[i+1];
      if (next) {
        let ddx = next.x - t.x, ddy = next.y - t.y;
        let off = toIso(ddx, ddy);
        drawWallLink(p.x, linkY, off.ix, off.iy, wallH, false);
      }
    });
    window._ghostDraw = false;
    X.globalAlpha = 1;

    // Tint each tile green (valid) or red (invalid)
    line.forEach(t => {
      let ok = canPlace('WALL', t.x, t.y, 0);
      let iso = toIso(t.x, t.y);
      let sx = iso.ix - camX + W/2, sy = iso.iy - camY + topH + H/2;
      X.fillStyle = ok ? 'rgba(0,200,0,0.28)' : 'rgba(200,0,0,0.28)';
      X.beginPath();
      X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
      X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
      X.closePath();X.fill();
    });
    return;
  }

  let b=BLDGS[placing];
  let bw=b.w, bh_=b.h;
  let ox=tile.x, oy=tile.y;
  if(placing==='GATE'){
    let isWall = (tx, ty) => !!entities.find(en=>en.type==='building'&&en.x===tx&&en.y===ty&&en.btype==='WALL'&&en.team===0);
    if (isWall(tile.x, tile.y) && isWall(tile.x+1, tile.y)) {
      ox=tile.x; oy=tile.y; bw=2; bh_=1;
    } else if (isWall(tile.x-1, tile.y) && isWall(tile.x, tile.y)) {
      ox=tile.x-1; oy=tile.y; bw=2; bh_=1;
    } else if (isWall(tile.x, tile.y) && isWall(tile.x, tile.y+1)) {
      ox=tile.x; oy=tile.y; bw=1; bh_=2;
    } else if (isWall(tile.x, tile.y-1) && isWall(tile.x, tile.y)) {
      ox=tile.x; oy=tile.y-1; bw=1; bh_=2;
    } else {
      bw=1; bh_=2;
    }
  }
  let ok=canPlace(placing,tile.x,tile.y,0);

  // Draw ghost: actual building rendered semi-transparently
  let fakeE={
    type:'building', btype:placing, x:ox, y:oy, team:0,
    hp:b.hp, maxHp:b.hp, complete:true,
    buildProgress:0, buildTime:200, queue:[],
    w:bw, h:bh_, rallyX:ox, rallyY:oy, gateProgress:0
  };
  X.globalAlpha=0.55;
  window._ghostDraw=true;
  drawBuilding(fakeE);
  window._ghostDraw=false;
  X.globalAlpha=1;

  // Tint footprint tiles green (valid) or red (invalid)
  X.fillStyle=ok?'rgba(0,200,80,0.28)':'rgba(220,30,0,0.28)';
  for(let dy=0;dy<bh_;dy++)for(let dx=0;dx<bw;dx++){
    let iso=toIso(ox+dx,oy+dy);
    let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2;
    X.beginPath();
    X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
    X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
    X.closePath();X.fill();
  }
}

function drawSelection(){
  if(!dragStart||!dragEnd)return;
  X.strokeStyle='#0f0';X.lineWidth=1;
  X.setLineDash([4,4]);
  let x1=Math.min(dragStart.x,dragEnd.x), y1=Math.min(dragStart.y,dragEnd.y);
  let x2=Math.max(dragStart.x,dragEnd.x), y2=Math.max(dragStart.y,dragEnd.y);
  X.strokeRect(x1,y1,x2-x1,y2-y1);
  X.setLineDash([]);
}

function drawMinimap(){
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let mw=MC.parentElement.clientWidth||160,mh=MC.parentElement.clientHeight||160;
  MC.width=mw*dpr;MC.height=mh*dpr;
  MC.style.width=mw+'px';MC.style.height=mh+'px';
  MX.scale(dpr,dpr);
  let mt=getMiniTransform(mw,mh);
  let miniPoint=(x,y)=>{
    let iso=toIso(x,y);
    return{x:mt.ox+iso.ix*mt.scale,y:mt.oy+iso.iy*mt.scale};
  };
  let fillDiamond=(points,color)=>{
    MX.fillStyle=color;
    MX.beginPath();
    MX.moveTo(points[0].x,points[0].y);
    for(let i=1;i<points.length;i++)MX.lineTo(points[i].x,points[i].y);
    MX.closePath();
    MX.fill();
  };
  MX.clearRect(0,0,mw,mh);
  for(let y=0;y<MAP;y++)for(let x=0;x<MAP;x++){
    let f = fog[y] && fog[y][x];
    let c = '#000000'; // unexplored is black
    if (f === 1) {
      let t=map[y][x];
      c=t.t===TERRAIN.GRASS?'#254615':t.t===TERRAIN.FOREST?'#0d2008':
        t.t===TERRAIN.GOLD?'#6d5210':t.t===TERRAIN.STONE?'#404040':
        t.t===TERRAIN.WATER?'#224c6e':t.t===TERRAIN.FARM?'#453d28':'#254615';
    } else if (f === 2) {
      let t=map[y][x];
      c=t.t===TERRAIN.GRASS?'#4a8c2a':t.t===TERRAIN.FOREST?'#1a4010':
        t.t===TERRAIN.GOLD?'#daa520':t.t===TERRAIN.STONE?'#808080':
        t.t===TERRAIN.WATER?'#4499dd':t.t===TERRAIN.FARM?'#8a7a50':'#4a8c2a';
    }
    fillDiamond([miniPoint(x,y),miniPoint(x+1,y),miniPoint(x+1,y+1),miniPoint(x,y+1)],c);
  }
  let outline=[miniPoint(0,0),miniPoint(MAP,0),miniPoint(MAP,MAP),miniPoint(0,MAP)];
  MX.strokeStyle='#d8c878';
  MX.lineWidth=1;
  MX.beginPath();
  MX.moveTo(outline[0].x,outline[0].y);
  for(let i=1;i<outline.length;i++)MX.lineTo(outline[i].x,outline[i].y);
  MX.closePath();
  MX.stroke();
  entities.forEach(e=>{
    let ex = Math.round(e.x), ey = Math.round(e.y);
    let f = e.type === 'building' ? buildingFogLevel(e) : ((fog[ey] && fog[ey][ex]) || 0);
    if (f === 0) return; // completely unexplored — hide everything
    if (f === 1 && e.team !== 0 && e.type !== 'building') return; // hide enemy units in shroud (buildings remembered)
    
    MX.fillStyle=TEAM_COLORS[e.team];
    if(e.type==='building'){
      let w=e.w||1,h=e.h||1;
      fillDiamond([miniPoint(e.x,e.y),miniPoint(e.x+w,e.y),miniPoint(e.x+w,e.y+h),miniPoint(e.x,e.y+h)],TEAM_COLORS[e.team]);
    } else {
      let p=miniPoint(e.x+0.5,e.y+0.5);
      MX.fillRect(p.x-1,p.y-1,2,2);
    }
  });
  let bottomY=window.innerHeight-bottomH;
  let vp=[
    screenToMap(0,topH),
    screenToMap(W,topH),
    screenToMap(W,bottomY),
    screenToMap(0,bottomY)
  ].map(p=>miniPoint(p.x,p.y));
  MX.strokeStyle='#fff';MX.lineWidth=1;
  MX.beginPath();
  MX.moveTo(vp[0].x,vp[0].y);
  for(let i=1;i<vp.length;i++)MX.lineTo(vp[i].x,vp[i].y);
  MX.closePath();
  MX.stroke();
}

function drawParticles() {
  X.save();
  particles.forEach(p => {
    let px = Math.round(p.x), ppy = Math.round(p.y);
    if (ppy < 0 || ppy >= MAP || px < 0 || px >= MAP || fog[ppy][px] !== 2) return;
    
    let iso = toIso(p.x, p.y);
    let sx = iso.ix - camX + W/2;
    let sy = iso.iy - camY + topH + H/2 + HALF_TH;
    
    let pz = p.z || 0;
    sy -= pz * 35;

    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) return;

    X.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
    
    if (p.type === 'fire') {
      let pct = p.life / p.maxLife;
      let col = '#e02200';
      if (pct > 0.65) col = '#ffff80';
      else if (pct > 0.35) col = '#ff9d21';
      
      let curSize = p.size * (0.3 + pct * 0.9);
      
      X.fillStyle = col;
      X.beginPath();
      X.arc(sx, sy, curSize * 2.0, 0, Math.PI * 2);
      X.globalAlpha = Math.max(0, Math.min(1, (p.life / p.maxLife) * 0.25));
      X.fill();
      
      X.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
      X.beginPath();
      X.arc(sx, sy, curSize, 0, Math.PI * 2);
      X.fill();
    } 
    else if (p.type === 'smoke') {
      let pct = p.life / p.maxLife;
      let curSize = p.size * (1.0 + (1.0 - pct) * 1.5);
      X.fillStyle = 'rgba(100, 100, 100, 0.4)';
      X.beginPath();
      X.arc(sx, sy, curSize, 0, Math.PI * 2);
      X.fill();
    } 
    else if (p.type === 'blood') {
      X.fillStyle = p.color;
      if (pz <= 0.01) {
        X.beginPath();
        X.ellipse(sx, sy, p.size * 1.6, p.size * 0.8, 0, 0, Math.PI * 2);
        X.fill();
      } else {
        X.beginPath();
        X.arc(sx, sy, p.size, 0, Math.PI * 2);
        X.fill();
      }
    } 
    else {
      X.fillStyle = p.color;
      X.beginPath();
      X.arc(sx, sy, p.size, 0, Math.PI * 2);
      X.fill();
    }
  });
  X.restore();
}

function drawProjectiles() {
  X.save();
  projectiles.forEach(p => {
    let ppx = Math.round(p.x), ppy = Math.round(p.y);
    if (ppy < 0 || ppy >= MAP || ppx < 0 || ppx >= MAP || fog[ppy][ppx] !== 2) return;
    let target = entities.find(en => en.id === p.targetId);
    if (!target) return;
    let targetX = target.type === 'building' ? target.x + (target.w || BLDGS[target.btype].w)/2 : target.x;
    let targetY = target.type === 'building' ? target.y + (target.h || BLDGS[target.btype].h)/2 : target.y;
    let dCurrent = Math.hypot(p.x - targetX, p.y - targetY);
    let progress = p.totalDist > 0.1 ? Math.max(0, Math.min(1, 1 - dCurrent / p.totalDist)) : 1;

    let iso = toIso(p.x, p.y);
    let sx = iso.ix - camX + W/2;
    let sy = iso.iy - camY + topH + H/2 + HALF_TH;
    // Height along the flight: launch height (bow / battlements) blends to
    // impact height at the target's body, plus the ballistic arc.
    let startH = p.startH || 12;
    let endH = 8;
    let A = 35 * (p.totalDist / 5);
    let arcH = Math.sin(progress * Math.PI) * A;
    let lift = startH + (endH - startH) * progress + arcH;
    sy -= lift;

    // Analytic flight tangent in screen space: iso ground motion plus the
    // derivative of arc+height blend, so the arrow always points along its
    // actual path — including right at launch and impact.
    let isoS = toIso(p.startX, p.startY), isoT = toIso(targetX, targetY);
    let vx = isoT.ix - isoS.ix;
    let vy = (isoT.iy - isoS.iy) - (Math.cos(progress*Math.PI)*Math.PI*A + (endH - startH));
    let screenAngle = Math.atan2(vy, vx);

    let L = 14;
    let ca = Math.cos(screenAngle), sa = Math.sin(screenAngle);
    let px2 = -sa, py2 = ca;
    // Motion streak trailing the arrow
    X.strokeStyle = 'rgba(255,255,255,0.3)';
    X.lineWidth = 2; X.lineCap='round';
    X.beginPath();
    X.moveTo(sx - ca*(L+2), sy - sa*(L+2));
    X.lineTo(sx - ca*(L+11), sy - sa*(L+11));
    X.stroke();
    // Thick shaft
    X.strokeStyle = '#000'; X.lineWidth = 3.2;
    X.beginPath(); X.moveTo(sx - ca*L, sy - sa*L); X.lineTo(sx, sy); X.stroke();
    X.strokeStyle = '#f5f2e9'; X.lineWidth = 1.4;
    X.beginPath(); X.moveTo(sx - ca*L, sy - sa*L); X.lineTo(sx, sy); X.stroke();
    X.lineCap='butt';
    // Big steel head
    X.fillStyle = '#dde3ea'; X.strokeStyle='#000'; X.lineWidth=1;
    X.beginPath();
    X.moveTo(sx + ca*3.4, sy + sa*3.4);
    X.lineTo(sx - ca*1.5 + px2*2.3, sy - sa*1.5 + py2*2.3);
    X.lineTo(sx - ca*1.5 - px2*2.3, sy - sa*1.5 - py2*2.3);
    X.closePath(); X.fill(); X.stroke();
    // Red fletching fins
    let tx2 = sx - ca*L, ty2 = sy - sa*L;
    X.fillStyle = '#cc4444';
    X.beginPath();
    X.moveTo(tx2 + ca*2, ty2 + sa*2);
    X.lineTo(tx2 - ca*3 + px2*2.8, ty2 - sa*3 + py2*2.8);
    X.lineTo(tx2, ty2);
    X.closePath(); X.fill();
    X.beginPath();
    X.moveTo(tx2 + ca*2, ty2 + sa*2);
    X.lineTo(tx2 - ca*3 - px2*2.8, ty2 - sa*3 - py2*2.8);
    X.lineTo(tx2, ty2);
    X.closePath(); X.fill();
  });
  X.restore();
}

function render(){
  // Black background so unexplored fog (drawTile() skips drawing when
  // fog===0) and the area beyond the map edge both read as true black,
  // matching AoE2 rather than showing a dark-green "explored" tint.
  X.fillStyle='#000000';X.fillRect(0,0,W,window.innerHeight);

  // Viewport culling: calculate visible map tile range
  let p1 = screenToMap(0, 0);
  let p2 = screenToMap(W, 0);
  let p3 = screenToMap(0, window.innerHeight);
  let p4 = screenToMap(W, window.innerHeight);
  
  let minX = Math.max(0, Math.floor(Math.min(p1.x, p2.x, p3.x, p4.x)) - 2);
  let maxX = Math.min(MAP - 1, Math.ceil(Math.max(p1.x, p2.x, p3.x, p4.x)) + 2);
  let minY = Math.max(0, Math.floor(Math.min(p1.y, p2.y, p3.y, p4.y)) - 2);
  let maxY = Math.min(MAP - 1, Math.ceil(Math.max(p1.y, p2.y, p3.y, p4.y)) + 2);
  
  X.save();
  // Center zoom scale around viewport camera center
  X.translate(Math.round(W/2), Math.round(H/2 + topH));
  X.scale(ZOOM, ZOOM);
  X.translate(-Math.round(W/2), -Math.round(H/2 + topH));

  // Draw ground tiles (only visible ones)
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++)drawTile(x,y);

  // Filter out expired corpses using wall-clock time so they still fade after game over
  corpses = corpses.filter(c => performance.now() - c.deathTime < 5000);
  
  // Find visible trees with wood resource remaining to depth-sort them dynamically
  let trees = [];
  for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
    if(map[y][x].t===TERRAIN.FOREST && map[y][x].res>0){
      trees.push({type:'tree', x:x, y:y});
    }
  }

  let allDrawable = [];
  entities.forEach(en => {
    // Only draw visible entities (either player's team or visible in fog)
    let f;
    if (en.type === 'building') {
      f = buildingFogLevel(en);
    } else {
      let ex = Math.round(en.x), ey = Math.round(en.y);
      f = (fog[ey] && fog[ey][ex] !== undefined) ? fog[ey][ex] : 0;
    }
    if (f === 0) return; // unexplored

    // Check if the entity is within visible range (culling)
    let enX = en.x, enY = en.y;
    if (en.type === 'building') {
      enX += (en.w || 1) / 2;
      enY += (en.h || 1) / 2;
    }
    if (enX < minX - 4 || enX > maxX + 4 || enY < minY - 4 || enY > maxY + 4) return;

    if (en.type === 'building' && en.btype === 'GATE') {
      let wallLineNS = en.h > en.w;
      allDrawable.push({
        type: 'gate_back',
        entity: en,
        x: en.x,
        y: en.y,
        sortVal: en.y + en.x + 0.1
      });
      allDrawable.push({
        type: 'gate_front',
        entity: en,
        x: wallLineNS ? en.x : en.x + 1,
        y: wallLineNS ? en.y + 1 : en.y,
        sortVal: (wallLineNS ? en.y + 1 : en.y) + (wallLineNS ? en.x : en.x + 1)
      });
    } else {
      let sortVal;
      if (en.type === 'building') {
        if (en.btype === 'FARM') sortVal = en.y + en.x + 0.05;
        else sortVal = en.y + (en.h || 1) / 2 + en.x + (en.w || 1) / 2;
      } else {
        if (en.utype === 'sheep_carcass') sortVal = en.y + en.x + 0.05;
        else sortVal = en.y + en.x + 0.25;
      }
      en.sortVal = sortVal;
      allDrawable.push(en);
    }
  });

  corpses.forEach(c => {
    if (c.x >= minX - 2 && c.x <= maxX + 2 && c.y >= minY - 2 && c.y <= maxY + 2) {
      c.sortVal = c.y + c.x;
      allDrawable.push(c);
    }
  });

  trees.forEach(t => {
    t.sortVal = t.y + t.x + 0.1;
    allDrawable.push(t);
  });

  allDrawable.sort((a, b) => a.sortVal - b.sortVal);

  allDrawable.forEach(e=>{
    // Fog of War checks for entities
    let ex = Math.round(e.x), ey = Math.round(e.y);
    let f;
    if (e.type === 'building') {
      f = buildingFogLevel(e);
    } else if (e.type === 'gate_back' || e.type === 'gate_front') {
      f = buildingFogLevel(e.entity);
    } else {
      f = (fog[ey] && fog[ey][ex] !== undefined) ? fog[ey][ex] : 0;
    }
    if (f === 0) return; // completely unexplored
    // Resolve the actual entity and team for gate proxy objects
    let realEntity = (e.type === 'gate_back' || e.type === 'gate_front') ? e.entity : e;
    let eTeam = realEntity ? realEntity.team : e.team;
    // Mark enemy buildings as seen when in active vision
    if (f === 2 && eTeam !== 0 && realEntity && realEntity.type === 'building') realEntity._seen = true;
    if (f === 1 && eTeam !== 0) {
      // explored but not visible: hide enemy units, corpses, and buildings never seen before
      if (e.type === 'unit' || e.type === 'corpse') return;
      if (realEntity && realEntity.type === 'building' && !realEntity._seen) return;
    }

    if(e.type==='building') drawBuilding(e);
    else if(e.type==='gate_back') drawBuilding(e.entity, 'back');
    else if(e.type==='gate_front') drawBuilding(e.entity, 'front');
    else if(e.type==='corpse') drawCorpse(e);
    else if(e.type==='tree') drawTreeEntity(e.x, e.y);
    else drawUnit(e);
  });
  
  drawProjectiles(); // Draw archer arrows
  drawParticles();   // Draw fire/dust/blood particles
  drawGhost();

  // Draw selected building's rally point flag & line (AoE2-style)
  if (selected.length > 0 && selected[0].type === 'building' && selected[0].team === 0) {
    let bldg = selected[0];
    let bData = BLDGS[bldg.btype];
    if (bData && bData.builds && bData.builds.length > 0 && bldg.rallyX !== undefined && bldg.rallyY !== undefined) {
      let bCenter = toIso(bldg.x + (bData.w || 1)/2, bldg.y + (bData.h || 1)/2);
      let rPos = toIso(bldg.rallyX + 0.5, bldg.rallyY + 0.5);
      
      let sx1 = bCenter.ix - camX + W/2;
      let sy1 = bCenter.iy - camY + H/2 + topH;
      let sx2 = rPos.ix - camX + W/2;
      let sy2 = rPos.iy - camY + H/2 + topH;
      
      // Draw dotted rally line
      X.strokeStyle = '#ffd700';
      X.lineWidth = 1.5;
      X.setLineDash([4, 4]);
      X.beginPath();
      X.moveTo(sx1, sy1);
      X.lineTo(sx2, sy2);
      X.stroke();
      X.setLineDash([]);
      
      // Draw small gold rally flag
      X.fillStyle = '#ffd700';
      X.fillRect(sx2 - 1, sy2 - 12, 2, 12); // pole
      X.beginPath();
      X.moveTo(sx2 + 1, sy2 - 12);
      X.lineTo(sx2 + 8, sy2 - 9);
      X.lineTo(sx2 + 1, sy2 - 6);
      X.closePath();
      X.fill();
    }
  }

  // Draw command markers (AoE2-style right-click feedback)
  cmdMarkers=cmdMarkers.filter(m=>tick-m.time<30);
  cmdMarkers.forEach(m=>{
    let iso=toIso(m.x+0.5,m.y+0.5);
    let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2;
    let age=(tick-m.time)/30;
    X.globalAlpha=1-age;
    X.strokeStyle=m.color;X.lineWidth=2;
    // Cross marker
    let sz=6+age*8;
    X.beginPath();X.moveTo(sx-sz,sy);X.lineTo(sx+sz,sy);X.stroke();
    X.beginPath();X.moveTo(sx,sy-sz);X.lineTo(sx,sy+sz);X.stroke();
    // Expanding circle
    X.beginPath();X.arc(sx,sy,sz+4,0,Math.PI*2);X.stroke();
    X.globalAlpha=1;
  });

  X.restore();

  drawSelection();


  drawMinimap();
}
