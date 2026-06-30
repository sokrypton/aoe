// ---- RENDERING ----
function drawTile(x,y){
  let f = fog[y] && fog[y][x];
  if (f === 0) return; // unexplored (completely black)

  let iso=toIso(x,y);
  let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2;
  if(sx<-TW*2||sx>W+TW*2||sy<-TH*4||sy>H+TH*4)return;
  let t=map[y][x];
  let cols=TCOL[t.t]||TCOL[0];
  let col=cols[(x*7+y*13)%cols.length];
  X.fillStyle=col;
  X.beginPath();
  X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
  X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
  X.closePath();X.fill();
  let cy=sy+HALF_TH;

  if(t.t===TERRAIN.GOLD){
    let s=0.3+0.7*Math.min(t.res/800,1);
    // Dark rock outcrop base
    X.fillStyle='#4c4c44';X.beginPath();
    X.moveTo(sx-11*s, cy);X.lineTo(sx+11*s, cy+2);
    X.lineTo(sx+6*s, cy-6*s);X.lineTo(sx-8*s, cy-4*s);X.closePath();
    X.fill();
    X.strokeStyle='#000000';X.lineWidth=1;X.stroke();

    // Jagged gold crystal nuggets (3D faceted)
    let drawGoldNugget = (nx, ny, sz) => {
      X.strokeStyle='#000000';X.lineWidth=1;
      X.fillStyle='#c59f08';X.beginPath(); // shadow facet
      X.moveTo(nx, ny);X.lineTo(nx-sz, ny-sz*0.5);X.lineTo(nx, ny-sz*2);X.closePath();X.fill();X.stroke();
      X.fillStyle='#ffd700';X.beginPath(); // highlight facet
      X.moveTo(nx, ny);X.lineTo(nx+sz, ny-sz*0.5);X.lineTo(nx, ny-sz*2);X.closePath();X.fill();X.stroke();
      X.fillStyle='#ffffff';X.beginPath(); // specular glint
      X.moveTo(nx, ny-sz*2);X.lineTo(nx-sz*0.2, ny-sz*1.5);X.lineTo(nx+sz*0.2, ny-sz*1.5);X.closePath();X.fill();
    };
    drawGoldNugget(sx-4*s, cy-1*s, 5*s);
    drawGoldNugget(sx+5*s, cy-2*s, 4*s);
    drawGoldNugget(sx, cy-5*s, 6*s);
  }
  if(t.t===TERRAIN.STONE){
    let s=0.3+0.7*Math.min(t.res/350,1);
    // Rough chiseled rock boulders (light/dark facets)
    let drawStoneBoulder = (bx, by, w, h) => {
      X.strokeStyle='#000000';X.lineWidth=1;
      X.fillStyle='#6b6b6b';X.beginPath(); // shadow face
      X.moveTo(bx, by);X.lineTo(bx-w, by-h*0.3);X.lineTo(bx-w*0.5, by-h);X.lineTo(bx+w*0.5, by-h);X.closePath();X.fill();X.stroke();
      X.fillStyle='#999999';X.beginPath(); // highlight face
      X.moveTo(bx, by);X.lineTo(bx+w, by-h*0.3);X.lineTo(bx+w*0.5, by-h);X.lineTo(bx-w*0.5, by-h);X.closePath();X.fill();X.stroke();
    };
    drawStoneBoulder(sx-6*s, cy+1*s, 6*s, 7*s);
    drawStoneBoulder(sx+6*s, cy+2*s, 5*s, 6*s);
    drawStoneBoulder(sx, cy-4*s, 7*s, 8*s);
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

  // Explored but out of sight overlay
  if (f === 1) {
    X.fillStyle = 'rgba(0, 0, 0, 0.45)';
    X.beginPath();
    X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
    X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
    X.closePath();X.fill();
  }
}

function drawStump(sx, cy, s) {
  X.fillStyle = '#000000';
  X.beginPath();
  X.moveTo(sx - 4.5 * s, cy + 2 * s);
  X.lineTo(sx + 4.5 * s, cy + 2 * s);
  X.lineTo(sx + 3.2 * s, cy - 8 * s);
  X.lineTo(sx - 3.2 * s, cy - 8 * s);
  X.closePath(); X.fill();
  
  X.fillStyle = '#8B4513';
  X.beginPath();
  X.moveTo(sx - 3.5 * s, cy + 2 * s);
  X.lineTo(sx + 3.5 * s, cy + 2 * s);
  X.lineTo(sx + 2.2 * s, cy - 8 * s);
  X.lineTo(sx - 2.2 * s, cy - 8 * s);
  X.closePath(); X.fill();
  
  X.fillStyle = '#cd853f';
  X.beginPath();
  X.ellipse(sx, cy - 8 * s, 2.2 * s, 1.0 * s, 0, 0, Math.PI * 2); X.fill();
  X.strokeStyle = '#000000'; X.lineWidth = 1; X.stroke();
}

function drawFullTreeBody(sx, cy, s) {
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
  X.fillStyle = '#8B4513';
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
  X.fillStyle = '#2e8b1d';
  bubbles.forEach(b => {
    X.beginPath();
    X.arc(sx + b.x * s, cy + b.y * s, b.r * s, 0, Math.PI * 2);
    X.fill();
  });
  
  // 3. Cell-Shaded Mid-Light Highlights
  X.fillStyle = '#52be3a';
  bubbles.forEach(b => {
    X.beginPath();
    X.arc(sx + (b.x - b.r * 0.15) * s, cy + (b.y - b.r * 0.15) * s, b.r * 0.75 * s, 0, Math.PI * 2);
    X.fill();
  });
  
  // 4. Bright Lime Sunlit Tips (Extra pop)
  X.fillStyle = '#99e550';
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
  let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2;
  let cy=sy+HALF_TH;
  let t=map[y][x];
  if(!t || t.res<=0) return;

  // 1. Organic height and scale variability
  let sizeNoise = 0.8 + ((x * 17 + y * 23) % 5) * 0.08;
  let s = 1.05 * sizeNoise;
  
  // 2. Dynamic Wind Sway & Traveling Gust of Wind
  let windPhase = tick * 0.015 + x * 0.45 + y * 0.35;
  let sway = Math.sin(windPhase) * 0.035;
  let gust = Math.max(0, Math.sin(tick * 0.004 - (x + y) * 0.07) - 0.4) * 0.16;
  let totalSway = sway + gust;

  // Initialize fell tick for falling tree animation
  if(t.res <= 60 && t.fellTick === undefined){
    t.fellTick = tick;
  }

  // Calculate fall progress and angle
  let fallAngle = 0;
  let isFalling = false;
  if(t.fellTick !== undefined && t.fellTick > 0){
    let dt = tick - t.fellTick;
    if(dt < 40){
      isFalling = true;
      let progress = dt / 40;
      fallAngle = progress * (Math.PI / 2.15); // Fall sideways
    }
  }

  if(t.res > 60 || isFalling){
    // Stage 1: Standing or falling full tree
    X.save();
    X.translate(sx, cy);
    X.rotate(totalSway + fallAngle);
    X.translate(-sx, -cy);
    
    drawFullTreeBody(sx, cy, s);
    
    X.restore();
  } else if(t.res > 20){
    // Stage 2: Standing stump AND fallen tree lying on the ground!
    // A. Standing stump
    drawStump(sx, cy, s);
    
    // B. Fallen tree flat on ground
    X.save();
    X.translate(sx, cy);
    X.rotate(Math.PI / 2.15); // lie flat!
    X.translate(-sx, -cy);
    
    drawFullTreeBody(sx, cy, s);
    
    X.restore();
  } else {
    // Stage 3: Standing stump only
    drawStump(sx, cy, s);
  }

  // Fog of War tree shadow overlay
  if (f === 1) {
    X.fillStyle = 'rgba(0, 0, 0, 0.45)';
    X.beginPath();
    X.arc(sx, cy - 18 * s, 16 * s, 0, Math.PI * 2);
    X.fill();
  }
}

// ---- MODULAR ISOMETRIC RENDERING HELPERS ----

// Draws a half-length wall slab from a pillar center toward the midpoint with a neighbor.
// sx,sy: start screen pos (pillar center base)
// dx,dy: screen offset to the midpoint (half tile: ±16, ±8)
// wallH: height of the wall slab in pixels
function drawWallLink(sx, sy, dx, dy, wallH) {
  let ex = sx + dx, ey = sy + dy;
  // Determine which iso axis the wall runs along:
  //   iso Y axis (NE-SW): dx and dy have opposite signs → thickness along iso X = (+4, +2)
  //   iso X axis (NW-SE): dx and dy have same sign    → thickness along iso Y = (-4, +2)
  let isAlongIsoY = (dx > 0) !== (dy > 0);
  let px = isAlongIsoY ? 4 : -4;
  let py = 2; // always +2 (both perpendiculars have same Y component)

  X.strokeStyle = '#000'; X.lineWidth = 1.3; X.lineJoin = 'round';

  // 1. Visible side face (SE face for iso-Y walls, SW face for iso-X walls)
  X.fillStyle = isAlongIsoY ? '#adada0' : '#cfcfc4';
  X.beginPath();
  X.moveTo(sx + px, sy + py);              // near-bottom
  X.lineTo(ex + px, ey + py);              // far-bottom
  X.lineTo(ex + px, ey + py - wallH);      // far-top
  X.lineTo(sx + px, sy + py - wallH);      // near-top
  X.closePath(); X.fill(); X.stroke();

  // 2. Top walkway face
  X.fillStyle = '#b8b8b0';
  X.beginPath();
  X.moveTo(sx - px, sy - py - wallH);      // near NW/NE edge
  X.lineTo(sx + px, sy + py - wallH);      // near SE/SW edge
  X.lineTo(ex + px, ey + py - wallH);      // far SE/SW edge
  X.lineTo(ex - px, ey - py - wallH);      // far NW/NE edge
  X.closePath(); X.fill(); X.stroke();
}

// Draws a 3D isometric building block with Left/Right walls and Flat or Peaked roof
function drawBuildingBlock(sx,sy,bw,bhh,bh,wallL,wallR,roofType,roofH,roofL,roofR){
  let strokeColor = '#000000';
  X.strokeStyle = strokeColor;
  X.lineWidth = 1.3;
  X.lineJoin = 'round';

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
    // Top face base diamond
    X.fillStyle=roofL;X.beginPath();
    X.moveTo(sx,sy-bh);X.lineTo(sx+bw,sy+bhh-bh);
    X.lineTo(sx,sy+bhh*2-bh);X.lineTo(sx-bw,sy+bhh-bh);X.closePath();X.fill();X.stroke();
    // Shaded right half for 3D depth
    X.fillStyle=roofR;X.beginPath();
    X.moveTo(sx,sy-bh);X.lineTo(sx+bw,sy+bhh-bh);
    X.lineTo(sx,sy+bhh*2-bh);X.closePath();X.fill();X.stroke();
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
}

// Draws a skewed wooden door sits flat against the Left Wall
function drawDoorLeft(sx,sy,bw,bhh,color){
  X.fillStyle=color;X.beginPath();
  X.moveTo(sx-bw*0.625,sy+bhh*1.375);X.lineTo(sx-bw*0.375,sy+bhh*1.625);
  X.lineTo(sx-bw*0.375,sy+bhh*1.625-8);X.lineTo(sx-bw*0.625,sy+bhh*1.375-8);X.closePath();
  X.fill();
  X.strokeStyle='#000000';X.lineWidth=1;X.stroke();
}

// Draws a double gate wrapping the bottom corner of a building block
function drawCornerDoubleGate(sx,sy,bhh,gateH,colorL,colorR){
  X.strokeStyle='#000000';X.lineWidth=1;
  // Left leaf
  X.fillStyle=colorL;X.beginPath();
  X.moveTo(sx-6,sy+bhh*2-3);X.lineTo(sx,sy+bhh*2);
  X.lineTo(sx,sy+bhh*2-gateH);X.lineTo(sx-6,sy+bhh*2-gateH-3);X.closePath();X.fill();X.stroke();
  // Right leaf
  X.fillStyle=colorR;X.beginPath();
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
    
    // Direction vectors (isometric skewed projection)
    let dx = Math.cos(a);
    let dy = -Math.cos(a)*0.5 - Math.sin(a)*1.1;
    let px = -Math.sin(a);
    let py = Math.sin(a)*0.5 - Math.cos(a)*1.1;
    
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
function drawBuilding(e, part = null){
  let b=BLDGS[e.btype];
  let cx=e.x+b.w/2,cy=e.y+b.h/2;
  let iso=toIso(cx,cy);
  let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2;
  if(sx<-100||sx>W+100||sy<-100||sy>H+100)return;
  let bw=b.w*HALF_TW, bhh=b.h*HALF_TH;
  sy-=bhh;
  if(!e.complete) X.globalAlpha=0.5+e.buildProgress/e.buildTime*0.5;
  let tc=e.team===0?'#2266bb':'#cc4444';
  let tcD=e.team===0?'#1a4488':'#993333';
  let bh=10;

  let strokeColor = '#000000';
  X.strokeStyle = strokeColor;
  X.lineWidth = 1.3;
  X.lineJoin = 'round';

  if(e.btype==='TC'){
    // 4-Block modular TC layout
    // 1. Tall Main Keep Tower
    drawBuildingBlock(sx, sy+6, 26, 13, 40, '#e0e0d8','#bcbcb0','flat',0,tc,tcD);
    // Corner Turrets on main keep tower roof
    drawBuildingBlock(sx-26, sy+6-40+13, 4, 2, 8, '#e0e0d8','#bcbcb0','flat',0,tc,tcD);
    drawBuildingBlock(sx+26, sy+6-40+13, 4, 2, 8, '#e0e0d8','#bcbcb0','flat',0,tc,tcD);
    
    // 2. Left Annex Wing
    drawBuildingBlock(sx-32, sy+22, 26, 13, 22, '#d0d0c8','#acac9c','flat',0,tc,tcD);
    // 3. Right Annex Great Hall
    drawBuildingBlock(sx+32, sy+22, 26, 13, 22, '#d0d0c8','#acac9c','flat',0,tc,tcD);
    // 4. Low Gatehouse Entrance
    drawBuildingBlock(sx, sy+44, 20, 10, 14, '#c0c0b8','#a0a098','flat',0,'#606058','#505048');
    // Double Gate on Gatehouse front corner (with drawbridge chains)
    drawCornerDoubleGate(sx, sy+44, 10, 10, '#3e2715','#5c3d24');
    
    X.strokeStyle='#000000';X.lineWidth=1;
    X.beginPath();
    X.moveTo(sx, sy+64-10);X.lineTo(sx-4, sy+64-11);
    X.moveTo(sx, sy+64-10);X.lineTo(sx+4, sy+64-11);
    X.stroke();

    // Window slits on main keep
    X.fillStyle='#000000';
    X.fillRect(sx-10, sy+6-40+5, 2, 5);
    X.strokeRect(sx-10, sy+6-40+5, 2, 5);
    X.fillRect(sx+10, sy+6-40+5, 2, 5);
    X.strokeRect(sx+10, sy+6-40+5, 2, 5);
    // Waving flag on main keep tower top
    if(e.complete) drawWavingFlag(sx, sy+6, 40, tc, tcD);
  }
  else if(e.btype==='HOUSE'){
    bh=15;
    // Timber cottage
    drawBuildingBlock(sx,sy,bw,bhh,bh, '#ebd2b0','#d2b48c','peaked',15,tc,tcD);
    // Tudor half-timbered cross beams
    X.strokeStyle='#000000';X.lineWidth=2;
    X.beginPath();
    X.moveTo(sx-16, sy+9);X.lineTo(sx-16, sy+24);
    X.moveTo(sx-32, sy+16);X.lineTo(sx, sy+17);
    X.moveTo(sx-32, sy+1);X.lineTo(sx, sy+32);
    X.moveTo(sx+16, sy+9);X.lineTo(sx+16, sy+24);
    X.moveTo(sx, sy+17);X.lineTo(sx+32, sy+16);
    X.moveTo(sx, sy+32);X.lineTo(sx+32, sy+1);
    X.stroke();
    // Door centered on Left wall
    drawDoorLeft(sx,sy,bw,bhh,'#5c3d24');
    // Chimney & smoke
    let chx = sx + bw*0.4, chy = sy + bhh*0.4 - bh;
    X.fillStyle='#8a4030';X.fillRect(chx-2,chy-8,4,10);
    X.strokeStyle='#000000';X.lineWidth=1;X.strokeRect(chx-2,chy-8,4,10);
    X.fillStyle='#602820';X.fillRect(chx-2,chy-10,4,2);
    X.strokeRect(chx-2,chy-10,4,2);
    if(e.complete) drawChimneySmoke(chx,chy-10);
  }
  else if(e.btype==='BARRACKS'){
    // 1. Garrison Annex / Sleeping Quarters
    drawBuildingBlock(sx, sy+12, 20, 10, 16, '#b89868','#987848','peaked',10,tc,tcD);
    
    // 2. Main Garrison Longhouse
    drawBuildingBlock(sx-32, sy+22, 26, 13, 18, '#b89868','#987848','peaked',12,tc,tcD);
    // Hanging shields on Garrison Left wall
    X.strokeStyle='#000000';X.lineWidth=1;
    X.fillStyle='#a0a0a0';X.beginPath();X.arc(sx-44, sy+19, 3, 0, Math.PI*2);X.fill();X.stroke();
    X.fillStyle=tc;X.beginPath();X.arc(sx-44, sy+19, 1.5, 0, Math.PI*2);X.fill();X.stroke();
    X.fillStyle='#a0a0a0';X.beginPath();X.arc(sx-20, sy+31, 3, 0, Math.PI*2);X.fill();X.stroke();
    X.fillStyle=tc;X.beginPath();X.arc(sx-20, sy+31, 1.5, 0, Math.PI*2);X.fill();X.stroke();
    // Door on Garrison left wall
    drawDoorLeft(sx-32, sy+22, 26, 13, '#5c3d24');
    
    // 3. Corner Stone Watchtower
    drawBuildingBlock(sx+32, sy+32, 16, 8, 30, '#cfcfc4','#adada0','flat',0,'#606058','#505048');
    // Crenellations on tower top
    X.fillStyle='#8d8d80';
    X.fillRect(sx+32-6, sy+32-30+8-3, 3, 3);
    X.strokeStyle='#000000';X.lineWidth=1;X.strokeRect(sx+32-6, sy+32-30+8-3, 3, 3);
    X.fillRect(sx+32+2, sy+32-30+8-3, 3, 3);
    X.strokeRect(sx+32+2, sy+32-30+8-3, 3, 3);
    // Flag on tower top
    if(e.complete) drawWavingFlag(sx+32, sy+32, 30, tc, tcD);

    // 4. Fenced Training Yard
    X.fillStyle='#bfa38a';X.beginPath();
    X.moveTo(sx,sy+32);X.lineTo(sx+32,sy+48);
    X.lineTo(sx,sy+64);X.lineTo(sx-32,sy+48);X.closePath();
    X.fill();
    X.strokeStyle='#000000';X.lineWidth=1.2;X.stroke();
    
    // Archery target board
    let tgx=sx+10, tgy=sy+44;
    X.strokeStyle='#000000';X.lineWidth=1.5;
    X.beginPath();X.moveTo(tgx,tgy);X.lineTo(tgx,tgy-8);X.stroke();
    X.fillStyle='#fff';X.beginPath();X.arc(tgx,tgy-8,3.5,0,Math.PI*2);X.fill();X.stroke();
    X.fillStyle='#c00';X.beginPath();X.arc(tgx,tgy-8,1.5,0,Math.PI*2);X.fill();X.stroke();
    
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
    bh=10;
    // Wood camp shelter
    drawBuildingBlock(sx,sy,bw,bhh,bh, '#c6a880','#a68860','flat',0,'#d2b48c','#b59975');
    // Log pile & wood chopping stump
    if(e.complete){
      let lx = sx-bw*0.6, ly = sy+bhh*1.3;
      X.fillStyle='#6e473b';
      X.fillRect(lx-10,ly-5,16,6);
      X.strokeStyle='#000000';X.lineWidth=1;X.strokeRect(lx-10,ly-5,16,6);
      X.fillRect(lx-6,ly-9,12,6);
      X.strokeRect(lx-6,ly-9,12,6);
      X.fillStyle='#ebd2b0';
      X.beginPath();X.arc(lx-10,ly-2,3,0,Math.PI*2);X.fill();X.stroke();
      X.beginPath();X.arc(lx-6,ly-6,3,0,Math.PI*2);X.fill();X.stroke();

      // Chopping block stump next to logs
      let cbx = sx-2, cby = sy+bhh*1.5;
      X.fillStyle='#8a5a3a';X.fillRect(cbx-3, cby-4, 6, 5);
      X.strokeStyle='#000000';X.strokeRect(cbx-3, cby-4, 6, 5);
      X.fillStyle='#ebd2b0';X.beginPath();X.ellipse(cbx,cby-4,3,1.5,0,0,Math.PI*2);X.fill();X.stroke();
      // Axe sticking in stump
      X.strokeStyle='#000000';X.lineWidth=1;
      X.beginPath();X.moveTo(cbx,cby-4);X.lineTo(cbx-3,cby-8);X.stroke();
    }
  }
  else if(e.btype==='MCAMP'){
    bh=10;
    // Mining camp lean-to
    drawBuildingBlock(sx,sy,bw,bhh,bh, '#c6a880','#a68860','flat',0,'#9f886c','#826f57');
    // Gold & Stone nugget pile & pickaxes
    if(e.complete){
      let mx = sx+bw*0.6, my = sy+bhh*1.3;
      X.strokeStyle='#000000';X.lineWidth=1;
      X.fillStyle='#ffd700';X.beginPath();X.arc(mx,my,4,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle='#daa520';X.beginPath();X.arc(mx-2,my+1,2.5,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle='#777';X.beginPath();X.arc(mx-8,my+2,3.5,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle='#999';X.beginPath();X.arc(mx-6,my-1,2.5,0,Math.PI*2);X.fill();X.stroke();

      // Pickaxes leaning against left wall support
      let px = sx-bw*0.4, py = sy+bhh*1.1;
      X.strokeStyle='#000000';X.lineWidth=1;
      X.beginPath();X.moveTo(px,py);X.lineTo(px-4,py-8);X.stroke();
      X.lineWidth=1.5;
      X.beginPath();X.moveTo(px-6,py-8);X.lineTo(px-2,py-8);X.stroke();
    }
  }
  else if(e.btype==='MILL'){
    bh=18;
    // Conical tower
    drawBuildingBlock(sx,sy,bw*0.7,bhh*0.7,bh, '#dcd0a0','#bca880','conical',16,'#a65c3b','#863c20');
    // Sails & flour sacks
    if(e.complete){
      drawWindmillSails(sx-bw*0.35,sy-bh+4,e.id);
      
      // Flour sacks piled at the base
      let fx = sx+bw*0.4, fy = sy+bhh*1.2;
      X.strokeStyle='#000000';X.lineWidth=1;
      X.fillStyle='#e5dcd0';X.beginPath();X.ellipse(fx,fy,4,3,0,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle='#c8bdae';X.beginPath();X.ellipse(fx,fy-2,3,2,0,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle='#d5ccbe';X.beginPath();X.ellipse(fx-5,fy+2,4,3,0,0,Math.PI*2);X.fill();X.stroke();
    }
  }
  else if(e.btype==='TOWER'){
    bh=36;
    let linkY = sy + 16;
    let wallH = 14;
    let getB = (tx, ty) => entities.find(en => en.type === 'building' && en.x === tx && en.y === ty);

    // South neighbor (y+1)
    let sB = getB(e.x, e.y + 1);
    if (sB) {
      if (sB.btype === 'WALL' || sB.btype === 'TOWER') {
        drawWallLink(sx, linkY, -32, 16, wallH);
      } else if (sB.btype === 'GATE') {
        if (sB.h > sB.w) drawWallLink(sx, linkY, -32, 16, wallH);
      }
    }

    // East neighbor (x+1)
    let eB = getB(e.x + 1, e.y);
    if (eB) {
      if (eB.btype === 'WALL' || eB.btype === 'TOWER') {
        drawWallLink(sx, linkY, 32, 16, wallH);
      } else if (eB.btype === 'GATE') {
        if (eB.w > eB.h) drawWallLink(sx, linkY, 32, 16, wallH);
      }
    }

    // Castle Age Watch Tower — 3 stacked blocks (centered at sy+16)
    drawBuildingBlock(sx, sy+9, 14, 7, 22, '#c8c8bc', '#a8a89c', 'flat', 0, '#b0b0a4', '#989890');
    drawBuildingBlock(sx, sy+9-22, 16, 8, 6, '#b89868', '#987848', 'flat', 0, '#a08050', '#806030');
    drawBuildingBlock(sx, sy+9-28, 12, 6, 8, '#c8c8bc', '#a8a89c', 'flat', 0, tc, tcD);
    if (e.complete) drawWavingFlag(sx, sy+9, 44, tc, tcD);
  }
  else if(e.btype==='WALL'){
    bh=14;
    let pillarH = 22;
    let wallH = 14;   // lower than pillar to create bastion crenellated effect
    let linkY = sy + 16;
    let getB = (tx, ty) => entities.find(en => en.type === 'building' && en.x === tx && en.y === ty);

    // 1. Draw central pillar first (so that front-facing links connect on top of its base)
    drawBuildingBlock(sx, sy+11.5, 9, 4.5, pillarH, '#c8c8bc', '#a8a89c', 'flat', 0, '#b0b0a4', '#989890');

    // 2. Draw South and East links second (running towards the front, overlapping the pillar)
    // South neighbor (y+1)
    let sB = getB(e.x, e.y + 1);
    if (sB) {
      if (sB.btype === 'WALL' || sB.btype === 'TOWER') {
        drawWallLink(sx, linkY, -32, 16, wallH);
      } else if (sB.btype === 'GATE') {
        if (sB.h > sB.w) drawWallLink(sx, linkY, -32, 16, wallH);
      }
    }

    // East neighbor (x+1)
    let eB = getB(e.x + 1, e.y);
    if (eB) {
      if (eB.btype === 'WALL' || eB.btype === 'TOWER') {
        drawWallLink(sx, linkY, 32, 16, wallH);
      } else if (eB.btype === 'GATE') {
        if (eB.w > eB.h) drawWallLink(sx, linkY, 32, 16, wallH);
      }
    }
  }

  else if(e.btype==='GATE'){
    let pillarH = 22;
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

    if (part === 'back' || part === null) {
      // Draw back post (Tower 1)
      drawBuildingBlock(t1sx, t1sy - 4.5, 9, 4.5, pillarH, '#c8c8bc', '#a8a89c', 'flat', 0, '#b0b0a4', '#989890');

      if (e.complete) {
        let gp = e.gateProgress || 0;
        let slideY = gp * 22;
        let dx = t2sx - t1sx, dy = t2sy - t1sy;

        // Ground shadow
        X.strokeStyle = 'rgba(0,0,0,0.3)'; X.lineWidth = 2.5;
        X.beginPath();
        X.moveTo(t1sx, t1sy); X.lineTo(t2sx, t2sy);
        X.stroke();

        // Sliding portcullis bars
        X.strokeStyle = '#3a2515'; X.lineWidth = 1.8;
        let barCount = 7;
        for (let i = 1; i <= barCount; i++) {
          let t = i / (barCount + 1);
          let bx = t1sx + t * dx;
          let by = t1sy + t * dy;
          X.beginPath();
          X.moveTo(bx, by - slideY);
          X.lineTo(bx, by - 22 - slideY);
          X.stroke();
        }

        // Horizontal diagonal lattice bars
        X.strokeStyle = '#111'; X.lineWidth = 1.2;
        X.beginPath();
        X.moveTo(t1sx, t1sy - 7 - slideY); X.lineTo(t2sx, t2sy - 7 - slideY);
        X.moveTo(t1sx, t1sy - 15 - slideY); X.lineTo(t2sx, t2sy - 15 - slideY);
        X.stroke();

        // Lintel arch bridging the two towers (drawn as part of the back-to-mid layer)
        drawWallLink(t1sx, t1sy - pillarH, dx, dy, 5);
      }
      if (part === 'back') {
        X.globalAlpha = 1;
        return;
      }
    }

    if (part === 'front' || part === null) {
      // Draw front post (Tower 2)
      drawBuildingBlock(t2sx, t2sy - 4.5, 9, 4.5, pillarH, '#c8c8bc', '#a8a89c', 'flat', 0, '#b0b0a4', '#989890');

      // Draw connection links
      let wallH = 14;
      if (wallLineNS) {
        let sB = entities.find(en => en.type === 'building' && en.x === e.x && en.y === e.y + 2);
        if (sB && (sB.btype === 'WALL' || sB.btype === 'TOWER')) {
          drawWallLink(t2sx, t2sy, -32, 16, wallH);
        }
      } else {
        let eB = entities.find(en => en.type === 'building' && en.x === e.x + 2 && en.y === e.y);
        if (eB && (eB.btype === 'WALL' || eB.btype === 'TOWER')) {
          drawWallLink(t2sx, t2sy, 32, 16, wallH);
        }
      }
    }
  }
  else if(e.btype==='FARM'){
    bh=0;
    let tileRes=map[e.y]&&map[e.y][e.x]?map[e.y][e.x].res:0;
    let growth=tileRes/(e.maxFood||300);
    if(growth>0){
      let cropH=3+growth*8;
      let cropCount=Math.max(2,Math.ceil(9*growth));
      let cropColor=growth>0.5?'#5a9828':'#8a9838';
      for(let i=0;i<cropCount;i++){
        let row=Math.floor(i/3), col=i%3-1;
        let cy2=sy+bhh*0.5+row*bhh*0.4;
        let cx2=sx+col*bw*0.25;
        X.strokeStyle=cropColor;X.lineWidth=1.2;
        X.beginPath();X.moveTo(cx2,cy2);X.lineTo(cx2,cy2-cropH);X.stroke();
        if(growth>0.3){
          X.fillStyle=growth>0.6?'#6aaa30':'#aa9a30';
          X.beginPath();X.arc(cx2,cy2-cropH,1.5+growth,0,Math.PI*2);X.fill();
          X.strokeStyle='#000000';X.lineWidth=0.75;X.stroke();
        }
      }
    }
  }

  X.globalAlpha=1;

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
  // Selection
  if(selected.includes(e)){
    X.strokeStyle='#fff';X.lineWidth=2;X.setLineDash([3,3]);
    X.beginPath();
    X.moveTo(sx,sy);X.lineTo(sx+bw+2,sy+bhh);X.lineTo(sx,sy+bhh*2+2);X.lineTo(sx-bw-2,sy+bhh);X.closePath();X.stroke();
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

  // Fog of War building shadow overlay
  let f = fog[e.y] && fog[e.y][e.x];
  if (f === 1) {
    X.fillStyle = 'rgba(0, 0, 0, 0.45)';
    X.beginPath();
    X.moveTo(sx, sy);
    X.lineTo(sx + bw, sy + bhh);
    X.lineTo(sx, sy + bhh*2);
    X.lineTo(sx - bw, sy + bhh);
    X.closePath();
    X.fill();
  }
}



function drawCorpse(c){
  let iso=toIso(c.x,c.y);
  let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2+HALF_TH;
  if(sx<-50||sx>W+50||sy<-50||sy>H+50)return;
  
  let idOff=c.id%7;
  sx+=(idOff%3-1)*6; sy+=(Math.floor(idOff/3)-1)*4;
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
  let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2+HALF_TH;
  if(sx<-50||sx>W+50||sy<-50||sy>H+50)return;
  // Group spread: offset based on unit ID so stacked units are visible
  let idOff=e.id%7;
  sx+=(idOff%3-1)*6; sy+=(Math.floor(idOff/3)-1)*4;
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
  let targetDy = 0;
  if(tx !== -1 && ty !== -1){
    let targetIso = toIso(tx, ty);
    let targetSx = targetIso.ix - camX + W/2;
    targetDx = targetSx - sx;
    // targetSy must match the sy formula (which includes +HALF_TH) so the delta is correct
    let targetSy = targetIso.iy - camY + topH + H/2 + HALF_TH;
    targetDy = targetSy - sy;
  }
  if(targetDx !== 0){
    e.facing = targetDx > 0 ? 1 : -1;
  } else if(e.lastSx!==undefined){
    let diff = sx - e.lastSx;
    if(Math.abs(diff) > 0.1) e.facing = diff > 0 ? 1 : -1;
  }
  if(targetDy !== 0){
    e.facingNorth = targetDy < 0;
  } else if(e.lastSy!==undefined){
    let diffY = sy - e.lastSy;
    if(Math.abs(diffY) > 0.1) e.facingNorth = diffY < 0;
  }
  e.lastSx = sx;
  e.lastSy = sy;

  // Torso / Head bobbing
  let bob=e.path.length>0?Math.sin(tick*0.3+e.id)*1.5:0;
  let sbob=e.path.length>0?Math.sin(tick*0.2+e.id)*1:0;

  // Save context and apply horizontal flipping based on facing direction
  X.save();
  if(e.utype==='sheep') X.translate(sx, sy + sbob);
  else X.translate(sx, sy + bob);
  X.scale(e.facing, 1);

  // --- DRAW FLIPPABLE STUFF ---
  if(e.utype!=='sheep'){
    let humanXOffset = e.utype === 'scout' ? -3 : 0;
    let humanYOffset = e.utype === 'scout' ? -8 : 0;

    // Walking leg cycle (swinging legs with constant leg length)
    if(e.utype==='scout'){
      // Horse legs drawn as simple black lines matching human styling
      let walk = e.path.length>0 ? Math.sin(tick*0.45+e.id)*4.5 : 0;
      X.strokeStyle = '#000000'; X.lineWidth = 1.8;
      X.beginPath();
      // Front legs
      X.moveTo(3, -4); X.lineTo(3+walk, 2);
      X.moveTo(5, -4); X.lineTo(5-walk, 2);
      // Back legs
      X.moveTo(-6, -4); X.lineTo(-6+walk, 2);
      X.moveTo(-8, -4); X.lineTo(-8-walk, 2);
      X.stroke();
    } else {
      // Human legs (visible both when standing and walking)
        let walk = e.path.length>0 ? Math.sin(tick*0.4+e.id)*2.5 : 0;
      X.strokeStyle = '#000000'; X.lineWidth = 1.8;
      X.beginPath();
      X.moveTo(-2+humanXOffset, -bob); X.lineTo(-2-walk+humanXOffset, 3-bob);
      X.moveTo(2+humanXOffset, -bob); X.lineTo(2+walk+humanXOffset, 3-bob);
      X.stroke();
    }

    // Horse body drawn under the rider
    if(e.utype==='scout'){
      // Direction-aware neck/head: E/S = head to the right, N/W = head raised upward
      let hNorth = e.facingNorth;

      // Outline silhouette (black, drawn first slightly larger)
      X.fillStyle='#000000';
      X.beginPath(); X.rect(-6.8, -8.8, 10.6, 7.6); X.fill();          // saddle blanket outline
      X.beginPath(); X.ellipse(-4, -4, 7.3, 6.8, 0, 0, Math.PI*2); X.fill();  // rump outline
      X.beginPath(); X.ellipse(2, -5, 6.8, 6.3, 0, 0, Math.PI*2); X.fill();   // chest outline

      if(hNorth){
        // Neck raised, head pointing upper-right (away from camera)
        X.beginPath(); X.ellipse(4, -12, 4.0, 7.0, -Math.PI/3, 0, Math.PI*2); X.fill(); // neck outline
        X.beginPath(); X.ellipse(5, -18, 4.2, 3.0, -Math.PI/3, 0, Math.PI*2); X.fill(); // head outline
        X.beginPath(); X.ellipse(6.5, -16.5, 2.6, 2.0, -Math.PI/3, 0, Math.PI*2); X.fill(); // snout outline
        X.beginPath(); X.ellipse(2, -21, 1.8, 3.0, -Math.PI/6, 0, Math.PI*2); X.fill();  // ear1 outline
        X.beginPath(); X.ellipse(5, -21, 1.8, 3.0, -Math.PI/6, 0, Math.PI*2); X.fill();  // ear2 outline
      } else {
        // Neck forward, head to the right (E/S direction)
        X.beginPath(); X.ellipse(5, -9, 4.6, 8.3, -Math.PI/6, 0, Math.PI*2); X.fill();   // neck outline
        X.beginPath(); X.ellipse(9, -13, 4.6, 3.3, -Math.PI/6, 0, Math.PI*2); X.fill();  // head outline
        X.beginPath(); X.ellipse(11, -11.5, 3.0, 2.6, -Math.PI/12, 0, Math.PI*2); X.fill(); // snout outline
        X.beginPath(); X.ellipse(6, -16.5, 2.0, 3.3, -Math.PI/12, 0, Math.PI*2); X.fill(); // ear1 outline
        X.beginPath(); X.ellipse(8.5, -15.5, 2.0, 3.3, -Math.PI/12, 0, Math.PI*2); X.fill(); // ear2 outline
      }

      // Colored fills
      X.fillStyle=tc;
      X.beginPath(); X.rect(-6, -8, 9, 6); X.fill();   // saddle blanket
      X.fillStyle='#8b5a2b';
      X.beginPath(); X.ellipse(-4, -4, 6.5, 6.0, 0, 0, Math.PI*2); X.fill(); // rump
      X.beginPath(); X.ellipse(2, -5, 6.0, 5.5, 0, 0, Math.PI*2); X.fill();  // chest

      if(hNorth){
        X.beginPath(); X.ellipse(4, -12, 3.2, 6.2, -Math.PI/3, 0, Math.PI*2); X.fill(); // neck
        X.beginPath(); X.ellipse(5, -18, 3.4, 2.2, -Math.PI/3, 0, Math.PI*2); X.fill(); // head
        X.beginPath(); X.ellipse(6.5, -16.5, 1.8, 1.2, -Math.PI/3, 0, Math.PI*2); X.fill(); // snout
        X.beginPath(); X.ellipse(2, -21, 1.0, 2.2, -Math.PI/6, 0, Math.PI*2); X.fill();  // ear1
        X.beginPath(); X.ellipse(5, -21, 1.0, 2.2, -Math.PI/6, 0, Math.PI*2); X.fill();  // ear2
      } else {
        X.beginPath(); X.ellipse(5, -9, 3.8, 7.5, -Math.PI/6, 0, Math.PI*2); X.fill();   // neck
        X.beginPath(); X.ellipse(9, -13, 3.8, 2.5, -Math.PI/6, 0, Math.PI*2); X.fill();  // head
        X.beginPath(); X.ellipse(11, -11.5, 2.2, 1.8, -Math.PI/12, 0, Math.PI*2); X.fill(); // snout
        X.beginPath(); X.ellipse(6, -16.5, 1.2, 2.5, -Math.PI/12, 0, Math.PI*2); X.fill(); // ear1
        X.beginPath(); X.ellipse(8.5, -15.5, 1.2, 2.5, -Math.PI/12, 0, Math.PI*2); X.fill(); // ear2
      }

      // Tail (same in all directions)
      X.strokeStyle='#000'; X.lineWidth=3.0;
      X.beginPath(); X.moveTo(-10, -7); X.quadraticCurveTo(-14, -3, -13, 3); X.stroke();
      X.strokeStyle='#2e1a0c'; X.lineWidth=1.8;
      X.beginPath(); X.moveTo(-10, -7); X.quadraticCurveTo(-14, -3, -13, 3); X.stroke();
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

    // Tools & weapons (animated swinging swings during active tasks)
    if(e.utype==='villager'){
      let swing=isActive&&e.path.length===0?anim*0.8:0;
      if(e.task==='chop'&&e.path.length===0){
        X.save();X.translate(3,-9);X.rotate(swing);
        // Handle
        X.strokeStyle='#000000';X.lineWidth=2.2;
        X.beginPath();X.moveTo(0,0);X.lineTo(7,-10);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.2;
        X.beginPath();X.moveTo(0,0);X.lineTo(7,-10);X.stroke();
        // Simple Axe Head
        X.fillStyle='#b0b0b0';
        X.beginPath();
        X.moveTo(7, -10);
        X.lineTo(11, -12);
        X.lineTo(10, -5);
        X.closePath();
        X.fill();
        X.strokeStyle='#000000';X.lineWidth=1;X.stroke();
        X.restore();
      } else if((e.task==='mine_gold'||e.task==='mine_stone')&&e.path.length===0){
        X.save();X.translate(3,-9);X.rotate(swing);
        // Handle
        X.strokeStyle='#000000';X.lineWidth=2.5;
        X.beginPath();X.moveTo(0,0);X.lineTo(7,-10);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.3;
        X.beginPath();X.moveTo(0,0);X.lineTo(7,-10);X.stroke();
        
        // Pickaxe Head
        X.strokeStyle='#000000';X.lineWidth=3;
        X.beginPath();
        X.moveTo(2, -13);
        X.quadraticCurveTo(7, -12, 12, -7);
        X.stroke();
        
        X.strokeStyle='#b0b0b0';X.lineWidth=1.5;
        X.beginPath();
        X.moveTo(2, -13);
        X.quadraticCurveTo(7, -12, 12, -7);
        X.stroke();
        X.restore();
      } else if((e.task==='forage'||e.task==='farm')&&e.path.length===0){
        let bnd=Math.abs(anim)*2;
        // Straw Basket
        X.fillStyle='#ebd2b0';
        X.beginPath();
        X.moveTo(1, -2-bnd); X.lineTo(6, -2-bnd);
        X.lineTo(5, -6-bnd); X.lineTo(2, -6-bnd);
        X.closePath();
        X.fill(); X.stroke();
        // Visual food inside basket
        if(e.task==='forage'){
          X.fillStyle='#cc3344'; // red berries
          X.beginPath();
          X.arc(2.5, -6.5-bnd, 1.2, 0, Math.PI*2);
          X.arc(4.5, -6.5-bnd, 1.2, 0, Math.PI*2);
          X.fill(); X.stroke();
        } else {
          X.fillStyle='#da0'; // golden grain
          X.beginPath();
          X.arc(3.5, -6.8-bnd, 1.3, 0, Math.PI*2);
          X.fill(); X.stroke();
        }
      } else if(e.task==='build'&&e.path.length===0){
        X.save();X.translate(3,-9);X.rotate(swing);
        // Handle
        X.strokeStyle='#000000';X.lineWidth=2.2;
        X.beginPath();X.moveTo(0,0);X.lineTo(6,-9);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.2;
        X.beginPath();X.moveTo(0,0);X.lineTo(6,-9);X.stroke();
        // Hammer head
        X.fillStyle='#888';
        X.beginPath();X.rect(2.5,-12,5,4);X.fill();
        X.strokeStyle='#000000';X.lineWidth=1;X.stroke();
        X.restore();
      }
      if(e.carrying>0){
        let cc=e.carryType==='food'?'#d44':e.carryType==='wood'?'#8B4513':e.carryType==='gold'?'#ffd700':'#888';
        X.fillStyle=cc;X.beginPath();X.rect(-7,-10,3,6);X.fill();X.stroke();
      }
    } else if(e.utype==='militia'){
      // Militia Sword (swings during combat targets)
      let swinging=e.target&&e.path.length===0;
      X.save();X.translate(4,-7);
      if(swinging) X.rotate(anim*1.0);
      else X.rotate(-0.3);
      X.strokeStyle='#000000';X.lineWidth=1;
      X.fillStyle='#6a4a20';X.beginPath();X.rect(-1,0,3,5);X.fill();X.stroke();
      X.fillStyle='#aa8';X.beginPath();X.rect(-3,-1,7,2);X.fill();X.stroke();
      X.fillStyle='#ccd';
      X.beginPath();X.moveTo(-1,-1);X.lineTo(0,-14);X.lineTo(2,-1);X.closePath();X.fill();X.stroke();
      X.fillStyle='#eef';X.beginPath();X.rect(0,-12,1,8);X.fill();
      X.restore();

      // Shield (steel kite shield with team-colored cross)
      let shx = -6, shy = -6;
      X.fillStyle='#a0a0a0';X.beginPath();
      X.moveTo(shx-3, shy-4);X.lineTo(shx+3, shy-4);
      X.lineTo(shx+4, shy);X.lineTo(shx, shy+6);X.lineTo(shx-4, shy);X.closePath();X.fill();X.stroke();
      X.fillStyle=tc;X.beginPath();
      X.fillRect(shx-3, shy, 6, 1);
      X.fillRect(shx, shy-3, 1, 6);
      X.strokeStyle='#000000';X.lineWidth=0.75;X.stroke();
    } else if(e.utype==='spearman'){
      // Spearman long spear
      let swinging=e.target&&e.path.length===0;
      X.save(); X.translate(3, -6+humanYOffset);
      if(swinging) X.translate(anim*4, 0); // thrusting
      X.strokeStyle='#8B4513'; X.lineWidth=1.8;
      X.beginPath(); X.moveTo(-6, 8); X.lineTo(11, -9); X.stroke();
      X.fillStyle='#ccd'; X.strokeStyle='#000'; X.lineWidth=0.8;
      X.beginPath();
      X.moveTo(11, -9); X.lineTo(15, -13); X.lineTo(12, -6); X.closePath();
      X.fill(); X.stroke();
      X.restore();
    } else if(e.utype==='archer'){
      // Archer bow and arrow
      let swinging=e.target&&e.path.length===0;
      X.save(); X.translate(4, -8+humanYOffset);
      if(swinging) {
        X.strokeStyle='#8B4513'; X.lineWidth=1.5;
        X.beginPath(); X.arc(0, 0, 6, -Math.PI/2, Math.PI/2); X.stroke();
        X.strokeStyle='#e0e0e0'; X.lineWidth=0.75;
        X.beginPath(); X.moveTo(0, -6); X.lineTo(-3, 0); X.lineTo(0, 6); X.stroke();
        // small arrow ready to fire
        X.strokeStyle='#fff'; X.lineWidth=1;
        X.beginPath(); X.moveTo(-3, 0); X.lineTo(5, 0); X.stroke();
      } else {
        X.strokeStyle='#8B4513'; X.lineWidth=1.5;
        X.beginPath(); X.arc(0, 0, 6, -Math.PI/2.5, Math.PI/2.5); X.stroke();
        X.strokeStyle='#e0e0e0'; X.lineWidth=0.75;
        X.beginPath(); X.moveTo(2, -4); X.lineTo(2, 4); X.stroke();
      }
      X.restore();
    } else if(e.utype==='scout'){
      // Scout Sword (straight broadsword like the militia soldier)
      let swinging=e.target&&e.path.length===0;
      X.save(); X.translate(3+humanXOffset, -7+humanYOffset);
      if(swinging) X.rotate(anim*1.0);
      else X.rotate(-0.3);
      X.strokeStyle='#000000'; X.lineWidth=1;
      X.fillStyle='#6a4a20'; X.beginPath(); X.rect(-1, 0, 3, 5); X.fill(); X.stroke();
      X.fillStyle='#aa8'; X.beginPath(); X.rect(-3, -1, 7, 2); X.fill(); X.stroke();
      X.fillStyle='#ccd';
      X.beginPath(); X.moveTo(-1, -1); X.lineTo(0, -14); X.lineTo(2, -1); X.closePath(); X.fill(); X.stroke();
      X.fillStyle='#eef'; X.beginPath(); X.rect(0, -12, 1, 8); X.fill();
      X.restore();
    }
  } else {
    // Sheep — 4-direction: body always the same, head tracks movement direction
    // facing=-1 flips X via scale, so local coords always draw "head to the right"
    // facingNorth=true  → N or W direction (head goes up-right in local = away from camera)
    // facingNorth=false → E or S direction (head goes right in local = toward/beside camera)

    // 4-leg walk cycle: two pairs alternating
    let hw1 = e.path.length > 0 ? Math.sin(tick * 0.45 + e.id) * 2.5 : 0;
    let hw2 = -hw1;
    X.strokeStyle='#000000'; X.lineWidth=1.8;
    X.beginPath();
    X.moveTo(-4, 0); X.lineTo(-4 + hw1, 5);   // back-left
    X.moveTo(-1, 1); X.lineTo(-1 + hw2, 5);    // back-right
    X.moveTo(2, 1);  X.lineTo(2  + hw1, 5);    // front-left
    X.moveTo(5, 0);  X.lineTo(5  + hw2, 5);    // front-right
    X.stroke();

    // Fluffy wool body (same from all angles)
    X.fillStyle='#000000';
    X.beginPath();X.arc(-4,-3,5,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(4,-3,5,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(0,-6,5.5,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(0,-1,5.5,0,Math.PI*2);X.fill();
    X.fillStyle='#f0ead8';
    X.beginPath();X.arc(-4,-3,4,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(4,-3,4,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(0,-6,4.5,0,Math.PI*2);X.fill();
    X.beginPath();X.arc(0,-1,4.5,0,Math.PI*2);X.fill();

    // Head & ear — position depends on direction
    let headX, headY, earX, earY;
    if(e.eatingGrass){
      let chew = Math.sin(tick * 0.6);
      headX = 6; headY = 2 + chew;
      earX = 5;  earY = -0.5 + chew;
    } else if(e.facingNorth){
      // Heading away from camera: head tucked up-right (NE in screen space)
      headX = 3; headY = -8;
      earX = 2;  earY = -10;
    } else {
      // Heading toward camera or sideways: head to the right
      headX = 6; headY = -3;
      earX = 7;  earY = -5;
    }

    X.fillStyle='#333';
    X.beginPath();X.arc(headX,headY,2.5,0,Math.PI*2);X.fill();
    X.strokeStyle='#000000';X.lineWidth=1;X.stroke();
    X.fillStyle='#e0d8c0';
    X.beginPath();X.arc(earX,earY,1.1,0,Math.PI*2);X.fill();X.stroke();

    if(e.eatingGrass){
      X.strokeStyle='#4e8c2d'; X.lineWidth=1.2;
      X.beginPath();X.moveTo(headX,headY+1);X.lineTo(headX+4,headY+3);X.stroke();
    }
  }

  X.restore(); // restore to absolute coordinates so text and UI aren't mirrored

  // HP bar
  if(e.hp<e.maxHp){
    X.fillStyle='#000000';X.fillRect(sx-9,sy-23,18,5);
    X.fillStyle='#300';X.fillRect(sx-8,sy-22,16,3);
    X.fillStyle=e.hp/e.maxHp>0.5?'#0c0':'#c00';X.fillRect(sx-8,sy-22,16*e.hp/e.maxHp,3);
  }
  // Selection circle
  if(selected.includes(e)){
    X.strokeStyle='#fff';X.lineWidth=1.5;
    X.beginPath();X.ellipse(sx,sy+2,8,4,0,0,Math.PI*2);X.stroke();
  }
  // Idle indicator
  if(e.team===0&&e.utype==='villager'&&!isActive){
    X.fillStyle='#ffd700';X.font='bold 9px sans-serif';X.textAlign='center';
    X.fillText('?',sx,sy-20);
  }
}

function drawGhost(){
  if(!placing)return;
  let tile=screenToTile(mouseX,mouseY);

  if (placing === 'WALL' && window.isDraggingWall && window.wallDragStart && window.wallDragEnd) {
    let line = getLineTiles(window.wallDragStart, window.wallDragEnd);
    line.forEach(t => {
      let ok = canPlace('WALL', t.x, t.y, 0);
      let iso = toIso(t.x, t.y);
      let sx = iso.ix - camX + W/2, sy = iso.iy - camY + topH + H/2;
      X.fillStyle = ok ? 'rgba(0,200,0,0.3)' : 'rgba(200,0,0,0.3)';
      X.beginPath();
      X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
      X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
      X.closePath();X.fill();
    });
    return;
  }

  let b=BLDGS[placing];
  let bw=b.w, bh=b.h;
  let ox=tile.x, oy=tile.y;
  if(placing==='GATE'){
    let isWall = (tx, ty) => {
      let w = entities.find(en => en.type === 'building' && en.x === tx && en.y === ty && en.btype === 'WALL' && en.team === 0);
      return !!w;
    };
    if (isWall(tile.x, tile.y) && isWall(tile.x + 1, tile.y)) {
      ox = tile.x; oy = tile.y; bw = 2; bh = 1;
    } else if (isWall(tile.x - 1, tile.y) && isWall(tile.x, tile.y)) {
      ox = tile.x - 1; oy = tile.y; bw = 2; bh = 1;
    } else if (isWall(tile.x, tile.y) && isWall(tile.x, tile.y + 1)) {
      ox = tile.x; oy = tile.y; bw = 1; bh = 2;
    } else if (isWall(tile.x, tile.y - 1) && isWall(tile.x, tile.y)) {
      ox = tile.x; oy = tile.y - 1; bw = 1; bh = 2;
    } else {
      bw = 1; bh = 2;
    }
  }
  let ok=canPlace(placing,tile.x,tile.y,0);
  for(let dy=0;dy<bh;dy++)for(let dx=0;dx<bw;dx++){
    let iso=toIso(ox+dx,oy+dy);
    let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2;
    X.fillStyle=ok?'rgba(0,200,0,0.3)':'rgba(200,0,0,0.3)';
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
  let dpr = window.devicePixelRatio || 1;
  let mw=MC.clientWidth||160,mh=MC.clientHeight||160;
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
  MX.fillStyle='#071006';
  MX.fillRect(0,0,mw,mh);
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
    let f = fog[ey] && fog[ey][ex];
    if (f === 0 || f === undefined) return; // unexplored
    if (f === 1 && e.team !== 0 && e.type !== 'building') return; // hide active enemy units in fog
    
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
    let iso = toIso(p.x, p.y);
    let sx = iso.ix - camX + W/2;
    let sy = iso.iy - camY + topH + H/2 + HALF_TH;
    if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) return;
    X.fillStyle = p.color;
    X.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
    X.beginPath();
    X.arc(sx, sy, p.size, 0, Math.PI * 2);
    X.fill();
  });
  X.restore();
}

function drawProjectiles() {
  X.save();
  projectiles.forEach(p => {
    let target = entities.find(en => en.id === p.targetId);
    if (!target) return;
    let targetX = target.type === 'building' ? target.x + BLDGS[target.btype].w/2 : target.x;
    let targetY = target.type === 'building' ? target.y + BLDGS[target.btype].h/2 : target.y;
    let dCurrent = Math.sqrt((p.x - targetX)**2 + (p.y - targetY)**2);
    let progress = p.totalDist > 0.1 ? Math.max(0, Math.min(1, 1 - dCurrent / p.totalDist)) : 1;
    
    let iso = toIso(p.x, p.y);
    let sx = iso.ix - camX + W/2;
    let sy = iso.iy - camY + topH + H/2 + HALF_TH;
    
    // Height arc
    let arcH = Math.sin(progress * Math.PI) * 35 * (p.totalDist / 5);
    sy -= arcH;
    
    let dx = targetX - p.x;
    let dy = targetY - p.y;
    let angle = Math.atan2(dy, dx);
    let isoAngle = angle - Math.PI/4;
    
    X.strokeStyle = '#000';
    X.lineWidth = 2.2;
    X.beginPath();
    X.moveTo(sx, sy);
    X.lineTo(sx - Math.cos(isoAngle)*8, sy - Math.sin(isoAngle)*4);
    X.stroke();
    
    X.strokeStyle = '#fff';
    X.lineWidth = 1;
    X.beginPath();
    X.moveTo(sx, sy);
    X.lineTo(sx - Math.cos(isoAngle)*7, sy - Math.sin(isoAngle)*3.5);
    X.stroke();
  });
  X.restore();
}

function render(){
  X.fillStyle='#1a3a0a';X.fillRect(0,0,W,window.innerHeight);
  
  X.save();
  // Center zoom scale around viewport camera center
  X.translate(W/2, H/2 + topH);
  X.scale(ZOOM, ZOOM);
  X.translate(-W/2, -(H/2 + topH));

  // Draw ground tiles
  for(let y=0;y<MAP;y++)for(let x=0;x<MAP;x++)drawTile(x,y);

  // Filter out expired corpses using wall-clock time so they still fade after game over
  corpses = corpses.filter(c => performance.now() - c.deathTime < 5000);
  
  // Find all trees with wood resource remaining to depth-sort them dynamically
  let trees = [];
  for(let y=0;y<MAP;y++)for(let x=0;x<MAP;x++){
    if(map[y][x].t===TERRAIN.FOREST && map[y][x].res>0){
      trees.push({type:'tree', x:x, y:y});
    }
  }

  let allDrawable = [];
  entities.forEach(en => {
    if (en.type === 'building' && en.btype === 'GATE') {
      let wallLineNS = en.h > en.w;
      allDrawable.push({
        type: 'gate_back',
        entity: en,
        x: en.x,
        y: en.y
      });
      allDrawable.push({
        type: 'gate_front',
        entity: en,
        x: wallLineNS ? en.x : en.x + 1,
        y: wallLineNS ? en.y + 1 : en.y
      });
    } else {
      allDrawable.push(en);
    }
  });
  allDrawable.push(...corpses, ...trees);
  
  let sorted=allDrawable.sort((a,b)=>{
    let ax = a.type==='building' ? a.x + (a.w||BLDGS[a.btype]?.w||1)/2 : (a.type==='gate_back' ? a.x + 0.05 : (a.type==='gate_front' ? a.x + 0.5 : (a.type==='tree' ? a.x + 0.1 : (a.type==='unit' ? a.x + 0.25 : a.x))));
    let ay = a.type==='building' ? a.y + (a.h||BLDGS[a.btype]?.h||1)/2 : (a.type==='gate_back' ? a.y + 0.05 : (a.type==='gate_front' ? a.y + 0.5 : (a.type==='tree' ? a.y + 0.1 : (a.type==='unit' ? a.y + 0.25 : a.y))));
    let bx = b.type==='building' ? b.x + (b.w||BLDGS[b.btype]?.w||1)/2 : (b.type==='gate_back' ? b.x + 0.05 : (b.type==='gate_front' ? b.x + 0.5 : (b.type==='tree' ? b.x + 0.1 : (b.type==='unit' ? b.x + 0.25 : b.x))));
    let by = b.type==='building' ? b.y + (b.h||BLDGS[b.btype]?.h||1)/2 : (b.type==='gate_back' ? b.y + 0.05 : (b.type==='gate_front' ? b.y + 0.5 : (b.type==='tree' ? b.y + 0.1 : (b.type==='unit' ? b.y + 0.25 : b.y))));
    return (ay+ax) - (by+bx);
  });
  sorted.forEach(e=>{
    // Fog of War checks for entities
    let ex = Math.round(e.x), ey = Math.round(e.y);
    let f = (fog[ey] && fog[ey][ex] !== undefined) ? fog[ey][ex] : 0;
    if (f === 0) return; // unexplored
    if (f === 1 && e.team !== 0) {
      // unexplored but out of sight: hide enemy units/corpses
      if (e.type === 'unit' || e.type === 'corpse') return;
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
      X.strokeStyle = '#00ffff';
      X.lineWidth = 1.5;
      X.setLineDash([4, 4]);
      X.beginPath();
      X.moveTo(sx1, sy1);
      X.lineTo(sx2, sy2);
      X.stroke();
      X.setLineDash([]);
      
      // Draw small cyan rally flag
      X.fillStyle = '#00ffff';
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

  // Update custom cursors via body classes (desktop only)
  if(!isMobile&&!placing){
    let tile=screenToTile(mouseX,mouseY);
    let haveVils=selected.some(s=>s.type==='unit'&&s.utype==='villager'&&s.team===0);
    let haveUnits=selected.some(s=>s.type==='unit'&&s.team===0);
    let t=tile.y>=0&&tile.y<MAP&&tile.x>=0&&tile.x<MAP?map[tile.y][tile.x]:null;
    let overEnemy=entities.some(en=>en.team===1&&en.type==='unit'&&(Math.abs(Math.round(en.x)-tile.x)<2&&Math.abs(Math.round(en.y)-tile.y)<2))
      || (typeof getBuildingUnderCursor === 'function' && !!getBuildingUnderCursor(mouseX, mouseY, en=>en.team===1));
    let alliedB = (typeof getBuildingUnderCursor === 'function') ? getBuildingUnderCursor(mouseX, mouseY, en=>en.team===0) : null;
    let canWorkB = alliedB && (!alliedB.complete || alliedB.hp < alliedB.maxHp);
    
    if(haveUnits&&overEnemy) C.className = 'cursor-crosshair';
    else if(haveVils&&(canWorkB || (t&&(t.t===TERRAIN.FOREST||t.t===TERRAIN.GOLD||t.t===TERRAIN.STONE||t.t===TERRAIN.BERRIES)))) C.className = 'cursor-cell';
    else if(haveUnits) C.className = 'cursor-pointer';
    else C.className = 'cursor-default';
  } else if(placing){ C.className = 'cursor-copy'; }
  drawMinimap();
}
