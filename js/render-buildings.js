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
function drawWavingFlag(sx,sy,bh,color,colorDark,poleLen=22){
  // Pole base sits at sy-bh-2; poleLen lets tall buildings (TC) plant the
  // base on an actual surface and still fly the flag clear of the roofline.
  let top=sy-bh-2-poleLen;
  X.strokeStyle='#000000';X.lineWidth=1.5;
  X.beginPath();X.moveTo(sx,sy-bh-2);X.lineTo(sx,top);X.stroke(); // pole
  let wave=Math.sin(tick*0.1)*3;
  X.fillStyle=color;X.beginPath();
  X.moveTo(sx,top);X.lineTo(sx-16,top+4+wave);
  X.lineTo(sx-16,top+12+wave);X.lineTo(sx,top+8);X.closePath();
  X.fill();X.stroke();
}

// Timber building under a gable roof: the ridge runs back-left to
// front-right, showing one roof slope to the camera and a triangular
// gable end above the front-right wall. Overhangs are pure translations
// along the ridge / down-slope directions so all edges stay iso-parallel.
// Returns key anchor points so callers can place props.
// One open-sided tent-annex roof for the TC courtyard: two identical
// quad faces meeting at an apex line (left face toward ax-48, right toward
// ax+48). The TC draws this twice, at the left and right quadrant.
function drawTCAnnexRoof(ax, ay, colL, colR){
  const h = 16, roofH = 12;
  X.strokeStyle='#000000';X.lineWidth=1.3; X.lineJoin='round';
  X.fillStyle=colL;X.beginPath();
  X.moveTo(ax,ay-h-roofH); X.lineTo(ax,ay+24*2-h-roofH);
  X.lineTo(ax,ay+24*2-h); X.lineTo(ax-48,ay+24-h); X.closePath(); X.fill(); X.stroke();
  X.fillStyle=colR;X.beginPath();
  X.moveTo(ax,ay-h-roofH); X.lineTo(ax,ay+24*2-h-roofH);
  X.lineTo(ax,ay+24*2-h); X.lineTo(ax+48,ay+24-h); X.closePath(); X.fill(); X.stroke();
}

function drawGableBlock(sx, sy0, W, hh, wallH, roofH, wallL, wallR, roofC, beamC, darken, afterWalls){
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
function drawWindmillSails(hx,hy,id,scale=1){
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

    let L = 27*scale; // Spar length (increased from 14 for massive drama!)
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
    let x1 = hx + dx * 5*scale;
    let y1 = hy + dy * 5*scale;
    let x2 = tx;
    let y2 = ty;
    let x3 = tx + px * 8*scale;
    let y3 = ty + py * 8*scale;
    let x4 = x1 + px * 6*scale;
    let y4 = y1 + py * 6*scale;

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
  X.beginPath();X.arc(hx,hy,3.5*scale,0,Math.PI*2);X.fill();
  X.strokeStyle='#000000';X.lineWidth=1;X.stroke();
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
// 'wood' (palisade), 'stone', or null (TOWER — connects to both).
function wallMat(bt){
  if (bt === 'WALL' || bt === 'GATE') return 'wood';
  if (bt === 'SWALL' || bt === 'SGATE') return 'stone';
  return null;
}
// mat: restrict to one material family (towers always connect). Omitted =>
// any wall-like neighbor.
function isWallLike(b, mat){
  if (!b) return false;
  if (b.btype === 'TOWER') return true;
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
  let b = BLDGS[e.btype];
  let iso = toIso(e.x + b.w/2, e.y + b.h/2);
  let sx = Math.round(iso.ix - camX + W/2), sy = Math.round(iso.iy - camY + topH + H/2);
  if (isOffscreen(sx, sy, 100)) return;
  let bw = b.w * HALF_TW, bhh = b.h * HALF_TH;
  let g = 1.06, ox = 3, oy = 1.5;
  X.moveTo(sx + ox, sy - bhh * g + oy);
  X.lineTo(sx + bw * g + ox, sy + oy);
  X.lineTo(sx + ox, sy + bhh * g + oy);
  X.lineTo(sx - bw * g + ox, sy + oy);
  X.closePath();
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
      let inset = 32 / 48, depth = 5;
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

    // Merlons are the same masonry as the keep, lit the same way — the
    // keep's face palette (bright cap kT, walls kL/kR) via the shared
    // merlon block (light bottom seam so they connect to the rim).
    let drawMerlon = (mx, my) => drawMerlonBlock(mx, my - 4, 8, 4, 10, kL, kR, kT, kT, darken);

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
      X.save(); X.translate(wx2, wy2); X.scale(1.3, 1.3); X.translate(-wx2, -wy2);
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
    let posts = [
      { x: sx - 96, y: sy + 48, h: 16 }, // Left-most
      { x: sx - 48, y: sy + 72, h: 16 }, // Bottom-left
      { x: sx + 96, y: sy + 48, h: 16 }, // Right-most
      { x: sx + 48, y: sy + 72, h: 16 }, // Bottom-right
      { x: sx,      y: sy + 48, h: 16 }  // Center
    ];
    posts.sort((a, b) => a.y - b.y);
    let postColor = WOOD.post;
    let pc = darken ? darkenColor(postColor) : postColor;
    X.lineJoin = 'round';
    // Contact shadows on the ground first, so every pole overlaps them
    X.fillStyle = 'rgba(0,0,0,0.25)';
    posts.forEach(p => {
      X.beginPath(); X.ellipse(p.x, p.y + 1, 5, 2.4, 0, 0, Math.PI*2); X.fill();
    });
    // Chunky outlined poles: black underlay stroke, wood-colored core
    posts.forEach(p => {
      X.strokeStyle = '#000000'; X.lineWidth = 6; X.lineCap = 'round';
      X.beginPath(); X.moveTo(p.x, p.y); X.lineTo(p.x, p.y - p.h); X.stroke();
      X.strokeStyle = pc; X.lineWidth = 4;
      X.beginPath(); X.moveTo(p.x, p.y); X.lineTo(p.x, p.y - p.h); X.stroke();
      X.lineCap = 'butt';
    });

    // 3+4. Annex roofs (open-sided shelter roofs over the left and right
    // courtyard quadrants, in team color) — the two are the identical shape
    // mirored about the keep, so one helper drawn at ±48.
    let annexL = darken ? darkenColor(tc) : tc;
    let annexR = darken ? darkenColor(tcD) : tcD;
    drawTCAnnexRoof(sx - 48, sy + 24, annexL, annexR);
    drawTCAnnexRoof(sx + 48, sy + 24, annexL, annexR);

    // Team banner flying from the keep top
    // 68 plants the pole base exactly on the top merlon's cap (sy-70)
    // Every age flies the banner (only merlons are Castle-gated). Pole is
    // PLANTED on the recessed roof floor (sy-31) and long enough to fly
    // the flag clear above the rim.
    // At Castle the pole moves up onto the back merlon's cap (sy-70);
    // earlier ages plant it on the recessed roof floor as before.
    if(e.complete){
      if (ownerAge >= 2) drawWavingFlag(sx, sy, 68, darken ? darkenColor(tc) : tc, darken ? darkenColor(tcD) : tcD, 22);
      else drawWavingFlag(sx, sy, 29, darken ? darkenColor(tc) : tc, darken ? darkenColor(tcD) : tcD, 42);
    }
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
    let beam=darken?darkenColor(WOOD.beam):WOOD.beam;
    let {M1,M2,M1e,M2e,EL,EB} = drawGableBlock(sx, sy0, W, hh, wallH, roofH,
      aw.gl, aw.gr, tc, WOOD.beam, darken, ()=>{
        // Half-timber framing: studs and a mid-rail per face
        X.strokeStyle=beam;X.lineWidth=1.6;
        [0.35,0.7].forEach(t=>{
          X.beginPath();X.moveTo(sx-W+W*t,sy0+hh-wallH+hh*t);X.lineTo(sx-W+W*t,sy0+hh+hh*t);X.stroke();
          X.beginPath();X.moveTo(sx+W*t,sy0+hh*2-wallH-hh*t);X.lineTo(sx+W*t,sy0+hh*2-hh*t);X.stroke();
        });
        X.beginPath();X.moveTo(sx-W,sy0+hh-wallH*0.5);X.lineTo(sx,sy0+hh*2-wallH*0.5);X.lineTo(sx+W,sy0+hh-wallH*0.5);X.stroke();
      });
    // Team pennant at the front gable peak
    drawPennant(M1.x,M1.y,tc,darken);
    // Big 3D brick chimney poking through the roof slope: an iso block
    // with two shaded faces, a wider cap slab, and a dark flue opening.
    {
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
    bh=32;
    // Small tethered horse in side profile (east-facing), one-piece
    // silhouette: rump -> back -> neck crest -> head -> muzzle -> chest ->
    // belly. Used by the age-gated hitching rail below to advertise that
    // this building trains cavalry.
    let drawYardHorse=(hx,hy,coat,maneC,s=1)=>{ // s: outer scale — divide stroke widths so outlines stay on-style
      let c=darken?darkenColor(coat):coat, m=darken?darkenColor(maneC):maneC;
      X.strokeStyle='#000';X.lineJoin='round';X.lineCap='round';
      // legs (black outline, coat core)
      [[-5.5,0],[-2.5,0.4],[3,0.4],[5.5,0]].forEach(([lx,ly])=>{
        X.lineWidth=2.6/s;X.strokeStyle='#000';
        X.beginPath();X.moveTo(hx+lx,hy-5+ly);X.lineTo(hx+lx,hy+ly);X.stroke();
        X.lineWidth=1.2/s;X.strokeStyle=c;
        X.beginPath();X.moveTo(hx+lx,hy-5+ly);X.lineTo(hx+lx,hy+ly-0.8);X.stroke();
      });
      X.strokeStyle='#000';X.lineWidth=1.2/s;
      // body + neck + head silhouette
      X.fillStyle=c;X.beginPath();
      X.moveTo(hx-7,hy-6);                              // rump
      X.quadraticCurveTo(hx-8.5,hy-10,hx-5,hy-10.5);    // over the rump
      X.lineTo(hx+2,hy-10.5);                           // back
      X.quadraticCurveTo(hx+5.5,hy-11,hx+6.5,hy-15);    // neck crest
      X.quadraticCurveTo(hx+7,hy-17,hx+9,hy-16.5);      // poll
      X.lineTo(hx+11.5,hy-14.5);                        // muzzle top
      X.quadraticCurveTo(hx+11.8,hy-13,hx+10,hy-12.8);  // squared muzzle
      X.quadraticCurveTo(hx+8,hy-12.5,hx+7.5,hy-10.5);  // jaw
      X.quadraticCurveTo(hx+7.5,hy-7.5,hx+5.5,hy-6.2);  // chest
      X.quadraticCurveTo(hx,hy-4.8,hx-4.5,hy-5.6);      // belly
      X.closePath();X.fill();X.stroke();
      // mane + tail
      X.strokeStyle=m;X.lineWidth=2/s;
      X.beginPath();X.moveTo(hx+3,hy-10.8);X.quadraticCurveTo(hx+5.8,hy-12.5,hx+6.8,hy-15.5);X.stroke();
      let sw=visible?Math.sin(tick*0.06+e.id)*0.8:0;
      X.beginPath();X.moveTo(hx-7,hy-9.5);X.quadraticCurveTo(hx-9.5+sw,hy-6,hx-8.5+sw,hy-1.5);X.stroke();
      X.strokeStyle='#000';X.lineWidth=1.2/s;X.lineCap='butt';
    };
    // 1. Sleeping-quarters annex at the back (team-colored roof)
    drawGableBlock(sx+2, sy+10, 20, 10, 13, 12, '#b89868','#987848',tc,'#6e5138', darken);
    // 2. Main garrison longhouse in front-left (team-colored roof)
    drawGableBlock(sx-32, sy+22, 26, 13, 16, 15, '#b89868','#987848',tc,'#6e5138', darken);
    // Door on the longhouse left wall
    drawDoorLeft(sx-32, sy+22, 26, 13, '#5c3d24', darken);

    // 3. Corner watchtower — the barracks' age tell, matching the TC's
    // progression: TIMBER in the Dark age, dressed stone from Feudal, and
    // a crenellated flat top (merlons replace the pyramid cap) at Castle.
    let twL = ownerAge === 0 ? WOOD.L : '#cfc8b6';
    let twR = ownerAge === 0 ? WOOD.R : '#aca392';
    // Same bastion element as the watch tower / gate posts: 14x7 footprint,
    // stone-wall palette, merlons seated with the tower's +28 anchor (top
    // face center is sy+9 here) so the crenellation reads identically.
    if (ownerAge >= 2) {
      drawBuildingBlock(sx+32, sy+32, 14, 7, 30, twL, twR, 'flat', 0, '#b7ad97', '#b7ad97', darken, true);
      drawBastionMerlons(sx+32, sy+37, '#e0d8c6', '#c4bba6', darken);
      // pole planted on the back merlon's cap (sy-1), like the tower
      if(e.complete && visible) drawWavingFlag(sx+32, sy+30, 29, tc, tcD);
    } else {
      drawBuildingBlock(sx+32, sy+32, 14, 7, 30, twL, twR, 'conical', 10, tc, tcD, darken);
      if(e.complete && visible) drawWavingFlag(sx+32, sy+32, 38, tc, tcD);
    }

    // 4. Fenced training yard
    X.fillStyle=darken ? darkenColor('#bfa38a') : '#bfa38a';X.beginPath();
    X.moveTo(sx,sy+32);X.lineTo(sx+32,sy+48);
    X.lineTo(sx,sy+64);X.lineTo(sx-32,sy+48);X.closePath();
    X.fill();
    X.strokeStyle='#000000';X.lineWidth=1.2;X.stroke();

    // Horses penned at the BACK of the training yard (drawn before the
    // dummy/target so they read as standing behind them) — the visual tell
    // that this barracks trains cavalry: the bay appears when scouts
    // unlock (Feudal), the knight's white charger joins at Castle.
    if(ownerAge >= 1){
      let hs = 1.5;
      let horseAt = (hx, hy, coat, maneC) => {
        X.save(); X.translate(hx, hy); X.scale(hs, hs); X.translate(-hx, -hy);
        drawYardHorse(hx, hy, coat, maneC, hs);
        X.restore();
      };
      horseAt(sx + 6, sy + 45, '#8b5a2b', '#3f2810');             // Feudal bay (scout)
      if(ownerAge >= 2) horseAt(sx + 20, sy + 51, '#e9e6de', '#9a948a'); // Castle white charger (knight)
    }

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

    // Archery target board (left half of the yard, next to the dummy —
    // the right half is the horse pen once cavalry unlocks)
    let tgx=sx-22, tgy=sy+46;
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
    // drawCampClearing(sx, sy+bhh-bhh*1.45, bw*1.45, bhh*1.45, darken);
    drawCampClearing(sx, sy, bw, bhh, darken);
    
    // Small plank shack in the back-right quadrant
    drawBuildingBlock(sx+14, sy+8, 20, 10, 14, '#b89868','#987848','peaked',8,'#8a6a48','#715539', darken);
    drawDoorLeft(sx+14, sy+8, 20, 10, '#5c3d24', darken);
    drawPennant(sx+14, sy-14, tc, darken);
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
    drawCampClearing(sx, sy, bw, bhh, darken);

    // Dark timber mine shed in the back-right quadrant
    drawBuildingBlock(sx+14, sy+8, 20, 10, 12, '#7a6a55','#635546','peaked',7,'#55483a','#463b2f', darken);
    drawDoorLeft(sx+14, sy+8, 20, 10, '#2e2519', darken);
    drawPennant(sx+14, sy-10, tc, darken);
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
    // One continuously-tapering octagonal tower (matching the icon-MILL
    // reference art) — 3 color bands suggest stone-to-timber courses without
    // ever breaking the outline into separate stepped drums.
    bh=72;
    let by = sy + bhh;                 // tower centered on the 2x2 footprint
    let W0=bw*0.58, W1=bw*0.30;        // base / top half-widths
    let H=48, ty=by-H;
    const lerp=(a,b,t)=>a+(b-a)*t;
    const wAt=t=>lerp(W0,W1,t);        // half-width at height-fraction t (0=base,1=top)
    const yAt=t=>lerp(by,ty,t);
    // 3 bands, each a trapezoid whose edges exactly meet the next band's —
    // no gaps, no ledges, one unbroken silhouette.
    let bands=[
      {t0:0,    t1:0.42, cL:'#8a6a42', cR:'#6d4f30'}, // dark cocoa base
      {t0:0.42, t1:0.74, cL:tc, cR:tcD}, // mid brown
      {t0:0.74, t1:1,    cL:'#c9a874', cR:'#a9895c'}, // lighter top band
    ];
    X.lineJoin='round';
    bands.forEach(bd=>{
      let y0=yAt(bd.t0), y1=yAt(bd.t1);
      let w0=wAt(bd.t0), w1=wAt(bd.t1);
      let h0=w0*0.5, h1=w1*0.5;
      let wl=darken?darkenColor(bd.cL):bd.cL, wr=darken?darkenColor(bd.cR):bd.cR;
      X.strokeStyle='#000';X.lineWidth=1.2;
      X.fillStyle=wl;X.beginPath();
      X.moveTo(sx-w0,y0);X.lineTo(sx,y0+h0);X.lineTo(sx,y1+h1);X.lineTo(sx-w1,y1);X.closePath();X.fill();X.stroke();
      X.fillStyle=wr;X.beginPath();
      X.moveTo(sx,y0+h0);X.lineTo(sx+w0,y0);X.lineTo(sx+w1,y1);X.lineTo(sx,y1+h1);X.closePath();X.fill();X.stroke();
    });

    // Door centered on the base band's left face
    let baseW=wAt(0), baseH=baseW*0.5;
    let dA={x:sx-baseW*0.62,y:by+baseH*0.38}, dB={x:sx-baseW*0.38,y:by+baseH*0.62};
    X.fillStyle=darken?darkenColor('#3a2612'):'#3a2612';
    X.strokeStyle='#000';X.lineWidth=1;
    X.beginPath();X.moveTo(dA.x,dA.y);X.lineTo(dB.x,dB.y);
    X.lineTo(dB.x,dB.y-12);X.lineTo(dA.x,dA.y-12);X.closePath();X.fill();X.stroke();

    // ---- Rounded dome cap, flush with the tower's own top width (no
    // separate steep cone / overhang jump — continues the same taper) ----
    let topHalf=W1*0.5;
    let capH=16;
    
    // Team-colored dome cap
    let cl=darken?darkenColor('#a65c3b'):'#a65c3b', cr=darken?darkenColor('#863c20'):'#863c20';
    X.strokeStyle='#000';X.lineWidth=1.2;
    X.fillStyle=cl;X.beginPath();
    X.moveTo(sx,ty-capH);X.quadraticCurveTo(sx-W1,ty-capH*0.3,sx-W1,ty);X.lineTo(sx,ty+topHalf);X.closePath();X.fill();X.stroke();
    X.fillStyle=cr;X.beginPath();
    X.moveTo(sx,ty-capH);X.quadraticCurveTo(sx+W1,ty-capH*0.3,sx+W1,ty);X.lineTo(sx,ty+topHalf);X.closePath();X.fill();X.stroke();

    if(e.complete){
      let hubY=ty+topHalf*0.3;
      // Team pennant drawn BEFORE the sails so the blades sweep in front of
      // it, matching how a mounted flag sits behind a windmill's fan.
      // drawPennant(sx,ty-capH,tc,darken); // planted on the dome apex
      if(visible) drawWindmillSails(sx, hubY, e.id, 1.6);
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
    drawBuildingBlock(sx, linkY-7, 14, 7, towerH, pfS[0], pfS[1], 'flat', 0, pfS[2], pfS[2], darken, ownerAge >= 2);
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
      drawWallLink(sx, linkY, -32, 16, wallH, darken, 8, 5, null, tc, 4, false, wallMat(sN.btype) || 'wood');
    }

    // East neighbor (x+1)
    let eN = getConnectedBuilding(e.x + 1, e.y);
    if (isWallLike(eN)) {
      drawWallLink(sx, linkY, 32, 16, wallH, darken, 8, 5, null, tc, 4, false, wallMat(eN.btype) || 'wood');
    }

    // Castle: pole planted on the back merlon's cap (sy-40), matching the
    // TC. Feudal: pole rises from the peaked cap's apex (sy-42).
    if (e.complete && visible) drawWavingFlag(sx, sy, ownerAge >= 2 ? 32 : 40, tc, tcD);
  }
  else if(isWallBtype(e.btype)){
    bh=14;
    let pillarH = 22;
    let wallH = 14;   // lower than pillar to create bastion crenellated effect
    let linkY = sy + 16;
    // Material palette: palisade wood vs stone greys — links only join the
    // SAME material (a palisade run and a stone run stay visually separate).
    let mat = wallMat(e.btype);
    let pf = mat === 'stone' ? ['#cfc8b6', '#aca392', '#b7ad97'] : [WOOD.L, WOOD.R, WOOD.top];

    // 1. Draw central pillar first (centered concentrically at sy+16) —
    // links draw AFTER so the walkway visibly connects between the
    // mini towers instead of being swallowed by them.
    // Colors match drawWallLink's palette so the pillar reads as part of
    // the same wall run instead of a separately-shaded block. Pillar caps
    // and walkway link tops are all team-colored (ownership read) — the
    // cap as a SINGLE flat color, like the links' flat tops.
    drawBuildingBlock(sx, sy+11, 9, 4.5, pillarH, pf[0], pf[1], 'flat', 0, tc, tc, darken);

    // 2. Draw South and East links second (running towards the front, overlapping the pillar)
    // Slab half-thickness 4.5 makes the link's 9px cross-section match
    // the pillar's half-width exactly, and d1 = 2.25*sqrt(5) centers it:
    // the near-end edge lands on the pillar's FRONT vertical edge and the
    // back top corner on its BACK vertical edge, so both outlines
    // coincide with the pillar's instead of doubling into thick lines.
    // (linkY - 0.5: the 4.5-thick slab's bottom front corner otherwise
    // lands 0.5px below the pillar's bottom vertex)
    let d1 = 2.25 * Math.sqrt(5);
    // South neighbor (y+1)
    if (isWallLike(getConnectedBuilding(e.x, e.y + 1), mat)) {
      drawWallLink(sx, linkY - 0.5, -32, 16, wallH, darken, d1, d1, null, tc, 4.5, false, mat);
    }

    // East neighbor (x+1)
    if (isWallLike(getConnectedBuilding(e.x + 1, e.y), mat)) {
      drawWallLink(sx, linkY - 0.5, 32, 16, wallH, darken, d1, d1, null, tc, 4.5, false, mat);
    }
  }

  else if(isGateBtype(e.btype)){
    let mat = wallMat(e.btype);
    let pf = mat === 'stone' ? ['#c8c0ae', '#a89f8d', '#b0b0a4'] : [WOOD.L, WOOD.R, WOOD.top];
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
        drawWallLink(t1sx, t1sy - slideY, dx, dy, 20, darken, 7, 0, '#8b5a2b', '#a5723a', 2, true);
      }

      // 1. Draw connection links for Post 1 (back post centered at t1sy)
      let wallH = 14;
      if (wallLineNS) {
        // N-S Gate: Post 1 is at (e.x, e.y). Perpendicular connection goes East (x+1).
        if (isWallLike(getConnectedBuilding(e.x + 1, e.y), mat)) {
          drawWallLink(t1sx, t1sy, 32, 16, wallH, darken, 5, 5, null, tc, 4, false, mat);
        }
      } else {
        // E-W Gate: Post 1 is at (e.x, e.y). Perpendicular connection goes South (y+1).
        if (isWallLike(getConnectedBuilding(e.x, e.y + 1), mat)) {
          drawWallLink(t1sx, t1sy, -32, 16, wallH, darken, 5, 5, null, tc, 4, false, mat);
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
        // N-S Gate: Post 2 is at (e.x, e.y+1). Parallel connection goes South (y+2), Perpendicular goes East (x+1, y+1).
        if (isWallLike(getConnectedBuilding(e.x, e.y + 2), mat)) {
          drawWallLink(t2sx, t2sy, -32, 16, wallH, darken, 8, 5, null, tc, 4, false, mat);
        }
        if (isWallLike(getConnectedBuilding(e.x + 1, e.y + 1), mat)) {
          drawWallLink(t2sx, t2sy, 32, 16, wallH, darken, 8, 5, null, tc, 4, false, mat);
        }
      } else {
        // E-W Gate: Post 2 is at (e.x+1, e.y). Parallel connection goes East (x+2, y), Perpendicular goes South (x+1, y+1).
        if (isWallLike(getConnectedBuilding(e.x + 2, e.y), mat)) {
          drawWallLink(t2sx, t2sy, 32, 16, wallH, darken, 8, 5, null, tc, 4, false, mat);
        }
        if (isWallLike(getConnectedBuilding(e.x + 1, e.y + 1), mat)) {
          drawWallLink(t2sx, t2sy, -32, 16, wallH, darken, 8, 5, null, tc, 4, false, mat);
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
  if (!window._ghostDraw && (f === 2 || e.team === myTeam)) {
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
  // Garrison count — just the number, planted beside this building's own
  // team flag (only TC and TOWER can ever hold a garrison, and both fly
  // their flag at the very top of the structure using this same sx/sy).
  if(e.team===myTeam&&e.garrison&&e.garrison.length>0){
    let flagX=sx, flagY;
    if(e.btype==='TC') flagY=sy-88;
    else if(e.btype==='TOWER') flagY=sy-54;
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
  // Train progress
  if(e.queue&&e.queue.length>0){
    let pct=e.trainTick/(UNITS[e.queue[0]].trainTime);
    let bww=b.w*24;
    X.fillStyle='#000000';X.fillRect(sx-bww/2-1,sy+bhh*2+3,bww+2,5); // black border box
    X.fillStyle='#003';X.fillRect(sx-bww/2,sy+bhh*2+4,bww,3);
    X.fillStyle='#0af';X.fillRect(sx-bww/2,sy+bhh*2+4,bww*pct,3);
  }
  // Age research progress — same bar as training, gold fill, updates every
  // frame (smooth, unlike the throttled panel text).
  if(e.research){
    let pct=e.research.tick/AGES[e.research.target].researchTicks;
    let bww=b.w*24;
    X.fillStyle='#000000';X.fillRect(sx-bww/2-1,sy+bhh*2+3,bww+2,5);
    X.fillStyle='#330';X.fillRect(sx-bww/2,sy+bhh*2+4,bww,3);
    X.fillStyle='#fc0';X.fillRect(sx-bww/2,sy+bhh*2+4,bww*pct,3);
  }
  } // end fog-aware UI
}



