// Shared wood palette — one brown per ROLE, used by every building so
// timber reads as the same material everywhere:
//   L/R/top:      structural timber (palisade walls/gates, dark-age tower)
//   plankL/R:     plank walls (barracks, mill huts, dark-age TC keep)
//   beam:         half-timber framing beams
//   post:         poles and posts (camps, TC courtyard, fences)
const WOOD = {
  L: '#bd8850', R: '#a06f3d', top: '#b07c46',
  plankL: '#b89868', plankR: '#987848',
  beam: '#6e5138', post: '#8a6a4a'
};

// Draws a 3D isometric building block with Left/Right walls and Flat or Peaked roof.
// topLight: soften the FRONT rim edges (where the top face meets the walls)
// to the light course-line stroke — used on blocks that carry merlons so
// the battlement reads as continuous masonry instead of stacked boxes.
// Back (silhouette) edges and wall sides/bottoms stay hard black.
function drawBuildingBlock(sx,sy,bw,bhh,bh,wallL,wallR,roofType,roofH,roofL,roofR,darken=false,topLight=false){
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

  // 1+2. Wall Faces (skewed 2:1)
  X.fillStyle=wallL;X.beginPath();
  X.moveTo(sx-bw,sy+bhh-bh);X.lineTo(sx,sy+bhh*2-bh);
  X.lineTo(sx,sy+bhh*2);X.lineTo(sx-bw,sy+bhh);X.closePath();X.fill();
  if(!topLight)X.stroke();
  X.fillStyle=wallR;X.beginPath();
  X.moveTo(sx,sy+bhh*2-bh);X.lineTo(sx+bw,sy+bhh-bh);
  X.lineTo(sx+bw,sy+bhh);X.lineTo(sx,sy+bhh*2);X.closePath();X.fill();
  if(!topLight)X.stroke();
  if(topLight){
    // hard outline: wall sides, bottoms, center seam — skip the top edges
    X.beginPath();
    X.moveTo(sx-bw,sy+bhh-bh);X.lineTo(sx-bw,sy+bhh);X.lineTo(sx,sy+bhh*2);
    X.lineTo(sx+bw,sy+bhh);X.lineTo(sx+bw,sy+bhh-bh);
    X.moveTo(sx,sy+bhh*2);X.lineTo(sx,sy+bhh*2-bh);
    X.stroke();
  }

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
    if(topLight){
      // back (silhouette) edges hard, front rim edges light
      X.beginPath();
      X.moveTo(sx-bw,sy+bhh-bh);X.lineTo(sx,sy-bh);X.lineTo(sx+bw,sy+bhh-bh);X.stroke();
      X.save();
      X.strokeStyle='rgba(0,0,0,0.13)';X.lineWidth=1;
      X.beginPath();
      X.moveTo(sx-bw,sy+bhh-bh);X.lineTo(sx,sy+bhh*2-bh);X.lineTo(sx+bw,sy+bhh-bh);X.stroke();
      X.restore();
    } else {
      // Stroke outer boundary only
      X.beginPath();
      X.moveTo(sx,sy-bh);X.lineTo(sx+bw,sy+bhh-bh);
      X.lineTo(sx,sy+bhh*2-bh);X.lineTo(sx-bw,sy+bhh-bh);X.closePath();X.stroke();
    }
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
  // (a white "ridge highlight" down peaked roofs' front edge used to be
  // stroked here — at the small scale every peaked roof is drawn at, it
  // read as a stray gray line rather than a specular edge)
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

// Sortable market parts: tile-space anchors (offsets from e.x/e.y) for the
// per-part draw proxies render.js emits for a complete market, back→front.
// Each anchor is the tile under that prop's screen position in the MARKET
// branch of drawBuilding — keep the two in step. 'ground' (the plaza) is
// implicit and sorts under everything on the footprint.
const MARKET_PART_ANCHORS = {
  // Symmetric layout: one stall on each of the three back/side corner
  // tiles, open wares on the front corner tile. No central banner — the
  // striped canopies alone carry the team read.
  stall_b: [0.5, 0.5],
  stall_l: [0.5, 2.5],
  stall_r: [2.5, 0.5],
  wares:   [2.5, 2.5],
};

// Farm crop grid in field-space (0..1 across the full 2x2 field): rows are
// parallel to the top-right edge, sheaf columns along each row. The whole
// field draws FLAT in the ground layer (see the FARM branch + render.js),
// so this is pure layout, not a depth-sorting contract.
const FARM_CROP_ROWS = [0.1, 0.28, 0.46, 0.64, 0.82];
const FARM_CROP_COLS = 6;
function farmSheafU(ri, i){
  // per-row ±0.02 stagger keeps the planting from reading as a rigid grid
  return (i + 1) / (FARM_CROP_COLS + 1) + ((ri % 2) ? 0.02 : -0.02);
}

// Stone-paved plaza the market sits on — same footprint diamond as
// drawCampClearing. Cartoon-flat: big one-tile slabs (3x3), a couple of
// seeded lighter slabs for variety, no running-bond micro-joints and no
// clip pass (both dissolved into noise zoomed out).
function drawMarketPlaza(sx,sy,bw,bhh,seed,darken=false){
  // pt(a,b): bilinear point in the footprint diamond, a along N→E (tile x),
  // b along N→W (tile y); the diamond is an affine cell so this is exact.
  const pt=(a,b)=>({x:sx+(a-b)*bw, y:sy+(a+b)*bhh});
  X.fillStyle = darken ? darkenColor('#b7b2a6') : '#b7b2a6';
  X.strokeStyle = 'rgba(0,0,0,0.25)';
  X.lineWidth = 1;
  X.beginPath();
  X.moveTo(sx,sy);X.lineTo(sx+bw,sy+bhh);X.lineTo(sx,sy+bhh*2);X.lineTo(sx-bw,sy+bhh);X.closePath();
  X.fill();X.stroke();
  const N=3; // one big slab per tile
  // lighter slabs first, so joints stroke over them
  X.fillStyle='rgba(255,255,255,0.06)';
  for(let j=0;j<N;j++)for(let i=0;i<N;i++){
    if((i*3+j*5+seed)%4) continue;
    let p0=pt(i/N,j/N),p1=pt((i+1)/N,j/N),p2=pt((i+1)/N,(j+1)/N),p3=pt(i/N,(j+1)/N);
    X.beginPath();X.moveTo(p0.x,p0.y);X.lineTo(p1.x,p1.y);X.lineTo(p2.x,p2.y);X.lineTo(p3.x,p3.y);X.closePath();X.fill();
  }
  // joints: two bold lines each way along the tile seams
  X.strokeStyle='rgba(0,0,0,0.13)';X.lineWidth=1;
  for(let j=1;j<N;j++){
    let a=pt(0,j/N),b=pt(1,j/N);
    X.beginPath();X.moveTo(a.x,a.y);X.lineTo(b.x,b.y);X.stroke();
    let c=pt(j/N,0),d=pt(j/N,1);
    X.beginPath();X.moveTo(c.x,c.y);X.lineTo(d.x,d.y);X.stroke();
  }
  // (No inset seat-shadow band: the offset line read as a drawing mistake,
  // not shading — the outlined slab plus the prop shadows ground it fine.)
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

// Post-and-rail fence for the barracks yard: round-capped posts plus two
// rails strung along each polyline (drawn in two passes so props can
// stand in front of the back edge but behind the front edges).
function drawBarracksFence(posts, railPaths, darken){
  let postC = darken ? darkenColor(WOOD.post) : WOOD.post;
  posts.forEach(p=>{
    X.strokeStyle='#000';X.lineWidth=3;X.lineCap='round';
    X.beginPath();X.moveTo(p.x,p.y);X.lineTo(p.x,p.y-9);X.stroke();
    X.strokeStyle=postC;X.lineWidth=1.4;
    X.beginPath();X.moveTo(p.x,p.y);X.lineTo(p.x,p.y-9);X.stroke();
    X.lineCap='butt';
  });
  [3.5,7].forEach(h=>{
    railPaths.forEach(path=>{
      X.strokeStyle='#000';X.lineWidth=2.2;
      X.beginPath();path.forEach((p,i)=>i?X.lineTo(p.x,p.y-h):X.moveTo(p.x,p.y-h));X.stroke();
      X.strokeStyle=postC;X.lineWidth=0.9;
      X.beginPath();path.forEach((p,i)=>i?X.lineTo(p.x,p.y-h):X.moveTo(p.x,p.y-h));X.stroke();
    });
  });
}

// Mirror of drawDoorLeft: skewed door flat against the Right Wall
function drawDoorRight(sx,sy,bw,bhh,color,darken=false){
  let c = darken ? darkenColor(color) : color;
  X.fillStyle=c;X.beginPath();
  X.moveTo(sx+bw*0.625,sy+bhh*1.375);X.lineTo(sx+bw*0.375,sy+bhh*1.625);
  X.lineTo(sx+bw*0.375,sy+bhh*1.625-8);X.lineTo(sx+bw*0.625,sy+bhh*1.375-8);X.closePath();
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
function drawWavingFlag(sx,sy,bh,color,colorDark,poleLen=22){
  // Pole base sits at sy-bh-2; poleLen lets tall buildings (TC) plant the
  // base on an actual surface and still fly the flag clear of the roofline.
  let top=sy-bh-2-poleLen;
  X.strokeStyle='#000000';X.lineWidth=1.5;
  X.beginPath();X.moveTo(sx,sy-bh-2);X.lineTo(sx,top);X.stroke(); // pole
  X.fillStyle='#000000';X.beginPath();X.arc(sx,top-1.5,1.6,0,Math.PI*2);X.fill(); // finial
  // Cloth: sampled ribbon flying left off the pole. A wave travels along
  // the fabric (phase advances with distance from the hoist); amplitude is
  // zero at the pole (it's pinned there) and grows toward the free end,
  // plus a slight quadratic sag. Two superposed sines keep the motion from
  // looking metronomic.
  const L=17, H=8.5, N=8;
  let t=tick*0.13;
  let lift=(u)=>Math.sin(t-u*4.2)*3.0*u + Math.sin(t*0.63-u*7.0)*0.9*u + 2.4*u*u;
  let pts=[];
  for(let i=0;i<=N;i++){
    let u=i/N;
    pts.push({x:sx-L*u, y:top+1+lift(u), u});
  }
  X.fillStyle=color;X.lineWidth=1.3;X.lineJoin='round';
  X.beginPath();
  X.moveTo(pts[0].x,pts[0].y);
  for(let p of pts)X.lineTo(p.x,p.y);
  for(let i=N;i>=0;i--)X.lineTo(pts[i].x,pts[i].y+H);
  X.closePath();X.fill();
  // Fold shading: segments where the cloth surface tips away from the
  // upper-left light (top edge descending toward the pole) read darker.
  X.fillStyle=colorDark;
  for(let i=0;i<N;i++){
    if(pts[i+1].y-pts[i].y>0.6){
      X.beginPath();
      X.moveTo(pts[i].x,pts[i].y+0.65);X.lineTo(pts[i+1].x,pts[i+1].y+0.65);
      X.lineTo(pts[i+1].x,pts[i+1].y+H-0.65);X.lineTo(pts[i].x,pts[i].y+H-0.65);
      X.closePath();X.fill();
    }
  }
  // outline over the shading so the silhouette stays crisp
  X.strokeStyle='#000000';
  X.beginPath();
  X.moveTo(pts[0].x,pts[0].y);
  for(let p of pts)X.lineTo(p.x,p.y);
  for(let i=N;i>=0;i--)X.lineTo(pts[i].x,pts[i].y+H);
  X.closePath();X.stroke();
}

// Timber building under a gable roof: the ridge runs back-left to
// front-right, showing one roof slope to the camera and a triangular
// gable end above the front-right wall. Overhangs are pure translations
// along the ridge / down-slope directions so all edges stay iso-parallel.
// Returns key anchor points so callers can place props.
// One open-sided tent-annex roof for the TC courtyard: two identical
// quad faces meeting at an apex line (left face toward ax-48, right toward
// ax+48). The TC draws this twice, at the left and right quadrant.
// Open-sided lean-to shelter over one courtyard quadrant (AoE2 TC look):
// a plank roof plane leaning from the keep wall (high) down to the outer
// posts (low), open underneath — the shade + posts carry the "open
// market stall" read. side: -1 = left quadrant, +1 = right quadrant.
function drawTCAnnexRoof(sx, sy, side, tc, tcD, darken){
  const hK = 28, hO = 18; // roof height at the keep edge / outer eave — tall enough for units to walk under
  let s = side;
  // ground corners of the quadrant diamond
  let K1 = { x: sx + 48*s, y: sy + 24 }; // keep side corner
  let K2 = { x: sx,        y: sy + 48 }; // keep front corner
  let O1 = { x: sx + 96*s, y: sy + 48 }; // outer side corner
  let O2 = { x: sx + 48*s, y: sy + 72 }; // outer front corner
  let up = (p, h) => ({ x: p.x, y: p.y - h });
  let K1r = up(K1,hK), K2r = up(K2,hK), O1r = up(O1,hO), O2r = up(O2,hO);
  // shade on the ground under the open shelter — skipped in the selection-
  // outline mask pass (window._maskDraw): shadow, not shape, and it filled
  // the whole quadrant under the roof with a gold haze when selected.
  if (!window._maskDraw) {
    X.fillStyle = 'rgba(0,0,0,0.10)';
    X.beginPath();
    X.moveTo(K1.x,K1.y); X.lineTo(O1.x,O1.y); X.lineTo(O2.x,O2.y); X.lineTo(K2.x,K2.y);
    X.closePath(); X.fill();
  }
  // roof plane: wooden planks, lit by orientation (left plane faces the
  // light, right plane faces away)
  let plank = s < 0 ? WOOD.plankL : WOOD.plankR;
  let pl = darken ? darkenColor(plank) : plank;
  X.strokeStyle='#000000'; X.lineWidth=1.3; X.lineJoin='round';
  X.fillStyle = pl; X.beginPath();
  X.moveTo(K1r.x,K1r.y); X.lineTo(O1r.x,O1r.y); X.lineTo(O2r.x,O2r.y); X.lineTo(K2r.x,K2r.y);
  X.closePath(); X.fill(); X.stroke();
  // plank seams running down the slope (keep edge → outer eave)
  X.save();
  X.strokeStyle='rgba(0,0,0,0.18)'; X.lineWidth=1;
  for (let t of [0.25, 0.5, 0.75]) {
    let a = { x: K1r.x + (K2r.x-K1r.x)*t, y: K1r.y + (K2r.y-K1r.y)*t };
    let b = { x: O1r.x + (O2r.x-O1r.x)*t, y: O1r.y + (O2r.y-O1r.y)*t };
    X.beginPath(); X.moveTo(a.x,a.y); X.lineTo(b.x,b.y); X.stroke();
  }
  X.restore();
  // team-color fascia boards along the two visible outer eave edges
  let fs = 3.5;
  let cOut = darken ? darkenColor(tc) : tc;   // outer edge (side-facing)
  let cFrt = darken ? darkenColor(tcD) : tcD; // front edge (darker face)
  X.fillStyle = s < 0 ? cOut : cFrt; X.beginPath();
  X.moveTo(O1r.x,O1r.y); X.lineTo(O2r.x,O2r.y); X.lineTo(O2r.x,O2r.y+fs); X.lineTo(O1r.x,O1r.y+fs);
  X.closePath(); X.fill(); X.stroke();
  X.fillStyle = s < 0 ? cFrt : cOut; X.beginPath();
  X.moveTo(O2r.x,O2r.y); X.lineTo(K2r.x,K2r.y); X.lineTo(K2r.x,K2r.y+fs); X.lineTo(O2r.x,O2r.y+fs);
  X.closePath(); X.fill(); X.stroke();
}

function drawGableBlock(sx, sy0, W, hh, wallH, roofH, wallL, wallR, roofC, beamC, darken, afterWalls, noBackEave){
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
  // Caller-specific wall detailing (e.g. the house's half-timber studs),
  // painted between the walls and the roof so the eave overhang still
  // covers the stud tops exactly as before the refactor.
  if(afterWalls) afterWalls();
  // Roof anchor geometry (needed before the back panel below)
  let Rp={x:sx+W,y:sy0+hh-wallH}, Bp={x:sx,y:sy0+hh*2-wallH}, Lp={x:sx-W,y:sy0+hh-wallH};
  let M1={x:sx+W*0.5,y:sy0+hh*1.5-wallH-roofH};
  let M2={x:sx-W*0.5,y:sy0+hh*0.5-wallH-roofH};
  let vR={x:(M2.x-M1.x)*0.10, y:(M2.y-M1.y)*0.10};
  let vF={x:(M1.x-M2.x)*0.13, y:(M1.y-M2.y)*0.13}; // front eave projects past the gable face
  let vS={x:(Lp.x-M2.x)*0.10, y:(Lp.y-M2.y)*0.10};
  let M2e={x:M2.x+vR.x, y:M2.y+vR.y};
  let M1e={x:M1.x+vF.x, y:M1.y+vF.y};
  let EL={x:Lp.x+vR.x+vS.x, y:Lp.y+vR.y+vS.y};
  let EB={x:Bp.x+vF.x+vS.x, y:Bp.y+vF.y+vS.y};
  // Gable-end triangle above the front-right wall, with a center stud
  X.fillStyle=wr;X.strokeStyle='#000';X.lineWidth=1.3;
  X.beginPath();X.moveTo(Bp.x,Bp.y);X.lineTo(Rp.x,Rp.y);X.lineTo(M1.x,M1.y);X.closePath();X.fill();X.stroke();
  X.strokeStyle=beam;X.lineWidth=1.6;
  X.beginPath();X.moveTo((Bp.x+Rp.x)/2,(Bp.y+Rp.y)/2);X.lineTo(M1.x,M1.y);X.stroke();
  // BACK slope's overhanging eave: the strip of the far roof panel that
  // projects past the gable face, running down the gable's right edge
  // from the peak — darker team color (it faces away from the light).
  if(!noBackEave){
    let dn={x:(Rp.x-M1.x)*0.10, y:(Rp.y-M1.y)*0.10}; // down-slope overhang
    X.fillStyle=rl;X.strokeStyle='#000';X.lineWidth=1.3;
    X.beginPath();
    X.moveTo(M1.x, M1.y); X.lineTo(M1e.x, M1e.y);
    X.lineTo(Rp.x+dn.x+vF.x, Rp.y+dn.y+vF.y);
    X.lineTo(Rp.x+dn.x, Rp.y+dn.y);
    X.closePath();X.fill();X.stroke();
    X.fillStyle='rgba(0,0,0,0.3)';
    X.fill();
  }
  // Front roof slope with iso-parallel overhangs
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
  return {M1,M2,Rp,Bp,Lp,M1e,M2e,EL,EB};
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
function drawWindmillSails(hx,hy,id,scale=1,canvasCol='#f0ead8',canvasCol2=null){
  let rot = tick * 0.012 + id*0.5; // slow, ponderous turn — mills are heavy

  // Front-facing rotor: the fan spins in a (slightly flattened)
  // screen-plane circle, sails alternating canvas colors around the hub.
  const ux=1, uy=0, vx=0, vy=0.95;

  for(let i=0; i<4; i++){
    let a = rot + i * Math.PI / 2;

    let dx = Math.cos(a)*ux + Math.sin(a)*vx;
    let dy = Math.cos(a)*uy + Math.sin(a)*vy;
    let px = -Math.sin(a)*ux + Math.cos(a)*vx;
    let py = -Math.sin(a)*uy + Math.cos(a)*vy;

    let L = 27*scale; // spar length
    let tx = hx + dx * L;
    let ty = hy + dy * L;

    // 1. Spar (whole arm): black underlay + wood core
    X.strokeStyle = '#000000';
    X.lineWidth = 3;
    X.beginPath(); X.moveTo(hx, hy); X.lineTo(tx, ty); X.stroke();
    X.strokeStyle = '#8B4513';
    X.lineWidth = 1.5;
    X.beginPath(); X.moveTo(hx, hy); X.lineTo(tx, ty); X.stroke();

    // 2. Canvas sail sheet on the trailing side of the spar, slightly
    // wider at the tip than at the root (real sails flare outward)
    let r0 = 7*scale;               // sheet starts clear of the hub
    let x1 = hx + dx * r0,        y1 = hy + dy * r0;
    let x2 = tx,                  y2 = ty;
    let x3 = tx + px * 8*scale,   y3 = ty + py * 8*scale;
    let x4 = x1 + px * 5*scale,   y4 = y1 + py * 5*scale;
    // Striped canvas: the batten boundaries split each sail into panels
    // that alternate white / team color along its length
    const TS=[0, 0.3, 0.55, 0.8, 1];
    let onSpar=t=>({x:x1+(x2-x1)*t, y:y1+(y2-y1)*t});
    let onEdge=t=>({x:x4+(x3-x4)*t, y:y4+(y3-y4)*t});
    for(let k=0;k<TS.length-1;k++){
      let a1=onSpar(TS[k]), a2=onSpar(TS[k+1]);
      let b1=onEdge(TS[k]), b2=onEdge(TS[k+1]);
      X.fillStyle = (canvasCol2 && k%2) ? canvasCol2 : canvasCol;
      X.beginPath();
      X.moveTo(a1.x,a1.y);X.lineTo(a2.x,a2.y);X.lineTo(b2.x,b2.y);X.lineTo(b1.x,b1.y);
      X.closePath();X.fill();
    }
    X.strokeStyle = '#000000';
    X.lineWidth = 1.3;
    X.beginPath();
    X.moveTo(x1, y1); X.lineTo(x2, y2); X.lineTo(x3, y3); X.lineTo(x4, y4);
    X.closePath(); X.stroke();

    // 3. Sail battens: crossbars at the panel boundaries
    X.save();
    X.strokeStyle='rgba(0,0,0,0.28)';X.lineWidth=0.9;
    for(let t of [0.3, 0.55, 0.8]){
      let a=onSpar(t), b=onEdge(t);
      X.beginPath();X.moveTo(a.x,a.y);X.lineTo(b.x,b.y);X.stroke();
    }
    // leading-edge board along the spar side of the canvas
    X.strokeStyle='rgba(0,0,0,0.2)';
    X.beginPath();X.moveTo(x1,y1);X.lineTo(x2,y2);X.stroke();
    X.restore();
  }

  // Hub: wooden boss with a shadowed rim and a bright center pin
  X.fillStyle='#6d5138';
  X.beginPath();X.arc(hx,hy,3.8*scale,0,Math.PI*2);X.fill();
  X.strokeStyle='#000000';X.lineWidth=1.1;X.stroke();
  X.fillStyle='#a08050';
  X.beginPath();X.arc(hx-0.5,hy-0.5,1.6*scale,0,Math.PI*2);X.fill();
}
// Main function to draw building entities
// Shared by TOWER/WALL/GATE for locating an adjacent building to link to.
function getConnectedBuilding(tx, ty){
  // O(1) via the tile occupancy grid — every building footprint tile holds
  // the owner's id (see placement in js/logic.js). The old full entities
  // scan ran 1-4× per WALL/TOWER/GATE per frame: ~10-60k entity checks a
  // frame for a decent wall ring.
  if(ty<0||ty>=MAP||tx<0||tx>=MAP)return undefined;
  let id=map[ty][tx].occupied;
  if(!id)return undefined;
  let en=entitiesById.get(id);
  return en&&en.type==='building'?en:undefined;
}
// 'wood' (palisade), 'stone', or null (TOWER/PTOWER — connect to both).
function wallMat(bt){
  if (bt === 'WALL' || bt === 'GATE') return 'wood';
  if (bt === 'SWALL' || bt === 'SGATE') return 'stone';
  return null;
}
// mat: restrict to one material family (towers always connect). Omitted =>
// any wall-like neighbor.
function isWallLike(b, mat){
  if (!b) return false;
  if (isTowerBtype(b.btype)) return true;
  let m = wallMat(b.btype);
  if (!m) return false;
  return !mat || m === mat;
}
// One merlon block: two wall faces + a two-tone cap. Hard-outlined on
// sides and tops, but the BOTTOM seam gets the light course-line stroke
// (matching the material pass) so the merlon reads as continuous with the
// masonry it stands on rather than a loose block. Shared by the TC's big
// merlons and every bastion cap (tower, gate posts, barracks).
function drawMerlonBlock(mx, my, bw, bhh, bh, wl, wr, cl, cr, darken){
  if (darken) { wl=darkenColor(wl); wr=darkenColor(wr); cl=darkenColor(cl); cr=darkenColor(cr); }
  X.strokeStyle = '#000000'; X.lineWidth = 1.3; X.lineJoin = 'round';
  let bL=[mx-bw,my+bhh], bB=[mx,my+bhh*2], bR=[mx+bw,my+bhh];           // base corners
  let tL=[mx-bw,my+bhh-bh], tB=[mx,my+bhh*2-bh], tR=[mx+bw,my+bhh-bh];  // wall tops
  let tT=[mx,my-bh];                                                    // cap back vertex
  X.fillStyle = wl; X.beginPath();
  X.moveTo(...tL); X.lineTo(...tB); X.lineTo(...bB); X.lineTo(...bL); X.closePath(); X.fill();
  X.fillStyle = wr; X.beginPath();
  X.moveTo(...tB); X.lineTo(...tR); X.lineTo(...bR); X.lineTo(...bB); X.closePath(); X.fill();
  // cap: two-tone fills, but outline the diamond PERIMETER only — a
  // stroked center seam read as an extra line across the top
  X.fillStyle = cl; X.beginPath();
  X.moveTo(...tT); X.lineTo(...tB); X.lineTo(...tL); X.closePath(); X.fill();
  X.fillStyle = cr; X.beginPath();
  X.moveTo(...tT); X.lineTo(...tR); X.lineTo(...tB); X.closePath(); X.fill();
  X.beginPath();
  X.moveTo(...tT); X.lineTo(...tR); X.lineTo(...tB); X.lineTo(...tL); X.closePath(); X.stroke();
  // hard outline: sides, wall-top edges, center seam — no bottom
  X.beginPath();
  X.moveTo(...bL); X.lineTo(...tL); X.lineTo(...tB); X.lineTo(...tR); X.lineTo(...bR);
  X.moveTo(...tB); X.lineTo(...bB);
  X.stroke();
  // light bottom seam
  X.save();
  X.strokeStyle = 'rgba(0,0,0,0.13)'; X.lineWidth = 1;
  X.beginPath(); X.moveTo(...bL); X.lineTo(...bB); X.lineTo(...bR); X.stroke();
  X.restore();
}

// GATE's 4-merlon battlement cap, shared between its back and front posts.
function drawBastionMerlons(cx, cy, colorL, colorR, darken){
  let m = [
    { x: cx,      y: cy - 35 }, // Top
    { x: cx - 10, y: cy - 30 }, // Left
    { x: cx + 10, y: cy - 30 }, // Right
    { x: cx,      y: cy - 25 }  // Bottom
  ];
  m.forEach(p => drawMerlonBlock(p.x, p.y, 4, 2, 5, '#c8c0ae', '#a89f8d', colorL, colorR, darken));
}

// Per-age look tables (owner's teamAge). Restraint by design: only the
// NON-team wood/plaster fills shift — team-color roofs/trim stay untouched
// so team identity always wins. One accessory change max per building
// (TC merlons+flag are Castle-only; see below).
const AGE_WALLS = [
  { gl: '#e0c294', gr: '#c2a06e' },  // dark: rough wattle/daub
  { gl: '#ebd2b0', gr: '#d2b48c' },  // feudal: today's plastered look
  { gl: '#e8dcc8', gr: '#cfc0a4' }   // castle: whitewashed/limewashed
];
// Adds one building's ground-shadow diamond to the CURRENT canvas path
// (no fill here). All shadows are accumulated and filled ONCE per frame in
// render.js before any building paints — a union fill means overlapping
// shadows of adjacent wall segments don't double-darken, and no shadow can
// land on top of an already-drawn neighbor. Footprint grown slightly and
// nudged toward the lower-right (away from the upper-left light); FARM is
// a flat field — nothing to cast.
function buildingShadowPath(e){
  if (e.btype === 'FARM') return;
  // The market is open paving — a full 3x3 shadow diamond would read as a
  // solid mass. Its stalls cast their own small ellipses (ground part).
  if (e.btype === 'MARKET') return;
  let b = BLDGS[e.btype];
  // per-instance footprint: gates are 1x2 OR 2x1 depending on placement
  let fw = e.w !== undefined ? e.w : b.w;
  let fh = e.h !== undefined ? e.h : b.h;
  let g = 1.06, ox = 3, oy = 1.5;
  if (fw === fh) {
    // square footprint: one diamond over the whole base
    let iso = toIso(e.x + fw/2, e.y + fh/2);
    let sx = Math.round(iso.ix - camX + W/2), sy = Math.round(iso.iy - camY + topH + H/2);
    if (isOffscreen(sx, sy, 100)) return;
    let bw = fw * HALF_TW, bhh = fh * HALF_TH;
    X.moveTo(sx + ox, sy - bhh * g + oy);
    X.lineTo(sx + bw * g + ox, sy + oy);
    X.lineTo(sx + ox, sy + bhh * g + oy);
    X.lineTo(sx - bw * g + ox, sy + oy);
    X.closePath();
  } else {
    // non-square (gates, 1x2 / 2x1): a stretched diamond doesn't match
    // the parallelogram footprint — shadow each tile individually; the
    // union fill merges the overlap seamlessly.
    for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) {
      let iso = toIso(e.x + dx + 0.5, e.y + dy + 0.5);
      let sx = Math.round(iso.ix - camX + W/2), sy = Math.round(iso.iy - camY + topH + H/2);
      if (isOffscreen(sx, sy, 100)) continue;
      X.moveTo(sx + ox, sy - HALF_TH * g + oy);
      X.lineTo(sx + HALF_TW * g + ox, sy + oy);
      X.lineTo(sx + ox, sy + HALF_TH * g + oy);
      X.lineTo(sx - HALF_TW * g + ox, sy + oy);
      X.closePath();
    }
  }
}

function drawBuilding(e, part = null){
  let b=BLDGS[e.btype];
  let ownerAge = (teamAge && isPlayerTeam(e.team)) ? teamAge[e.team] : 0;
  let aw = AGE_WALLS[ownerAge] || AGE_WALLS[1];
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
  let tc=teamColor(e.team);
  let tcD=teamColorDark(e.team);
  let bh=10;

  let strokeColor = '#000000';
  X.strokeStyle = strokeColor;
  X.lineWidth = 1.3;
  X.lineJoin = 'round';

  if(e.btype==='TC'){
    // The keep art below is authored for the original 3x3 footprint: sx is
    // the footprint's top screen corner and every offset is measured from
    // there (48px = 3*HALF_TH is that corner's height above the footprint
    // centre). For a larger footprint (now 4x4) scale the entire drawing up
    // about the footprint centre so it fills the bigger diamond
    // proportionally, then run the authored art unchanged against its 3x3
    // reference corner. Keeps one source of truth for the keep geometry.
    let tcS = b.w / 3;
    let tcCx = sx, tcCy = sy + bhh; // footprint centre in screen space
    sy = tcCy - 48;                 // authored 3x3 top corner
    X.save();
    X.translate(tcCx, tcCy); X.scale(tcS, tcS); X.translate(-tcCx, -tcCy);
    bh = 60 * tcS; // scaled keep height, for overlays drawn after restore()

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

    // 1. Tall Main Keep Tower — stone from Feudal on; the DARK-age keep is
    // a timber hall (plank walls + half-timber framing below), so a fresh
    // town doesn't read as a finished castle.
    let keepWood = ownerAge === 0;
    let kL = keepWood ? WOOD.plankL : '#ded5c2';
    let kR = keepWood ? WOOD.plankR : '#bcb29b';
    // Up-facing rim is the brightest face — same light rule as the merlon
    // caps (light from upper-left: top > left wall > right wall).
    let kT = keepWood ? '#c8a878' : '#ece4d2';
    drawBuildingBlock(sx, sy, 48, 24, 60, kL, kR, 'flat', 0, kT, kT, darken, ownerAge >= 2);
    if (keepWood) {
      // Half-timber framing on both visible faces: corner-to-corner studs
      // and a mid-rail, same beam brown as the house's framing.
      let beam = darken ? darkenColor('#6e5138') : '#6e5138';
      X.strokeStyle = beam; X.lineWidth = 1.6;
      [0.22, 0.78].forEach(t => { // symmetric — flanking the face-centered windows
        // left face runs from (sx-48,sy+24) toward (sx,sy+48)
        X.beginPath(); X.moveTo(sx - 48 + 48 * t, sy + 24 + 24 * t - 60); X.lineTo(sx - 48 + 48 * t, sy + 24 + 24 * t); X.stroke();
        // right face runs from (sx,sy+48) toward (sx+48,sy+24)
        X.beginPath(); X.moveTo(sx + 48 * t, sy + 48 - 24 * t - 60); X.lineTo(sx + 48 * t, sy + 48 - 24 * t); X.stroke();
      });
      // (no mid-rail — the material pass's light course line already
      // marks mid-height; a dark beam there doubled the line)
      X.strokeStyle = '#000000'; X.lineWidth = 1.3;
    }
    // Recessed rooftop behind a raised parapet rim — properly 3D: the rim
    // keeps the cap color, the floor sits a few px LOWER, and the two far
    // inner walls are drawn so the recess reads as real depth instead of a
    // painted-on diamond. At Castle the merlons perch on the rim: the
    // opening is inset to 32/48 so its lip meets the merlons' inner
    // faces (merlon centers at ±40, half-width 8 → inner edge ±32).
    {
      let rcx = sx, rcy = sy - 36; // center of the top diamond
      let inset = 38 / 48, depth = 5; // side merlon centers ±43, half-width 5 → inner corner ±38
      let ins = ([cx2, cy2]) => [rcx + (cx2 - rcx) * inset, rcy + (cy2 - rcy) * inset];
      let N = ins([sx, sy - 60]), E = ins([sx + 48, sy - 36]), S = ins([sx, sy - 12]), W = ins([sx - 48, sy - 36]);
      let dn = ([x2, y2]) => [x2, y2 + depth];
      // Light model: with one distant light (upper-left), a face's color
      // depends ONLY on its orientation — the N→E inner face looks SW so
      // it's kL, the W→N face looks SE so it's kR, the floor faces up so
      // it's kT. Depth inside the pit comes from the CAST shadow below,
      // not from repainting the material darker.
      let wallSE = darken ? darkenColor(kR) : kR;
      let wallSW = darken ? darkenColor(kL) : kL;
      let floorC = darken ? darkenColor(kT) : kT;
      // The recess is drawn FLAT (every floor corner dropped by the same
      // depth) and clipped to the rim opening — the front rim then occludes
      // the floor's near edge naturally. (Dropping only the back corner
      // read as a sloped floor; letting the shifted diamond overhang the
      // front rim flattened the illusion.)
      let openingPath = () => {
        X.beginPath();
        X.moveTo(...N); X.lineTo(...E); X.lineTo(...S); X.lineTo(...W); X.closePath();
      };
      X.save();
      openingPath(); X.clip();
      // interior seams in the light course-line stroke — hard black inside
      // the pit fought with the light-seam masonry look everywhere else
      X.strokeStyle = 'rgba(0,0,0,0.13)'; X.lineWidth = 1;
      X.fillStyle = wallSE; X.beginPath();
      X.moveTo(...W); X.lineTo(...N); X.lineTo(...dn(N)); X.lineTo(...dn(W)); X.closePath(); X.fill(); X.stroke();
      X.fillStyle = wallSW; X.beginPath();
      X.moveTo(...N); X.lineTo(...E); X.lineTo(...dn(E)); X.lineTo(...dn(N)); X.closePath(); X.fill(); X.stroke();
      X.fillStyle = floorC; X.beginPath();
      X.moveTo(...dn(N)); X.lineTo(...dn(E)); X.lineTo(...dn(S)); X.lineTo(...dn(W)); X.closePath(); X.fill(); X.stroke();
      // Cast shadow: light from upper-left, so the west rim throws a soft
      // band across the floor along the W→N wall base (no outline — it's
      // shadow, not geometry).
      let sh = 7; // how far the shadow reaches across the floor
      let off = ([x2, y2]) => [x2 + sh, y2 + sh * 0.5];
      X.fillStyle = 'rgba(0,0,0,0.13)'; X.beginPath();
      X.moveTo(...dn(W)); X.lineTo(...dn(N)); X.lineTo(...off(dn(N))); X.lineTo(...off(dn(W))); X.closePath(); X.fill();
      X.restore();
      // Rim's inner lip outline on top of the clipped fill — light, like
      // the rest of the masonry seams (the depth cues carry the recess)
      X.save();
      X.strokeStyle = 'rgba(0,0,0,0.13)'; X.lineWidth = 1;
      openingPath(); X.stroke();
      X.restore();
    }
    // 3D Castle battlements (crenellations) on flat top edges
    // Merlon centers sit half a merlon-width (3,1.5 iso) inside the rim
    // edge so each OUTER face lies exactly on the rim edge plane; corner
    // merlons take both edges' insets so their outer corner touches the
    // rim corner. Edge merlons at the 1/3 and 2/3 points of each edge.
    // Four merlons per edge (corners shared), 10px wide (s=5). A diamond's
    // edges have the same 2:1 slope as the rim edges, so FLUSH means the
    // center sits at perpendicular distance s/√5 inside the edge line —
    // an inward offset of (2s/5, s/5) = (2,1), NOT (s, s/2). Corner
    // merlons offset (0, ±bhh) / (±s, 0) so the shared corner touches the
    // rim corner with both faces flush. Middles at the edge thirds.
    let merlons = [
      { x: sx,      y: sy - 57.5 }, // Top corner (rim corner sy-60)
      { x: sx - 14, y: sy - 51 },   // Back-left edge, 1/3
      { x: sx + 14, y: sy - 51 },   // Back-right edge, 1/3
      { x: sx - 30, y: sy - 43 },   // Back-left edge, 2/3
      { x: sx + 30, y: sy - 43 },   // Back-right edge, 2/3
      { x: sx - 43, y: sy - 36 },   // Left corner (rim corner ±48)
      { x: sx + 43, y: sy - 36 },   // Right corner
      { x: sx - 30, y: sy - 29 },   // Front-left edge, 2/3
      { x: sx + 30, y: sy - 29 },   // Front-right edge, 2/3
      { x: sx - 14, y: sy - 21 },   // Front-left edge, 1/3
      { x: sx + 14, y: sy - 21 },   // Front-right edge, 1/3
      { x: sx,      y: sy - 14.5 }  // Bottom corner (rim corner sy-12)
    ];

    // Merlons are the same masonry as the keep, lit the same way — the
    // keep's face palette (bright cap kT, walls kL/kR) via the shared
    // merlon block (light bottom seam so they connect to the rim).
    let drawMerlon = (mx, my) => drawMerlonBlock(mx, my - 2.5, 5, 2.5, 7, kL, kR, kT, kT, darken);

    // Crenellations are the TC's Castle-age accessory — earlier ages read
    // as a plain keep.
    if (ownerAge >= 2) merlons.forEach(m => {
      drawMerlon(m.x, m.y);
    });

    // 3D Recessed windows on the keep walls. One helper, mirrored by the
    // wall slope m (+0.5 left face, -0.5 right face). The 3D read comes
    // from real architectural parts, all following the global light:
    //  - lintel UNDERSIDE at the top of the reveal (darkest — faces down)
    //  - side jamb on the light side of the reveal (mid tone)
    //  - deep dark opening
    let winFill = darken ? darkenColor('#1c1c1c') : '#1c1c1c';
    let jambC   = darken ? darkenColor(keepWood ? '#a97e4a' : '#bcb29b') : (keepWood ? '#a97e4a' : '#bcb29b');
    let lintelC = darken ? darkenColor(keepWood ? '#6f5330' : '#7c766b') : (keepWood ? '#6f5330' : '#7c766b');

    let drawKeepWindow = (wx2, wy2, m) => {
      X.save();
      X.strokeStyle = '#000000'; X.lineWidth = 1.3; X.lineJoin = 'round';
      let P = (x, yc) => ({ x: wx2 + x, y: wy2 + yc });
      // outer frame (vertical sides, top/bottom edges follow the wall slope)
      let O1 = P(-4, -7 - 4*m), O2 = P(4, -7 + 4*m), O3 = P(4, 7 + 4*m), O4 = P(-4, 7 - 4*m);
      // opening, recessed INTO the wall (sideways along the face + down)
      let B = o => ({ x: o.x + 4*m, y: o.y + 1.5 });
      let B1 = B(O1), B2 = B(O2), B3 = B(O3), B4 = B(O4);

      // Everything inside the reveal is CLIPPED to the outer frame — the
      // recessed quads shift sideways into the wall and would otherwise
      // poke past the frame on the recess side.
      let framePath = () => {
        X.beginPath();
        X.moveTo(O1.x, O1.y); X.lineTo(O2.x, O2.y); X.lineTo(O3.x, O3.y); X.lineTo(O4.x, O4.y);
        X.closePath();
      };
      X.save();
      framePath(); X.clip();
      // deep dark opening
      X.fillStyle = winFill; X.beginPath();
      X.moveTo(B1.x, B1.y); X.lineTo(B2.x, B2.y); X.lineTo(B3.x, B3.y); X.lineTo(B4.x, B4.y);
      X.closePath(); X.fill();
      // side jamb reveal (the side opposite the recess shift stays visible)
      let J1 = m > 0 ? O1 : O2, J2 = m > 0 ? O4 : O3;
      let JB1 = m > 0 ? B1 : B2, JB2 = m > 0 ? B4 : B3;
      X.fillStyle = jambC; X.beginPath();
      X.moveTo(J1.x, J1.y); X.lineTo(JB1.x, JB1.y); X.lineTo(JB2.x, JB2.y); X.lineTo(J2.x, J2.y);
      X.closePath(); X.fill();
      // lintel underside across the top of the reveal (darkest)
      X.fillStyle = lintelC; X.beginPath();
      X.moveTo(O1.x, O1.y); X.lineTo(O2.x, O2.y); X.lineTo(B2.x, B2.y); X.lineTo(B1.x, B1.y);
      X.closePath(); X.fill();
      // light interior seams (reveal edges)
      X.strokeStyle = 'rgba(0,0,0,0.2)'; X.lineWidth = 1;
      X.beginPath();
      X.moveTo(JB1.x, JB1.y); X.lineTo(JB2.x, JB2.y);
      X.moveTo(B1.x, B1.y); X.lineTo(B2.x, B2.y);
      X.stroke();
      X.restore();
      // dark outer frame on top of the clipped interior — no protruding
      // sill: it read as a tacked-on slab at this scale; the lintel
      // shadow + jamb + deep opening carry the 3D on their own
      framePath(); X.stroke();
      X.restore();
    };

    // Scaled up around their centers — read better against the larger keep
    // and sit centered between the Dark-age framing studs.
    drawKeepWindow(sx - 24, sy - 6,  0.5); // left wall window
    drawKeepWindow(sx + 24, sy - 6, -0.5); // right wall window
    // 2. Wooden posts, drawn BEFORE the annex roofs so the tent cloth
    // overlaps the pole tops (sorted back-to-front for depth)
    // Posts tucked 12% in from the outer roof corners toward the keep so
    // the whole post (cap included) sits UNDER the roof plane — the roofs
    // paint after the posts and hide the tops, reading as real support.
    // Heights meet the roof underside there (surface 18→28 minus boards).
    // Posts at the roof corners, nudged inward by their own half-width so
    // the post body stays inside the roof silhouette, and tall enough to
    // run up BEHIND the fascia (roof draws after posts) — the visible post
    // ends at the fascia's bottom edge with no seam, so the roof reads as
    // resting on the beams.
    let posts = [
      { x: sx - 93.5, y: sy + 48,    h: 15 }, // Left-most corner
      { x: sx - 48,   y: sy + 70.75, h: 15 }, // Bottom-left corner
      { x: sx + 93.5, y: sy + 48,    h: 15 }, // Right-most corner
      { x: sx + 48,   y: sy + 70.75, h: 15 }, // Bottom-right corner
      { x: sx,        y: sy + 48,    h: 25 }  // Center (under the high keep edge)
    ];
    posts.sort((a, b) => a.y - b.y);
    let postColor = WOOD.post;
    let pc = darken ? darkenColor(postColor) : postColor;
    X.lineJoin = 'round';
    // Contact shadows on the ground first, so every pole overlaps them.
    // Skipped in the selection-outline mask pass (window._maskDraw, see
    // render-outlines.js): shadows aren't part of the building's shape,
    // and rasterizing them into the silhouette put a gold-ringed blob on
    // the ground beside each courtyard post.
    if (!window._maskDraw) {
      X.fillStyle = 'rgba(0,0,0,0.25)';
      posts.forEach(p => {
        X.beginPath(); X.ellipse(p.x, p.y + 1, 5, 2.4, 0, 0, Math.PI*2); X.fill();
      });
    }
    // Square timber posts drawn as proper iso prisms: lit left face,
    // shaded right face, bright top cap — same light rules as buildings.
    let pL = darken ? darkenColor('#9a7a56') : '#9a7a56';
    let pR = darken ? darkenColor('#7c5f40') : '#7c5f40';
    let pT = darken ? darkenColor('#b08c62') : '#b08c62';
    posts.forEach(p => {
      let w = 2.5, hh2 = 1.25; // half-width / half-height of the post's tiny footprint
      X.strokeStyle = '#000000'; X.lineWidth = 1.1;
      // left face
      X.fillStyle = pL; X.beginPath();
      X.moveTo(p.x - w, p.y - hh2); X.lineTo(p.x, p.y);
      X.lineTo(p.x, p.y - p.h); X.lineTo(p.x - w, p.y - hh2 - p.h);
      X.closePath(); X.fill(); X.stroke();
      // right face
      X.fillStyle = pR; X.beginPath();
      X.moveTo(p.x, p.y); X.lineTo(p.x + w, p.y - hh2);
      X.lineTo(p.x + w, p.y - hh2 - p.h); X.lineTo(p.x, p.y - p.h);
      X.closePath(); X.fill(); X.stroke();
      // top cap
      X.fillStyle = pT; X.beginPath();
      X.moveTo(p.x, p.y - p.h); X.lineTo(p.x + w, p.y - hh2 - p.h);
      X.lineTo(p.x, p.y - 2*hh2 - p.h); X.lineTo(p.x - w, p.y - hh2 - p.h);
      X.closePath(); X.fill(); X.stroke();
    });

    // 3+4. Annex roofs (open-sided shelter roofs over the left and right
    // courtyard quadrants, in team color) — the two are the identical shape
    // mirored about the keep, so one helper drawn at ±48.
    drawTCAnnexRoof(sx, sy, -1, tc, tcD, darken);
    drawTCAnnexRoof(sx, sy, +1, tc, tcD, darken);

    // Team banner flying from the keep top
    // 68 plants the pole base exactly on the top merlon's cap (sy-70)
    // Every age flies the banner (only merlons are Castle-gated). Pole is
    // PLANTED on the recessed roof floor (sy-31) and long enough to fly
    // the flag clear above the rim.
    // At Castle the pole moves up onto the back merlon's cap (sy-70);
    // earlier ages plant it on the recessed roof floor as before.
    if(e.complete){
      if (ownerAge >= 2) drawWavingFlag(sx, sy, 66, darken ? darkenColor(tc) : tc, darken ? darkenColor(tcD) : tcD, 22);
      else drawWavingFlag(sx, sy, 29, darken ? darkenColor(tc) : tc, darken ? darkenColor(tcD) : tcD, 42);
    }
    X.restore();
  }
  else if(e.btype==='HOUSE'){
    // Timber-framed cottage under a big yellow hay gable roof.
    // Base spans the full tile diamond (W/hh = HALF_TW/HALF_TH), so all
    // four wall corners land exactly on the tile's edges.
    // Shared gable geometry (walls, gable end, team-colored roof slope,
    // course lines) via drawGableBlock — the branch used to inline a
    // line-for-line copy. House-only detailing: half-timber studs and
    // mid-rails (painted via the afterWalls hook, i.e. between the walls
    // and the roof, exactly where the old inline order put them), then a
    // pennant and the chimney below.
    let W=32, hh=16, wallH=16, roofH=20;
    bh=32;
    let sy0=sy+bhh-hh; // center on tile
    // Per-age wall texture:
    //  DARK   — bare plank walls: vertical board seams in the light
    //           interior-seam stroke (framing beams over brown planks had
    //           too little contrast and read as mud)
    //  FEUDAL — plaster with half-timber framing in the shared beam brown
    //  CASTLE — whitewash with darker oak framing so the timber still
    //           reads against the paler wall
    let hwL = ownerAge === 0 ? WOOD.plankL : aw.gl;
    let hwR = ownerAge === 0 ? WOOD.plankR : aw.gr;
    let beamCol = ownerAge >= 2 ? '#57432e' : WOOD.beam;
    let beam=darken?darkenColor(beamCol):beamCol;
    let {M1,M2,M1e,M2e,EL,EB} = drawGableBlock(sx, sy0, W, hh, wallH, roofH,
      hwL, hwR, tc, beamCol, darken, ()=>{
        if (ownerAge === 0) {
          // plank seams: vertical board joints on both faces
          X.strokeStyle='rgba(0,0,0,0.22)';X.lineWidth=1;
          [0.25,0.5,0.75].forEach(t=>{
            X.beginPath();X.moveTo(sx-W+W*t,sy0+hh-wallH+hh*t);X.lineTo(sx-W+W*t,sy0+hh+hh*t);X.stroke();
            X.beginPath();X.moveTo(sx+W*t,sy0+hh*2-wallH-hh*t);X.lineTo(sx+W*t,sy0+hh*2-hh*t);X.stroke();
          });
        } else {
          // Half-timber framing: studs and a mid-rail per face
          X.strokeStyle=beam;X.lineWidth=1.6;
          [0.35,0.7].forEach(t=>{
            X.beginPath();X.moveTo(sx-W+W*t,sy0+hh-wallH+hh*t);X.lineTo(sx-W+W*t,sy0+hh+hh*t);X.stroke();
            X.beginPath();X.moveTo(sx+W*t,sy0+hh*2-wallH-hh*t);X.lineTo(sx+W*t,sy0+hh*2-hh*t);X.stroke();
          });
          X.beginPath();X.moveTo(sx-W,sy0+hh-wallH*0.5);X.lineTo(sx,sy0+hh*2-wallH*0.5);X.lineTo(sx+W,sy0+hh-wallH*0.5);X.stroke();
        }
      });
    // (no pennant — the house stays clean)
    // Big 3D brick chimney poking through the roof slope: an iso block
    // with two shaded faces, a wider cap slab, and a dark flue opening.
    // FEUDAL+ only — the Dark-age cottage has a bare roof (a brick
    // chimney is part of the town growing up).
    if (ownerAge >= 1) {
      let cru={x:M2.x+(M1.x-M2.x)*0.3, y:M2.y+(M1.y-M2.y)*0.3};
      let cre={x:EL.x+(EB.x-EL.x)*0.3, y:EL.y+(EB.y-EL.y)*0.3};
      let bx=cru.x+(cre.x-cru.x)*0.3, by=cru.y+(cre.y-cru.y)*0.3;
      let topY=by-16, w=5, hh2=2.5;
      let brickL=darken?darkenColor('#9a4a34'):'#9a4a34';
      let brickR=darken?darkenColor('#7c3826'):'#7c3826';
      let capL=darken?darkenColor('#8d857a'):'#8d857a';
      let capR=darken?darkenColor('#6f675c'):'#6f675c';
      X.strokeStyle='#000';X.lineWidth=1.2;X.lineJoin='round';
      // Shaft: left (lit) and right (shaded) faces, sinking into the roof
      X.fillStyle=brickL;X.beginPath();
      X.moveTo(bx-w,topY+hh2);X.lineTo(bx,topY+hh2*2);X.lineTo(bx,by+hh2*2);X.lineTo(bx-w,by+hh2);X.closePath();X.fill();X.stroke();
      X.fillStyle=brickR;X.beginPath();
      X.moveTo(bx,topY+hh2*2);X.lineTo(bx+w,topY+hh2);X.lineTo(bx+w,by+hh2);X.lineTo(bx,by+hh2*2);X.closePath();X.fill();X.stroke();
      // Mortar course lines on the lit face
      X.strokeStyle='rgba(0,0,0,0.2)';X.lineWidth=1;
      for(let t of [0.35,0.7]){
        let yy=topY+(by-topY)*t;
        X.beginPath();X.moveTo(bx-w,yy+hh2);X.lineTo(bx,yy+hh2*2);X.stroke();
      }
      // Cap slab: a wider stone diamond with visible thickness
      let cw=w+2, chh=hh2+1, capY=topY-3;
      X.strokeStyle='#000';X.lineWidth=1.2;
      X.fillStyle=capR;X.beginPath(); // slab side skirts
      X.moveTo(bx-cw,capY+chh);X.lineTo(bx,capY+chh*2);X.lineTo(bx+cw,capY+chh);
      X.lineTo(bx+cw,capY+chh+3);X.lineTo(bx,capY+chh*2+3);X.lineTo(bx-cw,capY+chh+3);
      X.closePath();X.fill();X.stroke();
      X.fillStyle=capL;X.beginPath(); // slab top face
      X.moveTo(bx,capY);X.lineTo(bx+cw,capY+chh);X.lineTo(bx,capY+chh*2);X.lineTo(bx-cw,capY+chh);X.closePath();X.fill();X.stroke();
      // Dark flue opening in the middle of the cap
      X.fillStyle=darken?darkenColor('#1c1208'):'#1c1208';X.beginPath();
      X.moveTo(bx,capY+chh-1.6);X.lineTo(bx+3,capY+chh);X.lineTo(bx,capY+chh+1.6);X.lineTo(bx-3,capY+chh);X.closePath();X.fill();X.stroke();
      if(e.complete && visible) drawChimneySmoke(bx,capY-4);
    }
  }
  else if(e.btype==='BARRACKS'){
    // The barracks art below is authored for the original 2x2 footprint (sx
    // is the footprint's top screen corner, 32px = 2*HALF_TH above the
    // centre; the hall/yard grid is pinned to those plot corners). For a
    // larger footprint (now 3x3) scale the whole drawing up about the
    // footprint centre and run the authored art unchanged against its 2x2
    // reference corner — one source of truth for the compound geometry.
    let bkS = b.w / 2;
    let bkCx = sx, bkCy = sy + bhh; // footprint centre in screen space
    sy = bkCy - 32;                 // authored 2x2 top corner
    X.save();
    X.translate(bkCx, bkCy); X.scale(bkS, bkS); X.translate(-bkCx, -bkCy);
    bh = 32 * bkS; // scaled height, for overlays drawn after restore()
    // Small tethered horse in side profile (east-facing), one-piece
    // silhouette: rump -> back -> neck crest -> head -> muzzle -> chest ->
    // belly. Used by the age-gated hitching rail below to advertise that
    // this building trains cavalry.
    // East-profile horse borrowed from the unit renderer's construction
    // (body capsule + arched neck/head silhouette + straight legs with
    // hooves + rounded tail). graze: the whole head group rotates about
    // the withers so the muzzle dips to the ground and back — the same
    // rigid-group motion as the units' idle nod, just bigger.
    let drawYardHorse=(hx,hy,coat,maneC,graze=false)=>{
      let c=darken?darkenColor(coat):coat, m=darken?darkenColor(maneC):maneC;
      let legC=coat==='#e9e6de'?'#b3ada1':'#6e4520';
      if(darken) legC=darkenColor(legC);
      // over-driven clamped sine: dwells at head-down / head-up
      let g=(graze&&visible)?Math.min(1,Math.max(0,Math.sin(tick*0.02+e.id)*1.5+0.4)):0;
      let swish=visible?Math.sin(tick*0.08+e.id)*0.2:0;
      X.save();X.translate(hx,hy-5.2);X.scale(1.05,1.05);
      X.lineJoin='round';
      // tail (farthest — behind the legs)
      X.save();X.translate(-6.6,-7);X.rotate(swish);
      X.beginPath();X.moveTo(0,0);X.quadraticCurveTo(-2.7,3,-2.2,9);
      X.strokeStyle='#000';X.lineWidth=2.5;X.lineCap='round';X.stroke();
      X.strokeStyle=m;X.lineWidth=1.3;X.stroke();X.lineCap='butt';
      X.restore();
      // legs
      X.beginPath();
      X.moveTo(3.5,-4);X.lineTo(3.5,4.4);X.moveTo(5.5,-4);X.lineTo(5.5,4.4);
      X.moveTo(-4.5,-4);X.lineTo(-4.5,4.4);X.moveTo(-6.5,-4);X.lineTo(-6.5,4.4);
      X.strokeStyle='#000';X.lineWidth=2.2;X.lineCap='round';X.stroke();
      X.strokeStyle=legC;X.lineWidth=1.1;X.stroke();X.lineCap='butt';
      X.fillStyle='#241408';
      [[3.5,4.4],[5.5,4.4],[-4.5,4.4],[-6.5,4.4]].forEach(p=>{
        X.beginPath();X.ellipse(p[0],p[1]+0.5,1.5,1.1,0,0,Math.PI*2);X.fill();
      });
      // body capsule
      X.strokeStyle='#000';X.lineWidth=0.95;X.fillStyle=c;
      X.beginPath();X.ellipse(0,-6,7.4,4.9,0,0,Math.PI*2);X.fill();X.stroke();
      // neck + head group, rotating about the withers to graze
      X.save();
      X.translate(2,-5);X.rotate(g*0.85);X.translate(-2,5);
      X.translate(2.6,0);
      const ear=(ex,ey,ang)=>{X.save();X.translate(ex,ey);X.rotate(ang);
        X.beginPath();X.moveTo(-1.1,0.6);
        X.quadraticCurveTo(-1.3,-1.6,0,-2.4);
        X.quadraticCurveTo(1.3,-1.6,1.1,0.6);X.closePath();
        X.fillStyle=c;X.strokeStyle='#000';X.lineWidth=0.95;X.fill();X.stroke();X.restore();};
      ear(8.5,-13.9,-0.2);ear(10.1,-13.3,0.3);
      X.fillStyle=c;X.strokeStyle='#000';X.lineWidth=0.95;
      X.beginPath();
      X.moveTo(2.2,-2.6);
      X.quadraticCurveTo(6.6,-4.6,7.8,-9);      // front of neck up to the throat
      X.quadraticCurveTo(10.5,-8.6,14.2,-8.6);  // long flat jaw out to the muzzle
      X.lineTo(14.8,-12);                       // tall squared nose end
      X.quadraticCurveTo(12.5,-13.6,9.6,-13.9); // long flat forehead back to the poll
      X.quadraticCurveTo(4.6,-14.4,1.6,-11);    // arched crest of the neck
      X.quadraticCurveTo(-0.4,-8.5,-0.6,-5.5);  // down into the withers
      X.fill();X.stroke();
      // mane along the crest
      X.strokeStyle=m;X.lineWidth=1.5;X.lineCap='round';
      X.beginPath();X.moveTo(0.4,-7.5);X.quadraticCurveTo(3.4,-12,7.6,-13.2);X.stroke();
      X.lineCap='butt';
      // eye high on the head, nostril at the nose (same as the unit horse)
      X.fillStyle='#000';
      X.beginPath();X.arc(9.7,-11.7,0.6,0,Math.PI*2);X.fill();
      X.fillStyle='rgba(0,0,0,0.45)';
      X.beginPath();X.arc(13.9,-10.3,0.5,0,Math.PI*2);X.fill();
      X.restore();
      X.restore();
    };
    // Shared compound geometry: everything (hall, yard, fence, props)
    // lives on one parallelogram grid. BP(a,b) maps a (along the NE long
    // axis, ±bL) and b (across, hall wall at b=bD, yard front at b=bYF)
    // to screen.
    // bYF=51 pushes the yard's front to the plot boundary: the left end
    // edge is parallel to the plot's front-left edge (1 unit inside), and
    // at b=51 the right front corner just meets the front-right edge.
    const bL=30, bD=13, bYF=51;
    const bcx=sx-20, bcy=sy+23;
    const BP=(a,b)=>({x:bcx+a+b, y:bcy-a/2+b/2});

    // 0. Training-yard pad FIRST (ground layer): a full-length
    // parallelogram running the hall's entire front, wall line to fence.
    let Y1=BP(-bL,bD), Y2=BP(bL,bD), Y3=BP(bL,bYF), Y4=BP(-bL,bYF);
    X.fillStyle=darken ? darkenColor('#bfa38a') : '#bfa38a';X.beginPath();
    X.moveTo(Y1.x,Y1.y);X.lineTo(Y2.x,Y2.y);X.lineTo(Y3.x,Y3.y);X.lineTo(Y4.x,Y4.y);
    X.closePath();X.fill();
    X.strokeStyle='#000000';X.lineWidth=1.2;X.stroke();
    // rake marks: light lines parallel to the hall
    X.save();X.strokeStyle='rgba(0,0,0,0.08)';X.lineWidth=1;
    [22.5,32,41.5].forEach(b=>{
      let p1=BP(-bL,b), p2=BP(bL,b);
      X.beginPath();X.moveTo(p1.x,p1.y);X.lineTo(p2.x,p2.y);X.stroke();
    });
    X.restore();

    // 1. Custom rectangular garrison hall: half-length L along the NE
    // axis, half-depth D across (drawGableBlock only makes square
    // diamonds). With cx=sx-20, cy=sy+23, L=30, D=13 the math works out
    // exactly: the NW back wall lies ON the plot's back-left edge from
    // the left corner (sx-64,sy+32) to the top corner (sx,sy), and the
    // SE front wall passes through the yard's top corner (sx,sy+26).
    // roofH > D/2 keeps the back roof slope entirely hidden — no
    // back-eave artifacts. Ridge overhangs both gable ends slightly.
    {
      // g=0: a ridge overhang past the gable planes projects to a ~1px
      // sliver between near-parallel edges (the strip's end edge and the
      // gable roofline differ by only 0.9px perpendicular) — it renders
      // as a black spike, so the roof ends exactly at the gable faces.
      const L=30, D=13, wallH=24, roofH=12, g=0;
      const cx=sx-20, cy=sy+23;
      const P=(a,b)=>({x:cx+a+b, y:cy-a/2+b/2});
      const up=(p,h)=>({x:p.x, y:p.y-h});
      let Wc=P(-L,-D), Sc=P(-L,D), Ec=P(L,D);
      let R1=up(P(-L,0),wallH+roofH), R1e=up(P(-L-g,0),wallH+roofH), R2e=up(P(L+g,0),wallH+roofH);
      let wl=darken?darkenColor(aw.gl):aw.gl, wr=darken?darkenColor(aw.gr):aw.gr;
      let rl=darken?darkenColor(tc):tc;
      X.strokeStyle='#000';X.lineWidth=1.3;X.lineJoin='round';
      // BACK roof slope first: it recedes NW at screen slope 0.19/unit
      // while the ridge climbs 0.5/unit, so it shows as a strip above the
      // ridge. Darker (faces away from the light). Eave at v=-(D+2)
      // offsets each ridge point by (-(D+2), (D+2)*(roofH/D-0.5)).
      {
        let bo={x:-(D+2), y:(D+2)*(roofH/D-0.5)};
        let rd=darken?darkenColor(tcD):tcD;
        X.fillStyle=rd;X.beginPath();
        X.moveTo(R1e.x,R1e.y);X.lineTo(R2e.x,R2e.y);
        X.lineTo(R2e.x+bo.x,R2e.y+bo.y);X.lineTo(R1e.x+bo.x,R1e.y+bo.y);
        X.closePath();X.fill();X.stroke();
      }
      // SW gable end: wall + triangle as one lit face
      X.fillStyle=wl;X.beginPath();
      X.moveTo(Wc.x,Wc.y);X.lineTo(Sc.x,Sc.y);
      X.lineTo(Sc.x,Sc.y-wallH);X.lineTo(R1.x,R1.y);X.lineTo(Wc.x,Wc.y-wallH);
      X.closePath();X.fill();X.stroke();
      // SE long wall (shaded side)
      X.fillStyle=wr;X.beginPath();
      X.moveTo(Sc.x,Sc.y);X.lineTo(Ec.x,Ec.y);
      X.lineTo(Ec.x,Ec.y-wallH);X.lineTo(Sc.x,Sc.y-wallH);
      X.closePath();X.fill();X.stroke();
      // Door on the GABLE END wall (away from the yard) — the yard-facing
      // wall carries only windows. Recessed into the wall for real depth,
      // same architecture as the TC keep windows (drawKeepWindow above):
      // a deep dark opening shifted back into the wall, revealing a lintel
      // underside across the top (darkest, faces down) and one side jamb
      // (mid tone), all clipped to the outer frame and following the
      // upper-left light. The wall face runs along (1,0.5) per along-unit
      // and rises straight up; the recess shifts the opening sideways into
      // the wall + down so the lintel shows (mirrors the TC's +down shift).
      {
        let db=P(-L,0);
        let W=4.5, H=11, depth=2;
        // frame corners on the wall surface (base on the ground line)
        let O1={x:db.x-W, y:db.y-W*0.5-H}, O2={x:db.x+W, y:db.y+W*0.5-H}; // top-left, top-right
        let O3={x:db.x+W, y:db.y+W*0.5},   O4={x:db.x-W, y:db.y-W*0.5};   // bottom-right, bottom-left
        // opening: pushed back into the wall (along +along) and down, so
        // the top lintel reveal and the left jamb become visible
        let B=o=>({x:o.x+depth, y:o.y+depth*0.5+1.5});
        let B1=B(O1),B2=B(O2),B3=B(O3),B4=B(O4);
        let doorDark=darken?darkenColor('#241505'):'#241505';
        let jambC=darken?darkenColor('#6f5330'):'#6f5330';
        let lintelC=darken?darkenColor('#503a21'):'#503a21';
        let framePath=()=>{X.beginPath();X.moveTo(O1.x,O1.y);X.lineTo(O2.x,O2.y);X.lineTo(O3.x,O3.y);X.lineTo(O4.x,O4.y);X.closePath();};
        X.save();
        framePath();X.clip();
        // deep dark opening
        X.fillStyle=doorDark;X.beginPath();
        X.moveTo(B1.x,B1.y);X.lineTo(B2.x,B2.y);X.lineTo(B3.x,B3.y);X.lineTo(B4.x,B4.y);X.closePath();X.fill();
        // left jamb reveal (frame's left edge → opening's left edge)
        X.fillStyle=jambC;X.beginPath();
        X.moveTo(O1.x,O1.y);X.lineTo(B1.x,B1.y);X.lineTo(B4.x,B4.y);X.lineTo(O4.x,O4.y);X.closePath();X.fill();
        // lintel underside across the top (darkest)
        X.fillStyle=lintelC;X.beginPath();
        X.moveTo(O1.x,O1.y);X.lineTo(O2.x,O2.y);X.lineTo(B2.x,B2.y);X.lineTo(B1.x,B1.y);X.closePath();X.fill();
        // light interior seams (reveal inner edges)
        X.strokeStyle='rgba(0,0,0,0.22)';X.lineWidth=1;
        X.beginPath();X.moveTo(B1.x,B1.y);X.lineTo(B4.x,B4.y);X.moveTo(B1.x,B1.y);X.lineTo(B2.x,B2.y);X.stroke();
        X.restore();
        // dark door frame outline over the clipped interior
        X.strokeStyle='#000';X.lineWidth=1.1;framePath();X.stroke();
      }
      // Row of small windows facing the yard — the hall SLEEPS the garrison
      X.fillStyle=darken?darkenColor('#2a2a2a'):'#2a2a2a';X.lineWidth=0.9;
      [-16,-4,8,20].forEach(a=>{
        let wb=up(P(a,D), wallH*0.4);
        X.beginPath();
        X.moveTo(wb.x-2.4,wb.y+1.2);X.lineTo(wb.x+2.4,wb.y-1.2);
        X.lineTo(wb.x+2.4,wb.y-1.2-4.5);X.lineTo(wb.x-2.4,wb.y+1.2-4.5);
        X.closePath();X.fill();X.stroke();
      });
      // Roof: single visible front slope, ridge + eaves overhanging
      let Se=up(P(-L-g,D+2), wallH-1.2), Ee=up(P(L+g,D+2), wallH-1.2);
      X.fillStyle=rl;X.lineWidth=1.3;
      X.beginPath();X.moveTo(R1e.x,R1e.y);X.lineTo(R2e.x,R2e.y);
      X.lineTo(Ee.x,Ee.y);X.lineTo(Se.x,Se.y);X.closePath();X.fill();X.stroke();
      X.save();X.strokeStyle='rgba(0,0,0,0.15)';X.lineWidth=1;
      [0.35,0.7].forEach(t=>{
        X.beginPath();
        X.moveTo(R1e.x+(Se.x-R1e.x)*t, R1e.y+(Se.y-R1e.y)*t);
        X.lineTo(R2e.x+(Ee.x-R2e.x)*t, R2e.y+(Ee.y-R2e.y)*t);
        X.stroke();
      });
      X.restore();
      // Team banner flying from the ridge's right end (the tower is gone;
      // the hall carries the flag now)
      if(e.complete && visible) drawWavingFlag(R2e.x, sy, 26, tc, tcD); // base on the raised ridge end
    }

    // Right-end fence edge FIRST so the yard props (horse especially)
    // stand in front of its rails
    drawBarracksFence(
      [BP(bL,26),BP(bL,38.5)],
      [[BP(bL,bD),BP(bL,bYF)]], darken);

    // Cavalry spot at the FAR end of the yard (right corner): one horse
    // with a haystack — a bay when scouts unlock at Feudal, swapped for
    // the knight's white charger at Castle.
    if(ownerAge >= 1){
      let coat = ownerAge >= 2 ? '#e9e6de' : '#8b5a2b';
      let mane = ownerAge >= 2 ? '#9a948a' : '#3f2810';
      let hp0=BP(14,33);
      drawYardHorse(hp0.x, hp0.y, coat, mane, true); // grazing at the haystack
      // haystack mound in front of the horse
      let hayC=darken?darkenColor('#d9b44a'):'#d9b44a';
      let hpH=BP(20,44); // near the front fence — its rails overlap the mound slightly
      let hx2=hpH.x, hy2=hpH.y;
      X.fillStyle=hayC;X.strokeStyle='#000';X.lineWidth=1;
      X.beginPath();
      X.moveTo(hx2-5,hy2);
      X.quadraticCurveTo(hx2-3.6,hy2-5,hx2,hy2-5.3);
      X.quadraticCurveTo(hx2+3.6,hy2-5,hx2+5,hy2);
      X.ellipse(hx2,hy2,5,2,0,0,Math.PI);
      X.closePath();X.fill();X.stroke();
      X.save();X.strokeStyle='rgba(0,0,0,0.3)';X.lineWidth=0.7;
      X.beginPath();X.moveTo(hx2-2.6,hy2-1.4);X.lineTo(hx2-0.9,hy2-3.6);
      X.moveTo(hx2+0.9,hy2-3.8);X.lineTo(hx2+2.6,hy2-1.4);X.stroke();
      X.restore();
    }

    // Straw training dummies. Dark age (militia only) drills at TWO
    // dummies, mirrored around the yard center; from Feudal the left one
    // is replaced by the archery target / spear rack / horse gear.
    let drawDummy=(pt)=>{
      let dxp=pt.x, dyp=pt.y;
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
    };
    if(ownerAge === 0){ drawDummy(BP(-12,32)); drawDummy(BP(12,32)); }
    else drawDummy(BP(0,30));

    // Archery target: round straw butt on an A-frame stand — the ARCHER
    // tell, so it only appears once archers unlock at Feudal
    if(ownerAge >= 1){
      let tp0=BP(-15,40); // open front-left ground, nothing crowding it
      let tgx=tp0.x, tgy=tp0.y;
      X.strokeStyle='#000000';X.lineWidth=1.8;X.lineCap='round';
      X.beginPath();X.moveTo(tgx-3.2,tgy);X.lineTo(tgx,tgy-7);X.moveTo(tgx+3.2,tgy);X.lineTo(tgx,tgy-7);X.stroke();
      X.strokeStyle=darken ? darkenColor(WOOD.post) : WOOD.post;X.lineWidth=1;
      X.beginPath();X.moveTo(tgx-3.2,tgy);X.lineTo(tgx,tgy-7);X.moveTo(tgx+3.2,tgy);X.lineTo(tgx,tgy-7);X.stroke();
      X.lineCap='butt';
      X.strokeStyle='#000000';X.lineWidth=1;
      X.fillStyle=darken ? darkenColor('#e8c04a') : '#e8c04a'; // straw butt
      X.beginPath();X.arc(tgx,tgy-9,4.4,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle=darken ? darkenColor('#f5f2e9') : '#f5f2e9';
      X.beginPath();X.arc(tgx,tgy-9,2.8,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle=darken ? darkenColor('#c03a2b') : '#c03a2b';
      X.beginPath();X.arc(tgx,tgy-9,1.3,0,Math.PI*2);X.fill();X.stroke();

      // Spear rack (the SPEARMAN tell, also Feudal): two spears leaning
      // on a low rail at the front-left fence
      let rp0=BP(-15,26); // open ground, 10 units clear of the left fence
      let rx=rp0.x, ry=rp0.y;
      X.strokeStyle='#000';X.lineWidth=2;X.lineCap='round';
      X.beginPath();X.moveTo(rx-4,ry);X.lineTo(rx-4,ry-6);X.moveTo(rx+4,ry);X.lineTo(rx+4,ry-6);X.stroke();
      X.beginPath();X.moveTo(rx-5,ry-5.5);X.lineTo(rx+5,ry-5.5);X.stroke();
      X.strokeStyle=darken ? darkenColor(WOOD.post) : WOOD.post;X.lineWidth=0.9;
      X.beginPath();X.moveTo(rx-4,ry);X.lineTo(rx-4,ry-6);X.moveTo(rx+4,ry);X.lineTo(rx+4,ry-6);X.stroke();
      X.beginPath();X.moveTo(rx-5,ry-5.5);X.lineTo(rx+5,ry-5.5);X.stroke();
      X.lineCap='butt';
      let shaft=darken ? darkenColor('#8a5a2b') : '#8a5a2b';
      [[-2,1],[1.5,2.5]].forEach(([ox,ox2])=>{
        X.strokeStyle='#000';X.lineWidth=1.9;
        X.beginPath();X.moveTo(rx+ox,ry+1);X.lineTo(rx+ox2,ry-13);X.stroke();
        X.strokeStyle=shaft;X.lineWidth=0.9;
        X.beginPath();X.moveTo(rx+ox,ry+1);X.lineTo(rx+ox2,ry-13);X.stroke();
        X.fillStyle=darken ? darkenColor('#c8c8c8') : '#c8c8c8';X.strokeStyle='#000';X.lineWidth=0.8;
        X.beginPath();X.moveTo(rx+ox2-1,ry-13);X.lineTo(rx+ox2+1,ry-13);X.lineTo(rx+ox2,ry-16);X.closePath();X.fill();X.stroke();
      });
    }

    // 3D post-and-rail fence along the LEFT END and the long FRONT edge
    // (the right end was drawn earlier, behind the props): posts at
    // corners and evenly along the run, two rails between.
    drawBarracksFence(
      [BP(-bL,bD),BP(-bL,26),BP(-bL,38.5),BP(-bL,bYF),BP(-15,bYF),BP(0,bYF),BP(15,bYF),BP(bL,bYF)],
      [[BP(-bL,bD),BP(-bL,bYF),BP(bL,bYF)]], darken);
    X.restore();
  }
  else if(e.btype==='MARKET'){
    // Open-air bazaar on a flagstone plaza: striped-awning stalls on posts,
    // goods under each, a freestanding wares cluster, and a central team
    // banner. No enclosed hall (deliberate — see the market plan). 3x3
    // footprint, so bw=96/bhh=48; stalls are small props across the tile.
    //
    // The plaza is WALKABLE (see walkable() in pathfinding.js), so when the
    // market is complete render.js pushes one sortable proxy per part
    // (MARKET_PART_ANCHORS) instead of a single drawable — units then paint
    // between the stalls correctly. `part` selects one piece; part===null
    // (outlines, pixel-hit, construction site) draws everything back→front.
    bh=44;
    let only = p => part === null || part === p;
    if(only('ground')){
      drawMarketPlaza(sx, sy, bw, bhh, e.id, darken);
      // Soft prop shadows on the pavement, in the ground layer so plaza
      // walkers draw over them. Shadow, not shape — skip in the mask pass
      // (the union building-shadow pass skips MARKET entirely).
      if(!window._maskDraw){
        X.fillStyle='rgba(0,0,0,0.16)';
        [[0,0.42,21],[-64,1.09,21],[64,1.09,21],[0,1.75,15]].forEach(([dx,k,rx])=>{
          X.beginPath();X.ellipse(sx+dx,sy+bhh*k,rx,rx*0.45,0,0,Math.PI*2);X.fill();
        });
      }
      if(part){ X.globalAlpha=1; return; }
    }

    let canvasL = darken?darkenColor('#efe7d2'):'#efe7d2';
    let canvasR = darken?darkenColor('#d6ccb2'):'#d6ccb2';
    let postC   = darken?darkenColor(WOOD.post):WOOD.post;
    let tccF    = darken?darkenColor(tc):tc;    // lit (front-left) faces
    let tccR    = darken?darkenColor(tcD):tcD;  // shaded (front-right) faces

    // Goods pile centered on (cx,cy): 'crate'|'sacks'|'basket'|'amphorae'.
    let drawGood=(cx,cy,type)=>{
      X.strokeStyle='#000';X.lineWidth=1.1;X.lineJoin='round';
      if(type==='crate'){
        const a=9,b=5.2,hh=12, UX=0.894,UY=0.447, VX=-0.894,VY=0.447;
        let A=[cx-a*UX-b*VX, cy-a*UY-b*VY]; // back
        let B=[cx+a*UX-b*VX, cy+a*UY-b*VY]; // right
        let C=[cx+a*UX+b*VX, cy+a*UY+b*VY]; // front (near)
        let D=[cx-a*UX+b*VX, cy-a*UY+b*VY]; // left
        let wR=darken?darkenColor('#87673c'):'#87673c';
        let wL=darken?darkenColor('#a07a48'):'#a07a48';
        let wT=darken?darkenColor('#b58a52'):'#b58a52';
        X.fillStyle=wR;X.beginPath();X.moveTo(B[0],B[1]-hh);X.lineTo(C[0],C[1]-hh);X.lineTo(C[0],C[1]);X.lineTo(B[0],B[1]);X.closePath();X.fill();X.stroke();
        X.fillStyle=wL;X.beginPath();X.moveTo(C[0],C[1]-hh);X.lineTo(D[0],D[1]-hh);X.lineTo(D[0],D[1]);X.lineTo(C[0],C[1]);X.closePath();X.fill();X.stroke();
        X.fillStyle=wT;X.beginPath();X.moveTo(A[0],A[1]-hh);X.lineTo(B[0],B[1]-hh);X.lineTo(C[0],C[1]-hh);X.lineTo(D[0],D[1]-hh);X.closePath();X.fill();X.stroke();
        X.save();X.strokeStyle='rgba(0,0,0,0.28)';X.lineWidth=0.8;
        X.beginPath();X.moveTo(C[0],C[1]-hh*0.5);X.lineTo(D[0],D[1]-hh*0.5);X.stroke();X.restore();
      } else if(type==='sacks'){
        // The SAME plump tied-neck grain sack the trade cart hauls
        // (drawCartLoad, js/render-units.js) — stall goods and cart cargo
        // read as one and the same trade. One big + one smaller behind.
        let sc =darken?darkenColor('#cdb98c'):'#cdb98c';
        let sc2=darken?darkenColor('#b6a074'):'#b6a074';
        let tie=darken?darkenColor(WOOD.beam):WOOD.beam;
        let sack=(ax,ay,s)=>{
          X.fillStyle=sc;X.beginPath();X.ellipse(ax,ay,5.2*s,5.6*s,0,0,Math.PI*2);X.fill();X.stroke();
          X.beginPath();X.ellipse(ax+1.6*s,ay-6.3*s,1.9*s,1.3*s,0.5,0,Math.PI*2);X.fill();X.stroke();
          X.strokeStyle=tie;X.lineWidth=1.2;
          X.beginPath();X.moveTo(ax-0.6*s,ay-5.1*s);X.lineTo(ax+2.4*s,ay-4.5*s);X.stroke();
          X.strokeStyle='#000';X.lineWidth=1.1;
          X.fillStyle=sc2;X.beginPath();X.ellipse(ax+1.1*s,ay+1.9*s,2.2*s,2.5*s,0,0,Math.PI*2);X.fill();
        };
        sack(cx-6.5,cy+0.5,1.0);
        sack(cx+3.5,cy+1,1.65);
      } else if(type==='gold'){
        // Gold for sale: a stack of INGOT BARS — long, low iso bricks in a
        // 2+1 pyramid, the unmistakable "pile of gold bars" read.
        let gT=darken?darkenColor('#ffd95e'):'#ffd95e';
        let gL=darken?darkenColor('#f0b429'):'#f0b429';
        let gR=darken?darkenColor('#c98b1d'):'#c98b1d';
        let bar=(bx,by)=>{
          const a=8,b=3.2,hh=4.4, UX=0.894,UY=0.447, VX=-0.894,VY=0.447;
          let A=[bx-a*UX-b*VX, by-a*UY-b*VY], B=[bx+a*UX-b*VX, by+a*UY-b*VY];
          let C=[bx+a*UX+b*VX, by+a*UY+b*VY], D=[bx-a*UX+b*VX, by-a*UY+b*VY];
          X.fillStyle=gR;X.beginPath();X.moveTo(B[0],B[1]-hh);X.lineTo(C[0],C[1]-hh);X.lineTo(C[0],C[1]);X.lineTo(B[0],B[1]);X.closePath();X.fill();X.stroke();
          X.fillStyle=gL;X.beginPath();X.moveTo(C[0],C[1]-hh);X.lineTo(D[0],D[1]-hh);X.lineTo(D[0],D[1]);X.lineTo(C[0],C[1]);X.closePath();X.fill();X.stroke();
          X.fillStyle=gT;X.beginPath();X.moveTo(A[0],A[1]-hh);X.lineTo(B[0],B[1]-hh);X.lineTo(C[0],C[1]-hh);X.lineTo(D[0],D[1]-hh);X.closePath();X.fill();X.stroke();
        };
        bar(cx-3.8,cy+3.2);
        bar(cx+5.5,cy+4.2);
        bar(cx+1,cy-2.2); // top bar bridging the two
      } else if(type==='stone'){
        // Stone for sale: two chunky iso blocks + one on top, grey triple
        // (top brightest, left lit, right shaded).
        let sT=darken?darkenColor('#9aa09e'):'#9aa09e';
        let sL=darken?darkenColor('#7e8583'):'#7e8583';
        let sR=darken?darkenColor('#5f6664'):'#5f6664';
        let block=(bx,by,a,b,hh)=>{
          const UX=0.894,UY=0.447, VX=-0.894,VY=0.447;
          let A=[bx-a*UX-b*VX, by-a*UY-b*VY], B=[bx+a*UX-b*VX, by+a*UY-b*VY];
          let C=[bx+a*UX+b*VX, by+a*UY+b*VY], D=[bx-a*UX+b*VX, by-a*UY+b*VY];
          X.fillStyle=sR;X.beginPath();X.moveTo(B[0],B[1]-hh);X.lineTo(C[0],C[1]-hh);X.lineTo(C[0],C[1]);X.lineTo(B[0],B[1]);X.closePath();X.fill();X.stroke();
          X.fillStyle=sL;X.beginPath();X.moveTo(C[0],C[1]-hh);X.lineTo(D[0],D[1]-hh);X.lineTo(D[0],D[1]);X.lineTo(C[0],C[1]);X.closePath();X.fill();X.stroke();
          X.fillStyle=sT;X.beginPath();X.moveTo(A[0],A[1]-hh);X.lineTo(B[0],B[1]-hh);X.lineTo(C[0],C[1]-hh);X.lineTo(D[0],D[1]-hh);X.closePath();X.fill();X.stroke();
        };
        block(cx-4.8,cy+4,6,3.9,7);
        block(cx+5.8,cy+4.8,5.3,3.5,6);
        block(cx+0.8,cy-3.4,5,3.4,6);
      } else { // logs — the LUMBER CAMP's iso log pile (same recipe: round-
        // capped stroke along the SE axis, lit top edge, pale cut end with
        // a growth ring), so market timber matches camp timber.
        // Lighter warm brown than the camp's — matches the crate's wood
        // palette so the wares corner reads as one set.
        let logCol=darken?darkenColor('#9b7245'):'#9b7245';
        let endCol=darken?darkenColor('#ebd2b0'):'#ebd2b0';
        const UX=0.894, UY=0.447;   // SE ground direction
        const VX=-0.894, VY=0.447;  // SW ground direction
        let isoLog=(lx,ly,L,r)=>{
          let x1=lx-L*UX, y1=ly-L*UY, x2=lx+L*UX, y2=ly+L*UY;
          X.lineCap='round';
          X.strokeStyle='#000000';X.lineWidth=r*2+2.4;
          X.beginPath();X.moveTo(x1,y1);X.lineTo(x2,y2);X.stroke();
          X.strokeStyle=logCol;X.lineWidth=r*2;
          X.beginPath();X.moveTo(x1,y1);X.lineTo(x2,y2);X.stroke();
          X.lineCap='butt';
          X.save();X.strokeStyle='rgba(255,255,255,0.25)';X.lineWidth=1;
          X.beginPath();X.moveTo(x1,y1-r+1.2);X.lineTo(x2,y2-r+1.2);X.stroke();
          X.restore();
          X.strokeStyle='#000000';X.lineWidth=1.2;
          X.fillStyle=endCol;
          X.beginPath();X.ellipse(x2,y2,r*0.88,r,0,0,Math.PI*2);X.fill();X.stroke();
          X.save();X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8;
          X.beginPath();X.ellipse(x2,y2,r*0.45,r*0.52,0,0,Math.PI*2);X.stroke();X.restore();
          X.strokeStyle='#000';X.lineWidth=1.1;
        };
        // painter's order: farther ground log, nearer one, stacked on top
        isoLog(cx-VX*5.5,cy-VY*5.5+2,10,4);
        isoLog(cx+VX*5.5,cy+VY*5.5+2,10,4);
        isoLog(cx,cy-4.5,10,4);
      }
    };

    // One market stall: a striped-canvas canopy (a tile-aligned diamond
    // lifted by H) on 4 posts, goods underneath, and a scalloped valance
    // hanging from the two front eaves.
    let stall=(cx,cyc,good)=>{
      const w=21,h=10.5,H=20;
      let corners={T:[cx,cyc-h],R:[cx+w,cyc],B:[cx,cyc+h],L:[cx-w,cyc]};
      let post=(g)=>{
        X.lineCap='round';
        X.strokeStyle='#000';X.lineWidth=3.4;X.beginPath();X.moveTo(g[0],g[1]);X.lineTo(g[0],g[1]-H);X.stroke();
        X.strokeStyle=postC;X.lineWidth=1.6;X.beginPath();X.moveTo(g[0],g[1]);X.lineTo(g[0],g[1]-H);X.stroke();
        X.lineCap='butt';
      };
      // back + side posts, then goods, then the near (front) post over them;
      // goods sit at the canopy's center — properly INSIDE the tent
      post(corners.T);post(corners.L);post(corners.R);
      drawGood(cx,cyc+0.5,good);
      post(corners.B);
      // raised canopy corners
      let Tr=[corners.T[0],corners.T[1]-H],Rr=[corners.R[0],corners.R[1]-H],
          Br=[corners.B[0],corners.B[1]-H],Lr=[corners.L[0],corners.L[1]-H];
      let lerp=(p,q,t)=>[p[0]+(q[0]-p[0])*t, p[1]+(q[1]-p[1])*t];
      // each triangular face: cream base + 2-of-4 team-color awning stripes
      // fanning from the eave corner across the Tr→Br ridge (wedges lie
      // exactly inside the face triangle, so no clip is needed). Quarter
      // stripes, not fifths: fat enough to survive sub-10px.
      X.strokeStyle='#000';X.lineWidth=1.3;X.lineJoin='round';
      let face=(eave,base,stripe)=>{
        X.fillStyle=base;X.beginPath();X.moveTo(Tr[0],Tr[1]);X.lineTo(eave[0],eave[1]);X.lineTo(Br[0],Br[1]);X.closePath();X.fill();
        X.fillStyle=stripe;
        for(let k of [0,2]){
          let r0=lerp(Tr,Br,k/4), r1=lerp(Tr,Br,(k+1)/4);
          X.beginPath();X.moveTo(eave[0],eave[1]);X.lineTo(r0[0],r0[1]);X.lineTo(r1[0],r1[1]);X.closePath();X.fill();
        }
        X.beginPath();X.moveTo(Tr[0],Tr[1]);X.lineTo(eave[0],eave[1]);X.lineTo(Br[0],Br[1]);X.closePath();X.stroke();
      };
      face(Lr, canvasL, tccF);   // lit front-left face
      face(Rr, canvasR, tccR);   // shaded front-right face
      X.beginPath();X.moveTo(Tr[0],Tr[1]);X.lineTo(Rr[0],Rr[1]);X.lineTo(Br[0],Br[1]);X.lineTo(Lr[0],Lr[1]);X.closePath();X.stroke();
      // valance: ONE solid team-color zigzag strip per front eave (Lr-Br
      // lit, Br-Rr shaded) — three fat teeth instead of alternating
      // micro-scallops
      let valance=(p,q,col)=>{
        X.fillStyle=col;X.lineWidth=1.1;
        X.beginPath();X.moveTo(p[0],p[1]);
        for(let k=0;k<3;k++){
          let s0=lerp(p,q,k/3), s1=lerp(p,q,(k+1)/3);
          X.lineTo((s0[0]+s1[0])/2,(s0[1]+s1[1])/2+5);
          X.lineTo(s1[0],s1[1]);
        }
        X.closePath();X.fill();X.stroke();
      };
      valance(Lr,Br,tccF);
      valance(Br,Rr,tccR);
    };

    // Parts painted back → front (in the proxy path each `only()` hits one).
    // Screen offsets here must stay in step with MARKET_PART_ANCHORS:
    // one stall per back/side corner TILE (the market's trade goods — grain,
    // gold, stone), wood pile + crate on the front corner. Corner tile
    // centers: (±64, bhh) sides, (0, bhh/3) back, (0, bhh*5/3) front.
    if(only('stall_b')) stall(sx,    sy+bhh/3,   'sacks'); // back corner: grain
    if(only('stall_l')) stall(sx-64, sy+bhh,     'gold');  // left corner: gold
    if(only('stall_r')) stall(sx+64, sy+bhh,     'stone'); // right corner: stone
    if(only('wares')){ // open-ground wares on the front corner: crate
      // tucked BEHIND the log pile (drawn first, logs lap over it)
      drawGood(sx+8, sy+bhh*1.56, 'crate');
      drawGood(sx-4, sy+bhh*1.72, 'logs');
    }
    // Only the last-sorted part (wares) falls through to the shared tail
    // (HP/progress bars), so those draw once per market, on top.
    if(part !== null && part !== 'wares'){ X.globalAlpha=1; return; }
  }
  else if(e.btype==='LCAMP'){
    bh=30;
    // Worn dirt clearing, enlarged past the tile so the oversized props
    // (log pile / ore cart) still sit on worked ground
    // drawCampClearing(sx, sy+bhh-bhh*1.45, bw*1.45, bhh*1.45, darken);
    drawCampClearing(sx, sy, bw, bhh, darken);
    
    // Small plank shack in the back-right quadrant
    drawBuildingBlock(sx+14, sy+8, 20, 10, 14, '#b89868','#987848','peaked',8,'#8a6a48','#715539', darken);
    drawDoorRight(sx+14, sy+8, 20, 10, '#5c3d24', darken);
    drawPennant(sx+14, sy-14, tc, darken);
    if(e.complete){
      let logCol=darken ? darkenColor('#6e473b') : '#6e473b';
      let logTop=darken ? darkenColor('#7d5344') : '#7d5344';
      let endCol=darken ? darkenColor('#ebd2b0') : '#ebd2b0';
      X.strokeStyle='#000000';X.lineWidth=1.2;
      // ISO log pile: logs lie along the tile's SE diagonal (screen slope
      // +0.5), cut ends facing the camera, stacked with real gravity —
      // two on the ground separated along the other diagonal, one on top.
      const UX=0.894, UY=0.447;             // SE ground direction
      const VX=-0.894, VY=0.447;            // SW ground direction
      let drawIsoLog=(cx,cy,L,r)=>{
        // body: thick round-capped stroke along the SE axis — the back
        // end is naturally rounded, the front gets the cut face
        let x1=cx-L*UX, y1=cy-L*UY, x2=cx+L*UX, y2=cy+L*UY;
        X.lineCap='round';
        X.strokeStyle='#000000';X.lineWidth=r*2+2.4;
        X.beginPath();X.moveTo(x1,y1);X.lineTo(x2,y2);X.stroke();
        X.strokeStyle=logCol;X.lineWidth=r*2;
        X.beginPath();X.moveTo(x1,y1);X.lineTo(x2,y2);X.stroke();
        X.lineCap='butt';
        // subtle lit top edge
        X.save();X.strokeStyle='rgba(255,255,255,0.25)';X.lineWidth=1;
        X.beginPath();X.moveTo(x1,y1-r+1.2);X.lineTo(x2,y2-r+1.2);X.stroke();
        X.restore();
        // near cut end facing the camera, with a growth ring
        X.strokeStyle='#000000';X.lineWidth=1.2;
        X.fillStyle=endCol;
        X.beginPath();X.ellipse(x2,y2,r*0.88,r,0,0,Math.PI*2);X.fill();X.stroke();
        X.save();X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8;
        X.beginPath();X.ellipse(x2,y2,r*0.45,r*0.52,0,0,Math.PI*2);X.stroke();X.restore();
      };
      let lx=sx-20, ly=sy+bhh*1.05;
      // painter's order: farther ground log first, nearer one over it,
      // the stacked log last (it sits on top of both)
      drawIsoLog(lx-VX*5, ly-VY*5+2, 11, 4);   // ground, farther
      drawIsoLog(lx+VX*5, ly+VY*5+2, 11, 4);   // ground, nearer
      drawIsoLog(lx, ly-4.5, 11, 4);           // stacked on top
      // Chopping stump: cylinder with a rounded base and pale cut top
      let cbx=sx+6, cby=sy+bhh*1.55;
      let stumpC=darken ? darkenColor('#8a5a3a') : '#8a5a3a';
      X.fillStyle=stumpC;X.beginPath();
      X.moveTo(cbx-5,cby-7);X.lineTo(cbx-5,cby+2);
      X.ellipse(cbx,cby+2,5,2.6,0,Math.PI,0,true);   // rounded bottom
      X.lineTo(cbx+5,cby-7);
      X.closePath();X.fill();X.stroke();
      X.fillStyle=endCol;X.beginPath();X.ellipse(cbx,cby-7,5,2.6,0,0,Math.PI*2);X.fill();X.stroke();
    }
  }
  else if(e.btype==='MCAMP'){
    bh=30;
    // Worn dirt clearing, enlarged past the tile so the oversized props
    // (log pile / ore cart) still sit on worked ground
    drawCampClearing(sx, sy, bw, bhh, darken);

    // Dark timber mine shed in the back-right quadrant
    drawBuildingBlock(sx+14, sy+8, 20, 10, 12, '#7a6a55','#635546','peaked',7,'#55483a','#463b2f', darken);
    drawDoorRight(sx+14, sy+8, 20, 10, '#2e2519', darken);
    drawPennant(sx+14, sy-10, tc, darken);
    if(e.complete){
      X.strokeStyle='#000000';X.lineWidth=1.2;
      // ISO ore cart: an open-top 3D box aligned to the tile's SE
      // diagonal, gold heaped inside, wheels on the visible flank.
      let mx=sx-18, my=sy+bhh*1.1;
      const UX=0.894, UY=0.447;   // SE (cart axis)
      const VX=-0.894, VY=0.447;  // SW (across the cart)
      const a=8, b=4.5, h=8;      // half-length, half-width, wall height
      // ground corners: A back, B right, C front(nearest), D left
      let Ax=mx-a*UX-b*VX, Ay=my-a*UY-b*VY;
      let Bx=mx+a*UX-b*VX, By=my+a*UY-b*VY;
      let Cx=mx+a*UX+b*VX, Cy=my+a*UY+b*VY;
      let Dx=mx-a*UX+b*VX, Dy=my-a*UY+b*VY;
      let wood=darken ? darkenColor('#6e5138') : '#6e5138';
      let woodL=darken ? darkenColor('#7d5f42') : '#7d5f42';
      // right-end face (B-C edge, toward the camera along the axis)
      X.fillStyle=wood;X.beginPath();
      X.moveTo(Bx,By-h);X.lineTo(Cx,Cy-h);X.lineTo(Cx,Cy);X.lineTo(Bx,By);X.closePath();X.fill();X.stroke();
      // long flank (C-D edge, the near side) with plank lines
      X.fillStyle=woodL;X.beginPath();
      X.moveTo(Cx,Cy-h);X.lineTo(Dx,Dy-h);X.lineTo(Dx,Dy);X.lineTo(Cx,Cy);X.closePath();X.fill();X.stroke();
      X.save();X.strokeStyle='rgba(0,0,0,0.3)';X.lineWidth=0.9;
      X.beginPath();X.moveTo(Cx-0.8,Cy-h*0.62);X.lineTo(Dx+0.8,Dy-h*0.62);X.stroke();
      X.beginPath();X.moveTo(Cx-0.8,Cy-h*0.3);X.lineTo(Dx+0.8,Dy-h*0.3);X.stroke();
      X.restore();
      // open top: dark interior rim, then the gold heap rising out of it
      X.fillStyle=darken ? darkenColor('#3c2d1e') : '#3c2d1e';
      X.beginPath();
      X.moveTo(Ax,Ay-h);X.lineTo(Bx,By-h);X.lineTo(Cx,Cy-h);X.lineTo(Dx,Dy-h);X.closePath();X.fill();X.stroke();
      let gcol=darken ? darkenColor('#e8b90f') : '#e8b90f';
      let gtop=darken ? darkenColor('#ffe14d') : '#ffe14d';
      [[-3,-1.5],[0,-3],[3,-1.5],[-1.5,0],[2,0.5]].forEach(([dx,dy])=>{
        let nx2=mx+dx, ny2=my-h-2+dy;
        X.fillStyle=gcol;X.beginPath();X.arc(nx2,ny2,2.6,0,Math.PI*2);X.fill();X.stroke();
        X.fillStyle=gtop;X.beginPath();X.arc(nx2-0.8,ny2-0.8,1.1,0,Math.PI*2);X.fill();
      });
      // wheels on the near flank, perpendicular to the axis (squashed)
      X.fillStyle=darken ? darkenColor('#3a2f24') : '#3a2f24';
      [[-4],[4]].forEach(([t])=>{
        let wx2=mx+t*UX+b*VX, wy2=my+t*UY+b*VY+1;
        X.beginPath();X.ellipse(wx2,wy2,2.1,2.7,0,0,Math.PI*2);X.fill();X.stroke();
        X.fillStyle='rgba(255,255,255,0.25)';
        X.beginPath();X.arc(wx2,wy2,0.7,0,Math.PI*2);X.fill();
        X.fillStyle=darken ? darkenColor('#3a2f24') : '#3a2f24';
      });
      // Faceted stone boulders beside the cart (polygonal, lit upper-left)
      let scol=darken ? darkenColor('#8b8b8b') : '#8b8b8b';
      let scol2=darken ? darkenColor('#9a9a9a') : '#9a9a9a';
      let rock=(rx,ry,r)=>{
        X.fillStyle=scol;X.beginPath();
        X.moveTo(rx-r,ry+r*0.35);X.lineTo(rx-r*0.55,ry-r*0.75);X.lineTo(rx+r*0.4,ry-r);
        X.lineTo(rx+r,ry-r*0.15);X.lineTo(rx+r*0.65,ry+r*0.8);X.lineTo(rx-r*0.35,ry+r*0.95);
        X.closePath();X.fill();X.stroke();
        X.fillStyle=scol2;X.beginPath();
        X.moveTo(rx-r*0.55,ry-r*0.75);X.lineTo(rx+r*0.4,ry-r);X.lineTo(rx+r*0.2,ry-r*0.1);X.lineTo(rx-r*0.5,ry-r*0.05);
        X.closePath();X.fill();
      };
      rock(sx+2, sy+bhh*1.5, 5.5);
      rock(sx+10, sy+bhh*1.42, 4);
    }
  }
  else if(e.btype==='MILL'){
    // Age-progressed mill body under a tall pointed cone cap:
    //  DARK    — hexagonal timber smock: three visible plank facets
    //  FEUDAL+ — round stone tower mill: curved silhouette, cylindrical
    //            shading bands, masonry courses
    bh=72;
    let by = sy + bhh;                 // tower centered on the 2x2 footprint
    // Dark's hex smock tapers hard; the stone tower keeps a gentler taper
    // so it reads as a CYLINDER with a slight batter, not a cone
    let W0=ownerAge===0 ? bw*0.52 : bw*0.46, W1=ownerAge===0 ? bw*0.27 : bw*0.36;
    let H=48, ty=by-H;
    const lerp=(a,b,t)=>a+(b-a)*t;
    const wAt=t=>lerp(W0,W1,t);        // half-width at height-fraction t (0=base,1=top)
    const yAt=t=>lerp(by,ty,t);
    const dip=t=>wAt(t)*0.40;          // how far the front of the ring bulges below the side corners
    X.lineJoin='round';
    // front surface bottom at height t — the round body's bottom curve has
    // control depth dip*2.2, so the CURVE itself sits at dip*1.1 mid-front
    let frontY=t=>yAt(t)+dip(t)*(ownerAge===0?1:1.1);

    if(ownerAge===0){
      // Hexagonal prism: side corners at ±wAt, front corners at ±0.4·wAt
      // dropped by dip() — three facets lit left→front→right per the light
      const k=0.4;
      let vx=t=>{let w=wAt(t),y=yAt(t),d=dip(t);return {
        L:{x:sx-w,y}, FL:{x:sx-w*k,y:y+d}, FR:{x:sx+w*k,y:y+d}, R:{x:sx+w,y}};};
      let b0=vx(0), b1=vx(1);
      let quad=(p1,p2,p3,p4,col)=>{
        X.fillStyle=darken?darkenColor(col):col;X.beginPath();
        X.moveTo(p1.x,p1.y);X.lineTo(p2.x,p2.y);X.lineTo(p3.x,p3.y);X.lineTo(p4.x,p4.y);
        X.closePath();X.fill();X.stroke();
      };
      X.strokeStyle='#000';X.lineWidth=1.2;
      quad(b0.L,b0.FL,b1.FL,b1.L, WOOD.plankL);
      quad(b0.FL,b0.FR,b1.FR,b1.FL, '#a8845a');
      quad(b0.FR,b0.R,b1.R,b1.FR, WOOD.plankR);
      // plank courses across all three facets
      X.save();X.strokeStyle='rgba(0,0,0,0.15)';X.lineWidth=1;
      [0.2,0.4,0.6,0.8].forEach(t=>{
        let v=vx(t);
        X.beginPath();X.moveTo(v.L.x,v.L.y);X.lineTo(v.FL.x,v.FL.y);
        X.lineTo(v.FR.x,v.FR.y);X.lineTo(v.R.x,v.R.y);X.stroke();
      });
      X.restore();
    } else {
      // Round tower: one silhouette with curved bottom/top rings, shaded
      // as a cylinder — lit band on the left rolling to shadow on the
      // right (flat bands, keeping the game's flat-color language)
      // five shading steps rolling light→dark across the curve — more
      // subdivisions sell the roundness
      let shades=['#ded7c5','#cfc8b6','#b7ad97','#a49a84','#8f8672'];
      if(darken) shades=shades.map(darkenColor);
      let path=()=>{
        X.beginPath();
        X.moveTo(sx-W0,by);
        X.quadraticCurveTo(sx,by+dip(0)*2.2,sx+W0,by);
        X.lineTo(sx+W1,ty);
        X.quadraticCurveTo(sx,ty+dip(1)*2.2,sx-W1,ty);
        X.closePath();
      };
      X.save(); path(); X.clip();
      X.fillStyle=shades[0]; X.fillRect(sx-W0-2,ty-dip(1)*2-2,W0*4,H+dip(0)*4+4);
      // band boundaries taper with the body so the shading follows the form
      let band=(f,col)=>{
        X.fillStyle=col;X.beginPath();
        X.moveTo(sx+f*W0,frontY(0)+2);X.lineTo(sx+f*W1,frontY(1)-8);
        X.lineTo(sx+W0*2,ty-20);X.lineTo(sx+W0*2,by+30);X.closePath();X.fill();
      };
      [-0.42,-0.05,0.34,0.66].forEach((f,i)=>band(f,shades[i+1]));
      // masonry courses: curved rings + staggered joints
      X.strokeStyle='rgba(0,0,0,0.13)';X.lineWidth=1;
      [0.18,0.36,0.54,0.72,0.9].forEach((t,ci)=>{
        let w=wAt(t), y=yAt(t);
        X.beginPath();X.moveTo(sx-w,y);
        X.quadraticCurveTo(sx,y+dip(t)*2.2,sx+w,y);X.stroke();
        let joints = ci%2 ? [-0.55,-0.1,0.35] : [-0.35,0.1,0.55];
        joints.forEach(f=>{
          let jx=sx+f*w, jy=y+dip(t)*2.2*(1-(f*f))*0.5; // approx on the ring curve
          X.beginPath();X.moveTo(jx,jy);X.lineTo(jx,jy-3);X.stroke();
        });
      });
      X.restore();
      X.strokeStyle='#000';X.lineWidth=1.2; path(); X.stroke();
    }

    // Door at the front center of the base, leaning with the taper
    let doorC=darken?darkenColor('#3a2612'):'#3a2612';
    let dhw0=4.5, dhw1=4.5*wAt(13/H)/wAt(0);
    let dy0=frontY(0)-0.5;
    X.fillStyle=doorC;X.strokeStyle='#000';X.lineWidth=1;
    X.beginPath();
    X.moveTo(sx-dhw0,dy0);X.lineTo(sx+dhw0,dy0);
    X.lineTo(sx+dhw1,frontY(13/H));X.lineTo(sx-dhw1,frontY(13/H));X.closePath();
    X.fill();X.stroke();

    // ---- Tall pointed cone cap (wood, both ages) ----
    // Two-tone halves filled WITHOUT strokes, then one silhouette stroke —
    // no center seam line splitting the cone.
    let capH=22;
    let cl=darken?darkenColor(WOOD.L):WOOD.L, cr=darken?darkenColor(WOOD.R):WOOD.R;
    let capBaseY=frontY(1);
    X.fillStyle=cl;X.beginPath();
    X.moveTo(sx,ty-capH);X.lineTo(sx-W1-1,ty);
    X.quadraticCurveTo(sx-W1*0.4,capBaseY+1,sx,capBaseY+1);X.closePath();X.fill();
    X.fillStyle=cr;X.beginPath();
    X.moveTo(sx,ty-capH);X.lineTo(sx+W1+1,ty);
    X.quadraticCurveTo(sx+W1*0.4,capBaseY+1,sx,capBaseY+1);X.closePath();X.fill();
    X.strokeStyle='#000';X.lineWidth=1.2;
    X.beginPath();
    X.moveTo(sx,ty-capH);X.lineTo(sx-W1-1,ty);
    X.quadraticCurveTo(sx-W1*0.4,capBaseY+1,sx,capBaseY+1);
    X.quadraticCurveTo(sx+W1*0.4,capBaseY+1,sx+W1+1,ty);
    X.closePath();X.stroke();

    if(e.complete && visible){
      // Front-mounted fan, hub centered on the cap. Sails alternate
      // white canvas / team color so ownership reads while the fan still
      // looks like cloth.
      let hubY=ty+W1*0.55; // at the cap's base edge, where a real windshaft exits
      drawWindmillSails(sx, hubY, e.id, 1.75, '#f0ead8', darken?darkenColor(tc):tc);
    }
  }
  else if(e.btype==='TOWER'){
    bh=36;
    let linkY = sy + 16;
    let wallH = 14;

    // Watch Tower — 3 stacked blocks. Base is shifted so its
    // front-bottom vertex lands on linkY (sy+16), same as wall pillars,
    // so the wall link's near edge meets the tower with no gap. Drawn
    // before the links (like WALL's pillar) since the links extend
    // toward the viewer and should overlap the tower's base, not be
    // hidden behind it.
    // Age look (tower unlocks at Feudal): FEUDAL keeps the peaked
    // team-color cap; CASTLE swaps it for a crenellated flat top —
    // same wood→stone→merlons progression as the TC and barracks tower.
    // The tower IS a gate bastion, just taller — same 14x7 footprint,
    // same stone-wall palette (GATE/WALL pf stone), same merlon cap —
    // so a tower embedded in a wall run reads as kin to the gate posts.
    // Feudal wears a peaked team-color roof; Castle swaps it for merlons.
    let pfS = ['#cfc8b6', '#aca392', '#b7ad97'];
    let towerH = 40; // gate posts use pillarH 22
    // topLight at every age: the crown's front rim edges take the light
    // seam stroke — a hard black diamond outline showed as a dark ring
    // around the base of the Feudal peaked cap (which is 12 wide vs 14).
    drawBuildingBlock(sx, linkY-7, 14, 7, towerH, pfS[0], pfS[1], 'flat', 0, pfS[2], pfS[2], darken, true);
    // arrow slits on BOTH visible faces — arrows can come from either side
    X.fillStyle = '#1c1c1c';
    X.save(); X.translate(sx-7, sy-4); X.transform(1,0.5,0,1,0,0);
    X.fillRect(-1.2,-6,2.4,10); X.restore();
    X.save(); X.translate(sx+7, sy-4); X.transform(1,-0.5,0,1,0,0);
    X.fillRect(-1.2,-6,2.4,10); X.restore();
    if (ownerAge >= 2) {
      // +28 (not the gate's +22): seats the side merlons' bases ON the
      // crown's top face — at the gate's height the small float is masked
      // by the door behind, here it read as merlons hovering in air
      drawBastionMerlons(sx, linkY - towerH + 28, '#e0d8c6', '#c4bba6', darken);
    } else {
      drawBuildingBlock(sx, linkY - towerH - 6, 12, 6, 4, pfS[0], pfS[1], 'peaked', 8, tc, tcD, darken);
    }

    // South and East links can both originate from this same corner
    // point, same as GATE's front post (which also has two links
    // diverging from one vertex) — use d1=8 there too so the two stubs
    // clear each other instead of clipping at the shared vertex.
    // South neighbor (y+1) — towers join runs of EITHER material; the link
    // stub takes the neighbor's material so it reads as that run continuing.
    let sN = getConnectedBuilding(e.x, e.y + 1);
    if (isWallLike(sN)) {
      let m2 = wallMat(sN.btype) || 'wood', lt2 = m2==='stone'?4:3.5;
      drawWallLink(sx, linkY, -32, 16, wallH, darken, 8, m2==='stone'?5:lt2*Math.sqrt(5)/2, null, tc, lt2, false, m2);
    }

    // East neighbor (x+1)
    let eN = getConnectedBuilding(e.x + 1, e.y);
    if (isWallLike(eN)) {
      let m3 = wallMat(eN.btype) || 'wood', lt3 = m3==='stone'?4:3.5;
      drawWallLink(sx, linkY, 32, 16, wallH, darken, 8, m3==='stone'?5:lt3*Math.sqrt(5)/2, null, tc, lt3, false, m3);
    }

    // Castle: pole planted on the back merlon's cap (sy-40), matching the
    // TC. Feudal: pole rises from the peaked cap's apex (sy-42).
    if (e.complete && visible) drawWavingFlag(sx, sy, ownerAge >= 2 ? 32 : 40, tc, tcD);
  }
  else if(e.btype==='PTOWER'){
    bh=30;
    let linkY = sy + 16;
    let wallH = 14;

    // Palisade Watch Tower — the TOWER's dark-age wooden kin: same base
    // geometry (front-bottom vertex on linkY so wall links meet with no
    // gap) but a shorter shaft in structural-timber browns, and it always
    // wears the peaked team-color cap — no stone-merlon age progression,
    // since upgrading swaps the btype to TOWER outright (execUpgradeWalls).
    let pfS = [WOOD.L, WOOD.R, WOOD.top];
    let towerH = 32;
    drawBuildingBlock(sx, linkY-7, 14, 7, towerH, pfS[0], pfS[1], 'flat', 0, pfS[2], pfS[2], darken, true);
    // arrow slits on BOTH visible faces — arrows can come from either side
    X.fillStyle = '#1c1c1c';
    X.save(); X.translate(sx-7, sy-2); X.transform(1,0.5,0,1,0,0);
    X.fillRect(-1.2,-5,2.4,8); X.restore();
    X.save(); X.translate(sx+7, sy-2); X.transform(1,-0.5,0,1,0,0);
    X.fillRect(-1.2,-5,2.4,8); X.restore();
    drawBuildingBlock(sx, linkY - towerH - 6, 12, 6, 4, pfS[0], pfS[1], 'peaked', 8, tc, tcD, darken);

    // Wall links: same both-material stubs as TOWER (see its comment).
    let sN = getConnectedBuilding(e.x, e.y + 1);
    if (isWallLike(sN)) {
      let m2 = wallMat(sN.btype) || 'wood', lt2 = m2==='stone'?4:3.5;
      drawWallLink(sx, linkY, -32, 16, wallH, darken, 8, m2==='stone'?5:lt2*Math.sqrt(5)/2, null, tc, lt2, false, m2);
    }
    let eN = getConnectedBuilding(e.x + 1, e.y);
    if (isWallLike(eN)) {
      let m3 = wallMat(eN.btype) || 'wood', lt3 = m3==='stone'?4:3.5;
      drawWallLink(sx, linkY, 32, 16, wallH, darken, 8, m3==='stone'?5:lt3*Math.sqrt(5)/2, null, tc, lt3, false, m3);
    }

    if (e.complete && visible) drawWavingFlag(sx, sy, 32, tc, tcD);
  }
  else if(isWallBtype(e.btype)){
    bh=14;
    let pillarH = 22;
    let wallH = 14;   // lower than pillar to create bastion crenellated effect
    let linkY = sy + 16;
    // Material palette: palisade wood vs stone greys. Links join ANY
    // wall-like neighbor — each tile draws its own S/E slab in its OWN
    // material, so a mixed run (partially upgraded to stone) reads as one
    // continuous line with wood-meets-stone junctions at the pillars.
    let mat = wallMat(e.btype);
    let pf = mat === 'stone' ? ['#cfc8b6', '#aca392', '#b7ad97'] : [WOOD.L, WOOD.R, WOOD.top];

    // 1. Draw central pillar first (centered concentrically at sy+16) —
    // links draw AFTER so the walkway visibly connects between the
    // mini towers instead of being swallowed by them.
    // Colors match drawWallLink's palette so the pillar reads as part of
    // the same wall run instead of a separately-shaded block. Pillar caps
    // and walkway link tops are all team-colored (ownership read) — the
    // cap as a SINGLE flat color, like the links' flat tops.
    // The Dark-age palisade is SKINNIER than the stone wall (7px posts vs
    // 9px pillars); the link geometry below scales with it so the
    // edge-coincidence math still holds (thick = pillar half-width/2,
    // d1 = thick*sqrt(5)/2 * 2 = thick/cos, bottom vertex kept at sy+20).
    let isWood = mat !== 'stone';
    let pw = isWood ? 7 : 9;
    let lthick = pw / 2;
    drawBuildingBlock(sx, sy+20-pw, pw, pw/2, pillarH, pf[0], pf[1], 'flat', 0, tc, tc, darken);

    // 2. Draw South and East links second (running towards the front, overlapping the pillar)
    // Slab half-thickness = pillar half-width/... matches the pillar's
    // cross-section exactly; d1 centers it so the near-end edge lands on
    // the pillar's FRONT vertical edge and the back top corner on its
    // BACK vertical edge — outlines coincide instead of doubling.
    // (linkY - 0.5: the slab's bottom front corner otherwise lands just
    // below the pillar's bottom vertex)
    let d1 = lthick * Math.sqrt(5) / 2;
    // South neighbor (y+1)
    if (isWallLike(getConnectedBuilding(e.x, e.y + 1))) {
      drawWallLink(sx, linkY - 0.5, -32, 16, wallH, darken, d1, d1, null, tc, lthick, false, mat);
    }

    // East neighbor (x+1)
    if (isWallLike(getConnectedBuilding(e.x + 1, e.y))) {
      drawWallLink(sx, linkY - 0.5, 32, 16, wallH, darken, d1, d1, null, tc, lthick, false, mat);
    }
  }

  else if(isGateBtype(e.btype)){
    let mat = wallMat(e.btype);
    let pf = mat === 'stone' ? ['#c8c0ae', '#a89f8d', '#b0b0a4'] : [WOOD.L, WOOD.R, WOOD.top];
    // Link stubs must match the wall runs they join: the palisade is
    // skinnier (3.5 half-thickness) than stone (4.5), and the far-end
    // trim is the matching pillar-face distance so no gap opens.
    let lth = mat === 'stone' ? 4 : 3.5;
    let dEnd = mat === 'stone' ? 5 : lth * Math.sqrt(5) / 2;
    let pillarH = 28;
    bh = pillarH;
    let t1sx, t1sy, t2sx, t2sy;
    let wallLineNS = e.h > e.w;
    // Gate length in tiles (2 or 3). The two bastion posts sit at the two
    // ENDS of the run and the sliding door spans between them, so the far
    // post is (n-1) tile-steps from the near one. One +x tile step is
    // (+32,+16) on screen; one +y step is (-32,+16).
    let n = Math.max(e.w, e.h);
    if (wallLineNS) {
      // N-S Gate (footprint 1xN) - NE-SW direction
      t1sx = sx;                 t1sy = sy + 16;
      t2sx = sx - 32 * (n - 1);  t2sy = sy + 16 + 16 * (n - 1);
    } else {
      // E-W Gate (footprint Nx1) - NW-SE direction
      t1sx = sx;                 t1sy = sy + 16;
      t2sx = sx + 32 * (n - 1);  t2sy = sy + 16 + 16 * (n - 1);
    }

    let dx = t2sx - t1sx, dy = t2sy - t1sy;
    let gp = visible ? (e.gateProgress || 0) : 0; // frozen closed in shroud
    let slideY = gp * 26;

    if (part === 'back' || part === null) {
      // 1. Draw back post (Tower 1 - larger bastion centered at t1sy-7)
      // Pre-Castle the post top is team-colored like the wall walkways
      // (single flat color); at Castle the merlons take over the cap.
      let postTop = ownerAge >= 2 ? pf[2] : tc;
      drawBuildingBlock(t1sx, t1sy - 7, 14, 7, pillarH, pf[0], pf[1], 'flat', 0, postTop, postTop, darken, mat === 'stone' && ownerAge >= 2);

      // Battlements only on the STONE gate — a timber palisade gate has
      // plain post tops; the merlons are part of the Feudal upgrade look.
      if (mat === 'stone' && ownerAge >= 2) drawBastionMerlons(t1sx, t1sy, '#e0d8c6', '#c4bba6', darken);

      if (e.complete) {
        // Sliding solid wood gate door — same style/placement as a wall
        // extension (drawWallLink), just wood-brown and sliding up into
        // the bastion as gateProgress goes from closed (0) to open (1).
        // Symmetric trims (7,7) center the door between the two posts —
        // the old (7,0) ran it all the way into the front post's center,
        // so the raised door hung visibly closer to the front tower.
        // The slab stays exactly PARALLEL to the wall run (any per-end
        // twist read as the whole gate being rotated) and is instead
        // TRANSLATED in the GROUND PLANE. The ground-plane perpendicular
        // in iso is the run direction mirrored, (ux, -uy) — using a
        // screen-space perpendicular here made the door dip below the
        // ground line (it is mostly vertical).
        {
          let Lg = Math.hypot(dx, dy), ux = dx / Lg, uy = dy / Lg;
          const GT = 1; // ground-plane shift away from the viewer, in px
          drawWallLink(t1sx + ux * GT, t1sy - slideY - uy * GT, dx, dy,
                       16, darken, 9, 9, '#8b5a2b', '#a5723a', 2, true);
        }
      }

      // 1. Draw connection links for Post 1 (back post centered at t1sy)
      let wallH = 14;
      if (wallLineNS) {
        // N-S Gate: Post 1 is at (e.x, e.y). Perpendicular connection goes East (x+1).
        if (isWallLike(getConnectedBuilding(e.x + 1, e.y))) {
          drawWallLink(t1sx, t1sy, 32, 16, wallH, darken, 5, dEnd, null, tc, lth, false, mat);
        }
      } else {
        // E-W Gate: Post 1 is at (e.x, e.y). Perpendicular connection goes South (y+1).
        if (isWallLike(getConnectedBuilding(e.x, e.y + 1))) {
          drawWallLink(t1sx, t1sy, -32, 16, wallH, darken, 5, dEnd, null, tc, lth, false, mat);
        }
      }

      if (part === 'back') {
        X.globalAlpha = 1;
        return;
      }
    }

    if (part === 'front' || part === null) {
      // 2. Draw front post (Tower 2 - larger bastion centered at t2sy-7)
      let postTop2 = ownerAge >= 2 ? pf[2] : tc;
      drawBuildingBlock(t2sx, t2sy - 7, 14, 7, pillarH, pf[0], pf[1], 'flat', 0, postTop2, postTop2, darken, mat === 'stone' && ownerAge >= 2);

      // Battlements only on the STONE gate (see back post above).
      if (mat === 'stone' && ownerAge >= 2) drawBastionMerlons(t2sx, t2sy, '#e0d8c6', '#c4bba6', darken);

      // Draw connection links for Post 2 (front post centered at t2sy)
      let wallH = 14;
      if (wallLineNS) {
        // N-S Gate: Post 2 is the far post at (e.x, e.y+n-1). Parallel goes
        // South (y+n), Perpendicular goes East (x+1, y+n-1).
        if (isWallLike(getConnectedBuilding(e.x, e.y + n))) {
          drawWallLink(t2sx, t2sy, -32, 16, wallH, darken, 8, dEnd, null, tc, lth, false, mat);
        }
        if (isWallLike(getConnectedBuilding(e.x + 1, e.y + n - 1))) {
          drawWallLink(t2sx, t2sy, 32, 16, wallH, darken, 8, dEnd, null, tc, lth, false, mat);
        }
      } else {
        // E-W Gate: Post 2 is the far post at (e.x+n-1, e.y). Parallel goes
        // East (x+n, y), Perpendicular goes South (x+n-1, y+1).
        if (isWallLike(getConnectedBuilding(e.x + n, e.y))) {
          drawWallLink(t2sx, t2sy, 32, 16, wallH, darken, 8, dEnd, null, tc, lth, false, mat);
        }
        if (isWallLike(getConnectedBuilding(e.x + n - 1, e.y + 1))) {
          drawWallLink(t2sx, t2sy, -32, 16, wallH, darken, 8, dEnd, null, tc, lth, false, mat);
        }
      }
      // Locked-gate indicator: a small padlock floating over the sealed door,
      // so a locked gate reads differently from one that's merely swung shut.
      // Only when in view (never leak a lock state through the shroud).
      if (e.locked && visible) {
        let mx = (t1sx + t2sx) / 2, my = (t1sy + t2sy) / 2 - 22;
        X.save();
        X.lineWidth = 1.3; X.strokeStyle = '#2a2a2a';
        X.beginPath(); X.arc(mx, my - 3, 4, Math.PI, 0); X.stroke(); // shackle
        X.fillStyle = '#e8c84a';
        X.beginPath(); X.rect(mx - 5, my - 2, 10, 9); X.fill(); X.stroke(); // body
        X.fillStyle = '#2a2a2a';
        X.fillRect(mx - 0.9, my + 1.5, 1.8, 3.6); // keyhole
        X.restore();
      }
    }
  }
  else if(e.btype==='FARM'){
    bh=0;
    // AoE2-style FLAT farm: bed, furrows and wheat all draw in one pass in
    // the ground layer (render.js emits a single ground-layer proxy far
    // below the depth contest), so units and buildings always draw over
    // the field. part is 'ground' (in-game) or null (gallery/ghost/mask) —
    // both mean "draw everything".
    let tileRes=map[e.y]&&map[e.y][e.x]?map[e.y][e.x].res:0;
    let growth=tileRes/(e.maxFood||300);
    // Ground-level footprint corners and the raised bed (tilled soil sits
    // a few px proud of the grass, with visible dirt sides on the two
    // camera-facing edges — that lift is what makes the field read 3D).
    const bedH=2.5;
    let cT={x:sx,y:sy}, cR={x:sx+bw,y:sy+bhh}, cB={x:sx,y:sy+bhh*2}, cL={x:sx-bw,y:sy+bhh};
    let up=c=>({x:c.x,y:c.y-bedH});
    let rT=up(cT), rR=up(cR), rB=up(cB), rL=up(cL);
    // exhausted soil is paler and greyer — worked-out dirt
    let dead=e.exhausted;
    let soil    = dead ? '#7d6a52' : '#7a5a38';
    let ridgeDk = dead ? '#6f5d47' : '#6b4d2e'; // furrow strip
    let sideSW  = dead ? '#5f5040' : '#5e4527'; // bed side, SW-facing (lit side)
    let sideSE  = dead ? '#4f4234' : '#4b371f'; // bed side, SE-facing (shaded)
    if(darken){ soil=darkenColor(soil); ridgeDk=darkenColor(ridgeDk); sideSW=darkenColor(sideSW); sideSE=darkenColor(sideSE); }
    // Furrow/crop-row geometry
    let rowEnds=t=>[
      {x:rT.x+(rL.x-rT.x)*t, y:rT.y+(rL.y-rT.y)*t},
      {x:rR.x+(rB.x-rR.x)*t, y:rR.y+(rB.y-rR.y)*t}
    ];
    X.lineWidth=1.2;X.lineJoin='round';X.strokeStyle='#000';
    // bed side faces (front-left and front-right edges, extruded to ground)
    X.fillStyle=sideSW;X.beginPath();
    X.moveTo(rL.x,rL.y);X.lineTo(rB.x,rB.y);X.lineTo(cB.x,cB.y);X.lineTo(cL.x,cL.y);X.closePath();X.fill();X.stroke();
    X.fillStyle=sideSE;X.beginPath();
    X.moveTo(rB.x,rB.y);X.lineTo(rR.x,rR.y);X.lineTo(cR.x,cR.y);X.lineTo(cB.x,cB.y);X.closePath();X.fill();X.stroke();
    // bed top
    X.fillStyle=soil;X.beginPath();
    X.moveTo(rT.x,rT.y);X.lineTo(rR.x,rR.y);X.lineTo(rB.x,rB.y);X.lineTo(rL.x,rL.y);X.closePath();X.fill();
    X.strokeStyle='rgba(0,0,0,0.35)';X.stroke();
    // Furrows, cartoon-flat: the soil top IS the lit surface; one bold
    // dark strip under each crop row suggests the ploughing — no per-ridge
    // lit/trough shading (that read as botanical realism and dissolved
    // into noise zoomed out).
    for(const t of FARM_CROP_ROWS){
      let [a0,b0]=rowEnds(t+0.02), [a1,b1]=rowEnds(t+0.07);
      X.fillStyle=ridgeDk;X.beginPath();
      X.moveTo(a0.x,a0.y);X.lineTo(b0.x,b0.y);X.lineTo(b1.x,b1.y);X.lineTo(a1.x,a1.y);X.closePath();X.fill();
    }
    let rows=FARM_CROP_ROWS;
    const COLS=FARM_CROP_COLS;
    // Sheaf base position, shared by the crop and stubble passes so the
    // harvested field lines up with where the wheat stood.
    let tuftAt=(t,ri,i)=>{
      let [a,b2]=rowEnds(t);
      let u=farmSheafU(ri,i);
      return {x:a.x+(b2.x-a.x)*u, y:a.y+(b2.y-a.y)*u};
    };
    if(growth>0 && !dead){
      // Wheat as mini SHEAVES — the same read as the gathering villager's
      // shoulder sheaf (js/render-units.js foodSrc==='wheat'): a few thick
      // splayed stalks, each tipped with a fat outlined grain head once
      // grown. 5 rows × 6 columns so the field feels FULL. Drawn flat in
      // the ground layer: the crop is short, and units always walk OVER
      // the field, AoE2-style.
      let sheafH=2.5+growth*5;
      let splay=1.6+growth*1.4;
      let ripe=growth>0.55;
      let stalkCol = ripe ? '#c9a227' : '#6fa03a';
      let headCol  = ripe ? '#e8c84a' : '#8fbf55';
      if(darken){ stalkCol=darkenColor(stalkCol); headCol=darkenColor(headCol); }
      rows.forEach((t,ri)=>{
        for(let i=0;i<COLS;i++){
          let p=tuftAt(t,ri,i);
          let lean=(((i*7+ri*13)%5)-2)*0.55; // deterministic per-sheaf lean
          // three splayed stalks from one base
          X.strokeStyle=stalkCol;X.lineWidth=1.4;X.lineCap='round';
          for(let k=-1;k<=1;k++){
            X.beginPath();X.moveTo(p.x,p.y);
            X.lineTo(p.x+k*splay+lean, p.y-sheafH*(k===0?1:0.78));X.stroke();
          }
          X.lineCap='butt';
          // fat grain head on each stalk tip once the crop has headed out
          if(growth>0.3){
            X.fillStyle=headCol;X.strokeStyle='#000';X.lineWidth=0.8;
            for(let k=-1;k<=1;k++){
              let hx=p.x+k*splay+lean, hy=p.y-sheafH*(k===0?1:0.78);
              X.beginPath();X.ellipse(hx,hy-0.8,1.05,1.9,k*0.18+lean*0.1,0,Math.PI*2);X.fill();X.stroke();
            }
          }
        }
      });
      X.lineWidth=1.1;
    } else {
      // Harvested/exhausted: one stubble stump where each tuft stood plus
      // a single fallen straw.
      let stub = darken ? darkenColor('#9a7f4a') : '#9a7f4a';
      X.strokeStyle=stub;X.lineWidth=1.6;
      rows.forEach((t,ri)=>{
        for(let i=0;i<COLS;i++){
          let p=tuftAt(t,ri,i);
          X.beginPath();X.moveTo(p.x,p.y);X.lineTo(p.x-0.5,p.y-2.5);X.stroke();
        }
      });
      let s=tuftAt(rows[1],1,0);
      X.beginPath();X.moveTo(s.x+2,s.y+2);X.lineTo(s.x+7.5,s.y+3.5);X.stroke();
    }
    // (No corner fence posts — the raised bed alone frames the field.)
  }

  X.globalAlpha=1;

  // Progress bars, HP, selection — only when actively visible (not in fog)
  if (!window._ghostDraw && (f === 2 || e.team === myTeam)) {
  // ONE bar per building: HP grows with construction (AoE2, logic.js), so
  // the HP bar doubles as the progress bar while incomplete — cyan fill to
  // read as "under construction" (the low fill would otherwise look like
  // damage), and damage taken mid-build shows as the fill lagging the
  // scaffold. Green/red is reserved for a completed, damaged building.
  if(e.hp<e.maxHp&&bh>0){
    let bww=b.w*24;
    let hpY=sy-bh-11;
    X.fillStyle='#000000';X.fillRect(sx-bww/2-1,hpY,bww+2,6); // black border box
    X.fillStyle=!e.complete?'#012c33':'#300';X.fillRect(sx-bww/2,hpY+1,bww,4);
    X.fillStyle=!e.complete?'#00ffff':(e.hp/e.maxHp>0.5?'#0c0':'#c00');
    X.fillRect(sx-bww/2,hpY+1,bww*e.hp/e.maxHp,4);
  }
  // Garrison count — just the number, planted beside this building's own
  // team flag (only the TC and towers can ever hold a garrison, and all
  // fly their flag at the very top of the structure using this same sx/sy).
  if(e.team===myTeam&&e.garrison&&e.garrison.length>0){
    let flagX=sx, flagY;
    if(e.btype==='TC') flagY=sy-bh-28; // tracks the (age/size-scaled) keep top; sy-88 at 3x3
    else if(e.btype==='TOWER') flagY=sy-54;
    else if(e.btype==='PTOWER') flagY=sy-46;
    else flagY=sy-bh-11; // fallback, shouldn't normally trigger
    let label=String(e.garrison.length);
    X.font='bold 12px sans-serif';X.textAlign='left';
    let tw2=X.measureText(label).width+9;
    X.fillStyle='rgba(0,0,0,0.6)';
    X.fillRect(flagX+3,flagY-9,tw2,15);
    X.fillStyle='#ffd700';
    X.fillText(label,flagX+7,flagY+2);
    X.textAlign='left';
  }
  // Train / research progress — stacked with the HP bar ABOVE the roof
  // (they used to hang below the footprint, eating map space under every
  // producing building). When the HP bar is showing (hp<max), the progress
  // bar tucks in just beneath it; otherwise it takes the HP bar's spot.
  let progY = (e.hp < e.maxHp && bh > 0) ? sy - bh - 4 : sy - bh - 11;
  if(e.queue&&e.queue.length>0){
    let pct=e.trainTick/(UNITS[e.queue[0]].trainTime);
    let bww=b.w*24;
    X.fillStyle='#000000';X.fillRect(sx-bww/2-1,progY,bww+2,5); // black border box
    X.fillStyle='#003';X.fillRect(sx-bww/2,progY+1,bww,3);
    X.fillStyle='#0af';X.fillRect(sx-bww/2,progY+1,bww*pct,3);
  }
  // Age research — same bar, gold fill, updates every frame (smooth,
  // unlike the throttled panel text).
  if(e.research){
    let pct=e.research.tick/AGES[e.research.target].researchTicks;
    let bww=b.w*24;
    X.fillStyle='#000000';X.fillRect(sx-bww/2-1,progY,bww+2,5);
    X.fillStyle='#330';X.fillRect(sx-bww/2,progY+1,bww,3);
    X.fillStyle='#fc0';X.fillRect(sx-bww/2,progY+1,bww*pct,3);
  }
  } // end fog-aware UI
}



