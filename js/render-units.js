// Big readable broadsword, drawn with the context translated to the grip.
// Combat swing is shaped: slow overhead wind-up, fast slash (like the
// villagers' work swing) instead of a symmetric sine wobble.
function drawBigSword(swinging, id){
  if(swinging){
    let ph=((tick*0.07+id*0.4)%1+1)%1;
    let u=ph<0.72?ph/0.72:1-(ph-0.72)/0.28;
    X.rotate(0.9-2.1*u);
  } else X.rotate(0.5); // rest: blade leans outward, away from the head
  X.strokeStyle='#000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
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

// Uniform size multiplier for every drawn character (units and corpses).
const UNIT_SCALE = 1.25;

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
  X.ellipse(sx, sy + 3, 9*UNIT_SCALE, 4.5*UNIT_SCALE, 0, 0, Math.PI * 2);
  X.fill();
  
  // 2. Rotate corpse flat on the ground plane
  X.translate(sx, sy);
  X.scale(c.facing * UNIT_SCALE, UNIT_SCALE);
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
  X.strokeStyle='#5c3d24';X.lineWidth=1.5/UNIT_SCALE;
  X.beginPath();X.moveTo(3,-2);X.lineTo(8,1);X.stroke();
  
  X.restore();
}


function drawUnit(e){
  if(e.garrisonedIn)return; // hidden inside a building
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
  X.beginPath();X.ellipse(sx,sy+2,6*UNIT_SCALE,3*UNIT_SCALE,0,0,Math.PI*2);X.fill();

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
    // Turn hysteresis (AoE2 units have turn inertia — they never strobe):
    // the raw Math.round above flickers between two adjacent sectors every
    // frame when the movement/target angle sits near a 45° boundary (bear
    // standing beside its victim, units micro-shoved by separation), and a
    // flicker across a facing boundary mirror-flops the entire sprite. A
    // one-sector change must therefore persist ~6 frames before committing;
    // decisive turns (≥2 sectors) still snap immediately.
    if(e.dir !== undefined && dir !== e.dir){
      let diff = Math.min((dir - e.dir + 8) % 8, (e.dir - dir + 8) % 8);
      if(diff === 1){
        if(e.pendingDir === dir) e.pendingDirT = (e.pendingDirT || 0) + 1;
        else { e.pendingDir = dir; e.pendingDirT = 1; }
        if(e.pendingDirT < 6) dir = e.dir;
        else e.pendingDir = undefined;
      } else e.pendingDir = undefined;
    } else e.pendingDir = undefined;
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
  if(e.utype==='sheep'||e.utype==='bear') X.translate(sx, sy + sbob);
  else if(e.utype==='sheep_carcass') X.translate(sx, sy);
  else X.translate(sx, sy + bob);
  X.scale(e.facing * UNIT_SCALE, UNIT_SCALE);

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
      X.strokeStyle='#000000'; X.lineWidth=1.8/UNIT_SCALE;
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
      X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;X.stroke();
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
    X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;X.stroke();
    X.fillStyle='#e0d8c0';
    X.beginPath();X.arc(earX,earY,1.1,0,Math.PI*2);X.fill();X.stroke();

    // Partially eaten raw meat/ribs in the center of the round wool body
    let foodPct = e.hp / e.maxHp;
    if(foodPct < 0.75){
      X.fillStyle='#c84b4b'; // raw meat
      X.beginPath();X.ellipse(0, -3.5, 4.2 * (1 - foodPct), 2.8 * (1 - foodPct), 0, 0, Math.PI*2);X.fill();
      X.strokeStyle='#000000';X.lineWidth=0.85/UNIT_SCALE;X.stroke();
      
      if(foodPct < 0.4){
        X.strokeStyle='#ffffff';X.lineWidth=1.1/UNIT_SCALE;
        X.beginPath();X.moveTo(-1.2, -5);X.lineTo(-1.2, -2);X.stroke();
        X.beginPath();X.moveTo(1.2, -5.5);X.lineTo(1.2, -2.5);X.stroke();
      }
    }
    
    X.restore();
    X.restore();
    return;
  } else if(e.utype==='bear'){
    // Bear — heavy quadruped in the sheep's style: one black silhouette
    // pass, then fur fill. Side profile; X.scale(e.facing,…) flips it.
    let attacking = e.target && e.path.length===0;
    // Chase/attack read: forward lunge while mauling, slight prowl sway walking
    let lunge = attacking ? Math.max(0, Math.sin(tick*0.35+e.id)) * 3 : 0;
    let sway = e.path.length>0 ? Math.sin(tick*0.25+e.id)*0.05 : 0;
    let breath = (e.path.length===0 && !attacking) ? Math.sin(tick*0.05+e.id)*0.25 : 0;

    X.save();
    X.rotate(sway);
    X.translate(lunge, 0);
    // Cartoon proportions: one huge boulder of a body on tiny stub legs.
    X.scale(1.4, 1.4);

    // Stub-leg walk cycle: comically short, thick legs mostly hidden
    // under the body mass — just paws scuttling along
    let lw1 = e.path.length>0 ? Math.sin(tick*0.5+e.id)*1.8 : 0;
    let lw2 = -lw1;
    let legPts = [[-6,2,lw1],[-3,2.5,lw2],[2.5,2.5,lw1],[5.5,2,lw2]];
    X.beginPath();
    legPts.forEach(p=>{ X.moveTo(p[0],p[1]); X.lineTo(p[0]+p[2],5); });
    X.strokeStyle='#000'; X.lineWidth=4.2/UNIT_SCALE; X.lineCap='round'; X.stroke();
    X.strokeStyle='#4e3520'; X.lineWidth=2.6/UNIT_SCALE; X.stroke(); X.lineCap='butt';
    X.fillStyle='#241a10';
    legPts.forEach(p=>{ X.beginPath(); X.ellipse(p[0]+p[2],5.2,1.6,1,0,0,Math.PI*2); X.fill(); });

    // Direction resolution (same scheme as the sheep): the canvas is already
    // mirrored via X.scale(e.facing,…), so left-pointing dirs map onto their
    // right-pointing twins and we only author 4 poses:
    //   'front' (S: face to camera), 'back' (N: rump to camera),
    //   'side'  (E/SE profile),      'backside' (NE: profile from behind)
    let useDir = e.dir;
    if (e.facing === -1) {
      if (e.dir === 2) useDir = 0;      // SW -> SE
      else if (e.dir === 3) useDir = 7; // W -> E
      else if (e.dir === 4) useDir = 6; // NW -> NE
    }
    let pose = e.dir === 1 ? 'front' : e.dir === 5 ? 'back' :
               (useDir === 6) ? 'backside' : 'side';
    // Profile head sits a touch lower when heading SE (downhill toward camera)
    let hx = useDir === 0 ? 7.8 : 8.6;
    let hy = useDir === 0 ? -3.2 : -4.2;

    // Body silhouette pass (black, slightly inflated), then fur fill —
    // one giant boulder body with a high shoulder hump; head/ears/tail
    // move with the pose, the boulder itself barely changes (that's the
    // luxury of cartoon mass: it reads from every angle).
    const bearShapes = (grow)=>{
      if(pose==='front'||pose==='back'){
        X.beginPath(); X.ellipse(-0.2,-4.5,8.4+grow+breath,7.4+grow+breath,0,0,Math.PI*2); X.fill(); // body (narrower head-on)
        X.beginPath(); X.arc(0,-9.8,5+grow+breath,0,Math.PI*2); X.fill();       // hump reads as shoulders
        if(pose==='front'){
          X.beginPath(); X.arc(0,-4.2,4.4+grow,0,Math.PI*2); X.fill();          // head, face to camera
          X.beginPath(); X.arc(-3.4,-8.2,1.7+grow,0,Math.PI*2); X.fill();       // ears
          X.beginPath(); X.arc(3.4,-8.2,1.7+grow,0,Math.PI*2); X.fill();
        } else {
          X.beginPath(); X.arc(0,-11.2,3.6+grow,0,Math.PI*2); X.fill();         // back of head over the hump
          X.beginPath(); X.arc(-3,-13.6,1.6+grow,0,Math.PI*2); X.fill();        // ears
          X.beginPath(); X.arc(3,-13.6,1.6+grow,0,Math.PI*2); X.fill();
          X.beginPath(); X.arc(0,1.2,2.2+grow,0,Math.PI*2); X.fill();           // stub tail on the rump
        }
      } else {
        X.beginPath(); X.ellipse(-0.5,-4.5,9.6+grow+breath,7.4+grow+breath,0,0,Math.PI*2); X.fill(); // huge body
        X.beginPath(); X.arc(-3.5,-9.5,4.6+grow+breath,0,Math.PI*2); X.fill();  // shoulder hump
        X.beginPath(); X.arc(-10.2,-4,2+grow,0,Math.PI*2); X.fill();            // stub tail
        if(pose==='backside'){
          X.beginPath(); X.arc(6.4,-7.2,3.2+grow,0,Math.PI*2); X.fill();        // head turned away, higher
          X.beginPath(); X.arc(4.8,-10.4,1.6+grow,0,Math.PI*2); X.fill();       // ear
        } else {
          X.beginPath(); X.arc(hx,hy,3.4+grow,0,Math.PI*2); X.fill();           // head (small, set low)
          X.beginPath(); X.ellipse(hx+2.8,hy+0.8,2.2+grow,1.6+grow,0.2,0,Math.PI*2); X.fill(); // snout
          X.beginPath(); X.arc(hx-1.6,hy-3.2,1.6+grow,0,Math.PI*2); X.fill();   // tiny ear
        }
      }
    };
    X.fillStyle='#000';
    bearShapes(1.1);
    X.fillStyle='#6b4a2c';
    bearShapes(0);
    // Fur shading: light along the massive back, ground shade under the belly
    X.fillStyle='rgba(255,235,200,0.28)';
    if(pose==='front'||pose==='back') X.beginPath(), X.ellipse(0,-10.2,4.4,2.4,0,0,Math.PI*2), X.fill();
    else X.beginPath(), X.ellipse(-2.5,-9.5,5.8,2.6,0.15,0,Math.PI*2), X.fill();
    X.fillStyle='rgba(40,25,10,0.30)';
    X.beginPath(); X.ellipse(-0.5,0.8,7.6,2.2,0,0,Math.PI*2); X.fill();

    // Face per pose: tan muzzle, black nose, tiny eyes (cartoon rule: the
    // smaller the eyes on the bigger the body, the better), inner ears
    if(pose==='front'){
      X.fillStyle='#4a3018';
      X.beginPath(); X.arc(-3.4,-8.2,0.9,0,Math.PI*2); X.fill();  // inner ears
      X.beginPath(); X.arc(3.4,-8.2,0.9,0,Math.PI*2); X.fill();
      X.fillStyle='#c9a578';
      X.beginPath(); X.ellipse(0,-2.6,2.4,1.9,0,0,Math.PI*2); X.fill(); // muzzle
      X.fillStyle='#000';
      X.beginPath(); X.arc(0,-3.4,1.05,0,Math.PI*2); X.fill();    // nose
      X.beginPath(); X.arc(-1.9,-5.4,0.65,0,Math.PI*2); X.fill(); // eyes
      X.beginPath(); X.arc(1.9,-5.4,0.65,0,Math.PI*2); X.fill();
    } else if(pose==='back'){
      X.fillStyle='#4a3018';
      X.beginPath(); X.arc(-3,-13.6,0.85,0,Math.PI*2); X.fill();  // inner ears
      X.beginPath(); X.arc(3,-13.6,0.85,0,Math.PI*2); X.fill();
      X.fillStyle='#c9a578';
      X.beginPath(); X.arc(0,1.2,1.3,0,Math.PI*2); X.fill();      // tail tuft
    } else if(pose==='backside'){
      X.fillStyle='#4a3018';
      X.beginPath(); X.arc(4.8,-10.4,0.85,0,Math.PI*2); X.fill(); // inner ear
    } else {
      X.fillStyle='#c9a578';
      X.beginPath(); X.ellipse(hx+2.8,hy+0.8,1.6,1.1,0.2,0,Math.PI*2); X.fill();
      X.fillStyle='#000';
      X.beginPath(); X.arc(hx+4.3,hy+0.5,1,0,Math.PI*2); X.fill();    // nose
      X.beginPath(); X.arc(hx+0.4,hy-0.8,0.65,0,Math.PI*2); X.fill(); // eye
      X.fillStyle='#4a3018';
      X.beginPath(); X.arc(hx-1.6,hy-3.2,0.85,0,Math.PI*2); X.fill(); // inner ear
    }

    // Mauling: open jaw flash while lunged forward
    if(attacking && lunge > 1.5){
      X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
      X.fillStyle='#a03030';
      if(pose==='front'){
        X.beginPath(); X.ellipse(0,-1.6,1.5,1.1,0,0,Math.PI*2); X.fill(); X.stroke(); // open mouth
      } else if(pose==='side'){
        X.beginPath(); X.moveTo(hx+2.4,hy+1.5); X.lineTo(hx+5.2,hy+3); X.lineTo(hx+2.7,hy+2.6); X.closePath(); X.fill(); X.stroke();
      }
    }
    X.restore();
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
      X.strokeStyle = '#000000'; X.lineWidth=3.0/UNIT_SCALE; X.lineCap='round'; X.stroke();
      X.strokeStyle = '#6e4520'; X.lineWidth=1.5/UNIT_SCALE; X.stroke();
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
      X.strokeStyle = '#000000'; X.lineWidth=3.0/UNIT_SCALE; X.lineCap='round'; X.stroke();
      X.strokeStyle = '#5b3a1e'; X.lineWidth=1.5/UNIT_SCALE; X.stroke();
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
        // Rounded leaf-shaped ear (a bare triangle reads as a horn)
        X.beginPath(); X.moveTo(-1.1,0.6);
        X.quadraticCurveTo(-1.3,-1.6, 0,-2.4);
        X.quadraticCurveTo(1.3,-1.6, 1.1,0.6); X.closePath();
        X.fillStyle=coat; X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE; X.fill(); X.stroke(); X.restore(); };
      X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;

      if (useDir === 7 || useDir === 0) {
        // East profile / Southeast diagonal (same construction, SE compressed)
        let k = useDir === 7 ? 1 : 0.85;
        // Swishing tail
        X.save(); X.translate(-6.6*k,-7); X.rotate(swish);
        X.beginPath(); X.moveTo(0,0); X.quadraticCurveTo(-2.7*k,3,-2.2*k,9);
        X.strokeStyle='#000'; X.lineWidth=3.4/UNIT_SCALE; X.lineCap='round'; X.stroke();
        X.strokeStyle=maneC; X.lineWidth=1.8/UNIT_SCALE; X.stroke(); X.lineCap='butt';
        X.restore();
        // Body capsule
        X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE; X.fillStyle=coat;
        X.beginPath(); X.ellipse(0,-6,7.4*k,4.9,0,0,Math.PI*2); X.fill(); X.stroke();
        // Neck + head silhouette, anchored at the front of the body
        // (nods gently while idle)
        X.save(); X.translate(2.6*k,nod);
        ear(8.5*k,-13.9,-0.2); ear(10.1*k,-13.3,0.3);
        X.fillStyle=coat; X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
        X.beginPath();
        X.moveTo(2.2*k,-2.6);
        X.quadraticCurveTo(6.6*k,-4.6, 7.8*k,-9);        // front of neck up to the throat
        X.quadraticCurveTo(10.5*k,-8.6, 14.2*k,-8.6);    // long flat jaw out to the muzzle
        X.lineTo(14.8*k,-12);                            // tall squared nose end
        X.quadraticCurveTo(12.5*k,-13.6, 9.6*k,-13.9);   // long flat forehead back to the poll
        X.quadraticCurveTo(4.6*k,-14.4, 1.6*k,-11);      // arched crest of the neck
        X.quadraticCurveTo(-0.4*k,-8.5, -0.6*k,-5.5);    // down into the withers
        // fill() closes the path on its own; stroking the OPEN path skips
        // the bottom edge, so the neck has no outline where it meets the
        // body and reads as one connected shape (both stroke ends land
        // inside the body silhouette).
        X.fill(); X.stroke();
        // Mane along the crest
        X.strokeStyle=maneC; X.lineWidth=2.4/UNIT_SCALE; X.lineCap='round';
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
        X.strokeStyle='#000'; X.lineWidth=3.4/UNIT_SCALE; X.lineCap='round'; X.stroke();
        X.strokeStyle=maneC; X.lineWidth=1.8/UNIT_SCALE; X.stroke(); X.lineCap='butt';
        X.restore();
        X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE; X.fillStyle=coat;
        X.beginPath(); X.ellipse(0,-6,6.6,4.9,0,0,Math.PI*2); X.fill(); X.stroke();
        X.save(); X.translate(1.6,nod);
        ear(3.9,-16.4,-0.25); ear(6.1,-16,0.25);
        X.fillStyle=coat;
        // Slim tapering neck seen from behind (was a wide flat slab)
        X.beginPath();
        X.moveTo(2.2,-4.5); X.quadraticCurveTo(2.4,-10, 3.5,-14.2);
        X.lineTo(6,-13.8);
        X.quadraticCurveTo(6.2,-9, 5.4,-4);
        // open-path stroke: no outline along the base where it joins the body
        X.fill(); X.stroke();
        // Round skull from behind, dipped forward
        X.beginPath(); X.ellipse(4.9,-14.3,2.1,2.2,0.15,0,Math.PI*2); X.fill(); X.stroke();
        // Mane down the crest
        X.strokeStyle=maneC; X.lineWidth=2/UNIT_SCALE; X.lineCap='round';
        X.beginPath(); X.moveTo(3,-5); X.quadraticCurveTo(3.6,-10,4.2,-14.4); X.stroke();
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
          X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE; X.fillStyle=coat;
          ear(2.4,-12.6,-0.3); ear(5.8,-12.4,0.3);
          // Rounded skull narrowing into a short hanging muzzle
          X.beginPath();
          X.moveTo(1.6,-10.6);
          X.quadraticCurveTo(1.4,-7.2, 2.7,-4.9);   // left cheek down to the muzzle
          X.quadraticCurveTo(4.1,-3.9, 5.5,-4.9);   // rounded chin
          X.quadraticCurveTo(6.8,-7.2, 6.6,-10.6);  // right cheek back up
          X.quadraticCurveTo(4.1,-13.8, 1.6,-10.6); // domed forehead
          X.closePath(); X.fill(); X.stroke();
          // Forelock tuft
          X.fillStyle=maneC;
          X.beginPath(); X.arc(4.1,-11.7,1.9,Math.PI*0.9,Math.PI*0.1,true); X.fill();
          // Big friendly eyes wide on the skull
          X.fillStyle='#000';
          X.beginPath(); X.arc(2.7,-9.2,0.7,0,Math.PI*2); X.fill();
          X.beginPath(); X.arc(5.5,-9.2,0.7,0,Math.PI*2); X.fill();
          // Lighter rounded muzzle with nostril dots
          X.fillStyle='#6e4520';
          X.beginPath(); X.ellipse(4.1,-5.4,1.8,1.4,0,0,Math.PI*2); X.fill(); X.stroke();
          X.fillStyle='rgba(0,0,0,0.55)';
          X.beginPath(); X.arc(3.4,-5.4,0.35,0,Math.PI*2); X.fill();
          X.beginPath(); X.arc(4.8,-5.4,0.35,0,Math.PI*2); X.fill();
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
        X.strokeStyle='#000'; X.lineWidth=3.2/UNIT_SCALE; X.lineCap='round'; X.stroke();
        X.strokeStyle=maneC; X.lineWidth=1.6/UNIT_SCALE; X.stroke(); X.lineCap='butt';
        X.restore();
      }
      X.restore();
    }

    // Torso
    X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
    if(e.utype==='militia'){
      // Iron chainmail torso
      X.fillStyle='#6b6b6b';
      X.beginPath();X.arc(humanXOffset,-6+humanYOffset,5,0,Math.PI*2);X.fill();X.stroke();
      // Team-colored surcoat tunic
      X.fillStyle=tc;
      X.beginPath();X.rect(-2.5+humanXOffset,-10+humanYOffset,5,8);X.fill();X.stroke();
    } else if(e.utype==='villager'&&e.female){
      // Female villagers wear a dress drawn as ONE continuous path — a
      // rounded bodice (smaller than the male torso) flowing into a
      // bell-shaped skirt wider than the shoulders, with a single outline
      // so there's no seam at the waist. Boots peek out below the hem.
      let sway = e.path.length>0 ? Math.sin(tick*0.4+e.id)*0.7 : 0;
      X.fillStyle=tc;
      X.beginPath();
      X.arc(0,-6,4.1,Math.PI,0);                        // rounded bodice over the chest
      X.quadraticCurveTo(4.5,-2.5,5.6+sway,2.4-bob);    // waist flaring out to the hem
      X.quadraticCurveTo(0,3.8-bob,-5.6+sway,2.4-bob);  // rounded hem
      X.quadraticCurveTo(-4.5,-2.5,-4.1,-6);            // back up to the bodice
      X.closePath();
      X.fill();X.stroke();
      // Hem shadow so the skirt reads as a cone, not a flat triangle
      X.strokeStyle='rgba(0,0,0,0.25)';X.lineWidth=1.4/UNIT_SCALE;
      X.beginPath();X.moveTo(4+sway,1.3-bob);X.quadraticCurveTo(0,2.5-bob,-4+sway,1.3-bob);X.stroke();
      X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
    } else {
      // Team-colored peasant shirt
      X.fillStyle=tc;
      X.beginPath();X.arc(humanXOffset,-6+humanYOffset,5,0,Math.PI*2);X.fill();X.stroke();
    }

    // Torso volume: soft highlight upper-left, shade lower-right
    {
      let torsoR = (e.utype==='villager'&&e.female) ? 3.7 : 4.6;
      X.save();
      X.beginPath();X.arc(humanXOffset,-6+humanYOffset,torsoR,0,Math.PI*2);X.clip();
      X.fillStyle='rgba(255,255,255,0.22)';
      X.beginPath();X.arc(humanXOffset-2,-8.5+humanYOffset,3.6,0,Math.PI*2);X.fill();
      X.fillStyle='rgba(0,0,0,0.18)';
      X.beginPath();X.arc(humanXOffset+2.5,-3+humanYOffset,3.6,0,Math.PI*2);X.fill();
      X.restore();
    }

    // Arms: rear arm hangs at the side, front arm reaches toward the weapon/tool hand
    {
      let armSwing = e.path.length>0 ? Math.sin(tick*0.4+e.id)*1.5 : 0;
      // While a villager works a tool, the front hand grips the handle base
      // (the tool's rotation anchor at (3,-9)) instead of hanging loose.
      let gripping = e.utype==='villager' && e.path.length===0 &&
        (e.task==='chop'||e.task==='mine_gold'||e.task==='mine_stone'||e.task==='build');
      // Picking (berries/farm/butchering a carcass): no tool — the front arm
      // just reaches out and down repeatedly, like plucking. Carcass
      // harvesters are target-driven (no task), hence the extra check.
      let carcassTarget = !e.task&&e.target&&entitiesById.get(e.target)?.utype==='sheep_carcass';
      let picking = e.utype==='villager' && e.path.length===0 &&
        (e.task==='forage'||e.task==='farm'||carcassTarget);
      let pick = Math.sin(tick*0.18+e.id);
      // Fighting (AoE2 villagers have an attack animation): a fast forward
      // jab — sharp punch out, slower recovery — whenever a villager is
      // engaging a combat target (incl. slaughtering a live sheep).
      let fighting = e.utype==='villager' && e.path.length===0 && !e.task &&
        e.target && !picking && !carcassTarget;
      let jabPh = ((tick*0.06 + e.id*0.41) % 1 + 1) % 1;
      let jab = jabPh < 0.25 ? jabPh/0.25 : 1-(jabPh-0.25)/0.75; // 0..1 spike
      X.beginPath();
      X.moveTo(-3.5+humanXOffset,-8+humanYOffset); X.lineTo(-5+humanXOffset-armSwing,-3.5+humanYOffset);
      X.moveTo(3.5+humanXOffset,-8+humanYOffset);
      if(gripping) X.lineTo(3,-8.8);
      else if(picking) X.lineTo(5.6+humanXOffset+pick*0.8, -5.5+humanYOffset-pick*3.5);
      else if(fighting) X.lineTo(4.5+humanXOffset+jab*4.5, -6.5+humanYOffset-jab*1.5);
      else X.lineTo(4.5+humanXOffset+armSwing,-4.5+humanYOffset);
      X.strokeStyle='#000000';X.lineWidth=3.0/UNIT_SCALE;X.lineCap='round';X.stroke();
      X.strokeStyle='#edc9a0';X.lineWidth=1.5/UNIT_SCALE;X.stroke();
      X.lineCap='butt';
      // Head/headwear drawing below relies on the black outline stroke set
      // before the torso — restore it after the skin-colored arm pass.
      X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
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
        if(e.female){
          // One continuous silhouette: over the back of the head and
          // tapering down the back to the waist (single fill + stroke so
          // head and fall can't read as two pieces).
          X.beginPath();
          X.arc(humanXOffset,-14+humanYOffset,4.2,Math.PI,0);                                          // over the top of the head
          X.quadraticCurveTo(4.4+humanXOffset,-9+humanYOffset,3+humanXOffset,-4.8+humanYOffset);       // right edge tapering down
          X.quadraticCurveTo(0+humanXOffset,-3.6+humanYOffset,-3+humanXOffset,-4.8+humanYOffset);      // rounded hair ends
          X.quadraticCurveTo(-4.4+humanXOffset,-9+humanYOffset,-4.2+humanXOffset,-14+humanYOffset);    // left edge back up
          X.closePath();X.fill();X.stroke();
        } else {
          X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.2,0,Math.PI*2);X.fill();X.stroke();
        }
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
        if(e.female){
          // The whole hairdo (crown + strands) is ONE path with a single
          // fill and stroke, so the outline traces the outer silhouette and
          // the pieces can't read as disconnected. The crown arc runs over
          // the top of the head between the strands' upper ends; the
          // hairline height matches the male cap so the face stays visible.
          if(e.dir===7||e.dir===3){
            // Profile: all the hair falls behind the head as one thick
            // strand (local -x is always the back of the head, since the
            // context is mirrored to the facing direction).
            X.beginPath();
            X.moveTo(-3.6+humanXOffset,-6.4+humanYOffset);                                                // strand tip at the shoulder
            X.quadraticCurveTo(-4.7+humanXOffset,-7.8+humanYOffset,-4.9+humanXOffset,-10.5+humanYOffset); // outer edge up
            X.quadraticCurveTo(-5.2+humanXOffset,-14+humanYOffset,-4.2+humanXOffset,-15.4+humanYOffset);  // into the crown's back end
            X.arc(humanXOffset,-15.4+humanYOffset,4.2,Math.PI,0);                                         // over the top of the head
            X.lineTo(-2.4+humanXOffset,-15.4+humanYOffset);                                               // hairline back across the forehead
            X.quadraticCurveTo(-2.8+humanXOffset,-11.5+humanYOffset,-2.5+humanXOffset,-8+humanYOffset);   // inner edge down
            X.closePath();
            X.fill();X.stroke();
          } else {
            // Front/back-quarter: strands fall along BOTH sides of the head
            // down to the shoulders, leaving the face fully open between.
            X.beginPath();
            X.moveTo(-3.4+humanXOffset,-6.6+humanYOffset);                                                // left strand tip
            X.quadraticCurveTo(-4.6+humanXOffset,-8+humanYOffset,-4.7+humanXOffset,-10.5+humanYOffset);   // left outer edge up
            X.quadraticCurveTo(-5+humanXOffset,-14+humanYOffset,-4.2+humanXOffset,-15.4+humanYOffset);    // into the crown's left end
            X.arc(humanXOffset,-15.4+humanYOffset,4.2,Math.PI,0);                                         // over the top of the head
            X.quadraticCurveTo(5+humanXOffset,-14+humanYOffset,4.7+humanXOffset,-10.5+humanYOffset);      // right outer edge down
            X.quadraticCurveTo(4.6+humanXOffset,-8+humanYOffset,3.4+humanXOffset,-6.6+humanYOffset);      // right strand tip
            X.quadraticCurveTo(2.9+humanXOffset,-8.5+humanYOffset,3+humanXOffset,-11+humanYOffset);       // right inner edge up
            X.quadraticCurveTo(3.1+humanXOffset,-14+humanYOffset,2.7+humanXOffset,-15.4+humanYOffset);
            X.lineTo(-2.7+humanXOffset,-15.4+humanYOffset);                                               // hairline across the forehead
            X.quadraticCurveTo(-3.1+humanXOffset,-14+humanYOffset,-3+humanXOffset,-11+humanYOffset);      // left inner edge down
            X.quadraticCurveTo(-2.9+humanXOffset,-8.5+humanYOffset,-3.4+humanXOffset,-6.6+humanYOffset);
            X.closePath();
            X.fill();X.stroke();
          }
        } else {
          X.beginPath();
          X.arc(humanXOffset, -16+humanYOffset, 3.2, Math.PI, 0);
          X.fill(); X.stroke();
        }
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

    // Screen-space angle from this unit to its combat target, expressed in
    // the current facing-mirrored local frame (the context is under
    // X.scale(e.facing,1), so local +x always means "the way I'm facing").
    // Used to point aimed weapons (bow, spear) along the real attack line
    // instead of a fixed pose. Clamped so extreme up/down shots don't fold
    // the weapon through the body.
    let aimAngle = () => {
      let t = entitiesById.get(e.target);
      if (!t) return 0;
      let tcx = t.type === 'building' ? t.x + (t.w || 1) / 2 : t.x;
      let tcy = t.type === 'building' ? t.y + (t.h || 1) / 2 : t.y;
      let dix = ((tcx - e.x) - (tcy - e.y)) * HALF_TW;
      let diy = ((tcx - e.x) + (tcy - e.y)) * HALF_TH;
      let a = Math.atan2(diy, e.facing * dix);
      return Math.max(-1.15, Math.min(1.15, a));
    };

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
        X.strokeStyle='#000000';X.lineWidth=3.4/UNIT_SCALE;X.lineCap='round';
        X.beginPath();X.moveTo(0,1);X.lineTo(9,-13);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.8/UNIT_SCALE;
        X.beginPath();X.moveTo(0,1);X.lineTo(9,-13);X.stroke();X.lineCap='butt';
        // Big wedge axe head with a bright cutting edge
        X.fillStyle='#b8bfc6';
        X.beginPath();
        X.moveTo(8,-14.5);
        X.lineTo(14.5,-17);
        X.lineTo(13,-6.5);
        X.lineTo(7.4,-9.5);
        X.closePath();X.fill();
        X.strokeStyle='#000000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';X.stroke();
        X.strokeStyle='#fff';X.lineWidth=1.4/UNIT_SCALE;
        X.beginPath();X.moveTo(13.9,-15.9);X.lineTo(12.7,-7.9);X.stroke();
        X.restore();
      } else if((e.task==='mine_gold'||e.task==='mine_stone')&&e.path.length===0){
        if(impact) spawnParticles(hitX, hitY, e.task==='mine_gold' ? '#ffd700' : '#c0c0c0', 2, 0.02, 1.3); // sparks
        X.save();X.translate(3,-9);X.rotate(swing);
        // Long handle
        X.strokeStyle='#000000';X.lineWidth=3.4/UNIT_SCALE;X.lineCap='round';
        X.beginPath();X.moveTo(0,1);X.lineTo(9,-13);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.8/UNIT_SCALE;
        X.beginPath();X.moveTo(0,1);X.lineTo(9,-13);X.stroke();X.lineCap='butt';
        // Big curved pick head, points tapering both ways
        X.strokeStyle='#000000';X.lineWidth=5/UNIT_SCALE;X.lineCap='round';
        X.beginPath();X.moveTo(2.5,-17.5);X.quadraticCurveTo(9.5,-16,15.5,-9);X.stroke();
        X.strokeStyle='#b8bfc6';X.lineWidth=2.4/UNIT_SCALE;
        X.beginPath();X.moveTo(2.5,-17.5);X.quadraticCurveTo(9.5,-16,15.5,-9);X.stroke();
        X.lineCap='butt';
        X.restore();
      } else if(e.task==='build'&&e.path.length===0){
        if(impact) spawnParticles(e.x + e.facing*0.35, e.y - 0.1, '#cbbca0', 2, 0.015, 1.2); // dust
        X.save();X.translate(3,-9);X.rotate(swing);
        // Handle
        X.strokeStyle='#000000';X.lineWidth=3.2/UNIT_SCALE;X.lineCap='round';
        X.beginPath();X.moveTo(0,1);X.lineTo(7.5,-11);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.7/UNIT_SCALE;
        X.beginPath();X.moveTo(0,1);X.lineTo(7.5,-11);X.stroke();X.lineCap='butt';
        // Big square mallet head with a bright face
        X.fillStyle='#9aa0a6';
        X.beginPath();X.rect(4,-15.5,7,5.5);X.fill();
        X.strokeStyle='#000000';X.lineWidth=1.2/UNIT_SCALE;X.stroke();
        X.fillStyle='#fff';
        X.beginPath();X.rect(9.8,-15,1.2,4.5);X.fill();
        X.restore();
      }
      if(e.carrying>0){
        X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
        if(e.carryType==='wood'){
          // Bundle of three logs over the shoulder: two below, one on top,
          // round end grain facing the camera.
          X.save();X.translate(-6,-8);X.rotate(-0.18);
          const log=(lx,ly)=>{
            X.fillStyle='#6e473b';X.beginPath();X.rect(lx-9.5,ly-1.7,10,3.4);X.fill();X.stroke();
            X.fillStyle='#ebd2b0';X.beginPath();X.ellipse(lx+0.5,ly,1.8,2.0,0,0,Math.PI*2);X.fill();X.stroke();
            X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8/UNIT_SCALE;
            X.beginPath();X.arc(lx+0.5,ly,0.8,0,Math.PI*2);X.stroke();
            X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
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
            X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8/UNIT_SCALE; // crack
            X.beginPath();X.moveTo(bx-1.8*s,by+1.2*s);X.lineTo(bx-1.2*s,by+2.6*s);X.lineTo(bx-1.9*s,by+3.6*s);X.stroke();
            X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
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
            X.strokeStyle='#c9a227';X.lineWidth=1.4/UNIT_SCALE;
            for(let i=-2;i<=2;i++){
              X.beginPath();X.moveTo(0,3);X.lineTo(i*1.7,-4);X.stroke();
            }
            X.strokeStyle='#000';X.lineWidth=1.2/UNIT_SCALE;
            X.beginPath();X.moveTo(-1.7,1);X.lineTo(1.7,1);X.stroke();
            X.fillStyle='#e8c84a';X.strokeStyle='#000';X.lineWidth=0.8/UNIT_SCALE;
            for(let i=-2;i<=2;i++){
              X.beginPath();X.ellipse(i*1.7,-4.7,0.9,1.7,i*0.15,0,Math.PI*2);X.fill();X.stroke();
            }
            X.restore();
          } else {
            // Armful of big glossy berries
            X.fillStyle='#cc3344';X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
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
      X.strokeStyle='#000000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
      X.fillStyle='#a8adb3';X.beginPath();
      X.moveTo(shx-4.2, shy-5.5);X.lineTo(shx+4.2, shy-5.5);
      X.lineTo(shx+5.6, shy);X.lineTo(shx, shy+8.5);X.lineTo(shx-5.6, shy);X.closePath();X.fill();X.stroke();
      X.fillStyle=tc;X.beginPath();
      X.fillRect(shx-4.2, shy-0.8, 8.4, 1.7);
      X.fillRect(shx-0.85, shy-4.5, 1.7, 9);
      X.strokeStyle='#000000';X.lineWidth=0.8/UNIT_SCALE;X.stroke();
    } else if(e.utype==='spearman'){
      // Long spear with a big leaf-shaped head; the thrust is shaped —
      // slow pull-back, fast jab along the shaft.
      let swinging=e.target&&e.path.length===0;
      X.save(); X.translate(3, -6+humanYOffset);
      if(swinging){
        // Point the shaft at the target: the spear is drawn along -45°
        // locally, so rotating by aim+45° lays it on the attack line; the
        // thrust offset below is along the shaft, so it follows for free.
        X.rotate(aimAngle()+Math.PI/4);
        let ph=((tick*0.07+e.id*0.4)%1+1)%1;
        let u=ph<0.72?ph/0.72:1-(ph-0.72)/0.28;
        let off=-2.5*u+4.5*(1-u);
        X.translate(off*0.75, -off*0.75);
      }
      X.strokeStyle='#000'; X.lineWidth=3.2/UNIT_SCALE; X.lineCap='round';
      X.beginPath(); X.moveTo(-8, 10); X.lineTo(12, -10); X.stroke();
      X.strokeStyle='#8B4513'; X.lineWidth=1.6/UNIT_SCALE;
      X.beginPath(); X.moveTo(-8, 10); X.lineTo(12, -10); X.stroke();
      X.lineCap='butt';
      X.fillStyle='#dde3ea'; X.strokeStyle='#000'; X.lineWidth=1.1/UNIT_SCALE; X.lineJoin='round';
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
      if(swinging) X.rotate(aimAngle()); // bow + nocked arrow point at the target
      // Thick recurve limbs
      X.strokeStyle='#000'; X.lineWidth=4.2/UNIT_SCALE; X.lineCap='round';
      X.beginPath(); X.arc(0, 0, 10, -Math.PI/2.15, Math.PI/2.15); X.stroke();
      X.strokeStyle='#8B4513'; X.lineWidth=2.3/UNIT_SCALE;
      X.beginPath(); X.arc(0, 0, 10, -Math.PI/2.15, Math.PI/2.15); X.stroke();
      X.lineCap='butt';
      let tipX = 10*Math.cos(Math.PI/2.15), tipY = 10*Math.sin(Math.PI/2.15);
      if(swinging && ph < 0.72){
        let d = ph/0.72;
        let pull = -2 - 5.5*d;
        // Drawn string
        X.strokeStyle='#e8e8e8'; X.lineWidth=1/UNIT_SCALE;
        X.beginPath(); X.moveTo(tipX, -tipY); X.lineTo(pull, 0); X.lineTo(tipX, tipY); X.stroke();
        // Nocked arrow: thick shaft, steel head, red fletching
        X.strokeStyle='#000'; X.lineWidth=2.6/UNIT_SCALE; X.lineCap='round';
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull+16, 0); X.stroke();
        X.strokeStyle='#f5f2e9'; X.lineWidth=1.3/UNIT_SCALE;
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull+16, 0); X.stroke();
        X.lineCap='butt';
        X.fillStyle='#dde3ea'; X.strokeStyle='#000'; X.lineWidth=1/UNIT_SCALE;
        X.beginPath(); X.moveTo(pull+18.5, 0); X.lineTo(pull+13.6, -2.5); X.lineTo(pull+13.6, 2.5); X.closePath(); X.fill(); X.stroke();
        X.fillStyle='#cc4444';
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull-3.2, -2.8); X.lineTo(pull+1.4, -0.5); X.closePath(); X.fill();
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull-3.2, 2.8); X.lineTo(pull+1.4, 0.5); X.closePath(); X.fill();
      } else {
        // String at rest — vibrates briefly right after the release
        let vib = swinging ? Math.sin(tick*1.2)*2.2*(1-(ph-0.72)/0.28) : 0;
        X.strokeStyle='#e8e8e8'; X.lineWidth=1/UNIT_SCALE;
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
    X.strokeStyle='#000'; X.lineWidth=2.6/UNIT_SCALE; X.lineCap='round'; X.stroke();
    X.strokeStyle='#8a8378'; X.lineWidth=1.3/UNIT_SCALE; X.stroke(); X.lineCap='butt';
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
      X.strokeStyle='#000'; X.lineWidth=1/UNIT_SCALE;
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
      X.strokeStyle='#4e8c2d'; X.lineWidth=1.2/UNIT_SCALE;
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

  // HP bar floats clear above the head (higher for the scout — horse and
  // rider stand taller) so it never covers the unit's face.
  if(e.hp<e.maxHp){
    let hpTop = e.utype==='scout' ? sy-40*UNIT_SCALE : sy-30*UNIT_SCALE;
    X.fillStyle='#000000';X.fillRect(sx-9,hpTop,18,5);
    X.fillStyle='#300';X.fillRect(sx-8,hpTop+1,16,3);
    X.fillStyle=e.hp/e.maxHp>0.5?'#0c0':'#c00';X.fillRect(sx-8,hpTop+1,16*e.hp/e.maxHp,3);
  }
  // Selection is drawn separately, in drawUnitOutlines() — a final
  // pass after every building this frame, so it stays visible even when a
  // building is painted over this unit later in the depth sort (see there
  // for why: this codebase has no z-buffer, just one Y-sorted paint pass).
  // Idle indicator — keep showing while walking too, as long as no
  // task/target is actually assigned (a bare move order isn't "working").
  if(e.team===0&&e.utype==='villager'&&!e.task&&!e.target){
    X.fillStyle='#ffd700';X.strokeStyle='#000';X.lineWidth=2; // absolute coords — not under UNIT_SCALE
    X.font='bold 16px sans-serif';X.textAlign='center';
    X.strokeText('?',sx,sy-20*UNIT_SCALE);
    X.fillText('?',sx,sy-20*UNIT_SCALE);
  }
}

