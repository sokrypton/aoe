// Mounted units share the scout's horse rendering; the knight swaps the
// coat/rider styling (see the knight accents in the shared branches).
function isMountedUnit(t){ return t === 'scout' || t === 'knight'; }

// Accent metal by the owner's age: dull iron -> steel -> polished steel.
// The subtle unit-side 'age look' (shields, helms).
const AGE_METAL = ['#8f8a7d', '#a8adb3', '#c6cdd8'];
function ageMetal(team){
  return AGE_METAL[(teamAge && isPlayerTeam(team)) ? teamAge[team] : 0];
}

// Big readable broadsword, drawn with the context translated to the grip.
// Combat swing is shaped: slow overhead wind-up, fast slash (like the
// villagers' work swing) instead of a symmetric sine wobble.
// Shaped slash cycle shared by the sword and the arm that swings it:
// slow windup over the shoulder → whip-fast strike (ease-out cubic) with
// a small overshoot settle → smooth recovery back to guard.
function swordSwingAngle(id){
  let ph=((tick*0.05+id*0.4)%1+1)%1;
  if(ph<0.35){let t=ph/0.35;return 0.5+0.65*t*t;}                        // windup -> 1.15
  if(ph<0.52){let t=(ph-0.35)/0.17;return 1.15-2.5*(1-Math.pow(1-t,3));} // strike -> -1.35
  if(ph<0.68){let t=(ph-0.52)/0.16;return -1.35+0.25*t;}                 // settle -> -1.1
  let t=(ph-0.68)/0.32;return -1.1+1.6*(t*t*(3-2*t));                    // recover -> 0.5
}

function drawBigSword(swinging, id){
  if(swinging){
    X.rotate(swordSwingAngle(id));
  } else X.rotate(0.5); // rest: blade leans outward, away from the head
  X.strokeStyle='#000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
  // Same design as the barracks' crossed-swords emblem: parallel-edged
  // blade tapering to a point, rounded gold crossguard, leather grip,
  // gold pommel.
  // Blade with point — single flat white, no fuller
  X.fillStyle='#f5f2e9';
  X.beginPath();
  X.moveTo(-1.7,-2);X.lineTo(-1.4,-17);X.lineTo(0.5,-22);
  X.lineTo(2.4,-17);X.lineTo(2.7,-2);X.closePath();X.fill();X.stroke();
  // Rounded gold crossguard
  X.strokeStyle='#000';X.lineWidth=3.2/UNIT_SCALE;X.lineCap='round';
  X.beginPath();X.moveTo(-4.2,-0.7);X.lineTo(5.2,-0.7);X.stroke();
  X.strokeStyle='#daa520';X.lineWidth=1.8/UNIT_SCALE;
  X.beginPath();X.moveTo(-3.9,-0.7);X.lineTo(4.9,-0.7);X.stroke();
  // Grip
  X.strokeStyle='#000';X.lineWidth=3/UNIT_SCALE;
  X.beginPath();X.moveTo(0.5,0);X.lineTo(0.5,5.6);X.stroke();
  X.strokeStyle='#5c3d24';X.lineWidth=1.6/UNIT_SCALE;
  X.beginPath();X.moveTo(0.5,0);X.lineTo(0.5,5.4);X.stroke();
  X.lineCap='butt';
  // Pommel
  X.fillStyle='#daa520';X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
  X.beginPath();X.arc(0.5,6.6,1.5,0,Math.PI*2);X.fill();X.stroke();
}

// Uniform size multiplier for every drawn character (units and corpses).
const UNIT_SCALE = 1.25;

function drawCorpse(c){
  let iso=toIso(c.x,c.y);
  let sx=Math.round(iso.ix-camX+W/2), sy=Math.round(iso.iy-camY+topH+H/2+HALF_TH);
  if(isOffscreen(sx,sy,50))return;
  
  let { ox, oy } = getUnitGroupOffset(c.id);
  sx += ox; sy += oy;
  let tc=teamColor(c.team);
  
  let age = performance.now() - c.deathTime;

  // AoE2-style death sequence, staged instead of popping in flat:
  // (1) 0-600ms the body topples over its feet, accelerating, with a small
  //     impact recoil and dust puff;
  // (2) blood seeps out from under it and spreads over ~2s, drying to a
  //     brown stain over time;
  // (3) the corpse lies solid, per-unit-type art (a scout dies WITH its
  //     horse, a bear is a bear-sized mound);
  // (4) at CORPSE_SKEL it decays to bones (AoE2 skeleton stage), and only
  //     fades away in the last seconds of CORPSE_LIFE.
  const TOPPLE = 600;
  let p = Math.min(1, age / TOPPLE);
  let rot = (Math.PI / 2.25) * p * p; // accelerating fall
  if (age > TOPPLE && age < TOPPLE + 300) {
    rot *= 1 + 0.07 * Math.sin((age - TOPPLE) / 300 * Math.PI); // impact recoil
  }
  let alpha = age < CORPSE_LIFE - 3000 ? 1 : Math.max(0, 1 - (age - (CORPSE_LIFE - 3000)) / 3000);
  let big = isMountedUnit(c.utype) || c.utype === 'bear'; // horse/bear-sized corpse

  // Impact dust puff, once, the moment the body hits the ground (same
  // render-side particle spawning the sheep's grass nibbling uses).
  // Tracked in corpseImpactFxDone (js/core.js), not a `c.impactFx` field —
  // corpses get wholesale-replaced by every sync, which used to wipe that
  // flag and re-trigger the puff repeatedly instead of once.
  if (age >= TOPPLE && !corpseImpactFxDone.has(c.id)) {
    corpseImpactFxDone.add(c.id);
    spawnParticles(c.x, c.y, 'rgba(140,120,90,0.7)', big ? 7 : 4, 0.02, big ? 2.2 : 1.6);
  }

  X.save();
  X.globalAlpha = alpha;

  // 1. Blood pool seeps out from under the body after impact, then dries
  //    from fresh red to a brown stain as the corpse ages
  let bp = Math.max(0, Math.min(1, (age - TOPPLE * 0.7) / 2000));
  if (bp > 0) {
    let spread = (1 - (1 - bp) * (1 - bp)) * (big ? 1.4 : 1); // ease-out growth
    let dry = Math.max(0, Math.min(1, (age - 8000) / 8000));
    let poolA = 0.7 * Math.min(1, bp * 3) * (1 - dry * 0.55);
    X.fillStyle = 'rgba(' + Math.round(120 - 40*dry) + ', ' + Math.round(25*dry) + ', ' + Math.round(10*dry) + ', ' + poolA.toFixed(3) + ')';
    X.beginPath();
    X.ellipse(sx, sy + 3, 9*UNIT_SCALE*spread, 4.5*UNIT_SCALE*spread, 0, 0, Math.PI * 2);
    X.fill();
  }

  // 2. Skeleton decay stage (AoE2): after CORPSE_SKEL the body is bones,
  //    laid out flat by the same over-the-feet rotation the corpse used.
  //    Humans get a round skull with two sockets and a ribcage; the horse
  //    gets a full side-view horse skeleton (long muzzled skull on neck
  //    vertebrae, arched spine, hanging ribcage, four leg bones, tail) at
  //    the living horse's size, with the rider's small skeleton beside it.
  if (age >= CORPSE_SKEL) {
    X.translate(sx, sy);
    X.scale(c.facing * UNIT_SCALE, UNIT_SCALE);
    X.rotate(Math.PI / 2.25);
    const BONE='#e8e4d8';
    const humanSkeleton=(ox2,oy2,ss)=>{
      X.save();X.translate(ox2,oy2);
      X.fillStyle=BONE;
      X.beginPath();X.arc(0,-9*ss,2.8*ss,0,Math.PI*2);X.fill(); // skull — plain bone white, matching the ribs
      X.fillStyle='#000';
      X.beginPath();X.arc(-0.9*ss,-9.3*ss,0.55*ss,0,Math.PI*2);X.fill();   // eye sockets
      X.beginPath();X.arc(0.9*ss,-9.3*ss,0.55*ss,0,Math.PI*2);X.fill();
      X.strokeStyle=BONE;X.lineWidth=1.4/UNIT_SCALE;
      X.beginPath();X.moveTo(0,-6*ss);X.lineTo(0,1*ss);X.stroke();         // spine
      for(let i=0;i<3;i++){
        X.beginPath();X.arc(0,(-4.5+i*2)*ss,2.2*ss,0.15*Math.PI,0.85*Math.PI);X.stroke();
      }
      X.restore();
    };
    const horseSkeleton=(hs)=>{
      X.save();X.scale(hs,hs); // spans the living horse's 1.35x footprint
      // Leg bones with hoof knobs, same stance as the living legs
      X.strokeStyle=BONE;X.lineWidth=1.6/UNIT_SCALE;X.lineCap='round';
      [[3.5,-4,3.9],[5.5,-4,5.9],[-4.5,-4,-4.1],[-6.5,-4,-6.1]].forEach(p=>{
        X.beginPath();X.moveTo(p[0],p[1]);X.lineTo(p[2],4.4);X.stroke();
      });
      X.lineCap='butt';
      X.fillStyle=BONE;
      [[3.9,4.4],[5.9,4.4],[-4.1,4.4],[-6.1,4.4]].forEach(p=>{
        X.beginPath();X.arc(p[0],p[1],0.9,0,Math.PI*2);X.fill();
      });
      // Arched spine from hip to withers, and the bony tail
      X.strokeStyle=BONE;X.lineWidth=1.8/UNIT_SCALE;
      X.beginPath();X.moveTo(-7,-7.5);X.quadraticCurveTo(0,-10,5,-8.5);X.stroke();
      X.lineWidth=1.2/UNIT_SCALE;
      X.beginPath();X.moveTo(-7,-7.5);X.quadraticCurveTo(-9.2,-6,-9,-1.5);X.stroke();
      // Ribcage: a proper barrel — each rib springs FROM the spine and
      // sweeps down-and-back in a long curve; longest over the chest,
      // tapering toward the hip. Rounded caps so the tips read as bone.
      X.lineWidth=1.5/UNIT_SCALE;X.lineCap='round';
      for(let i=0;i<6;i++){
        let rx=-5+i*1.7;                    // rib root along the spine
        let ry=-8.6+Math.abs(rx)*0.12;      // follows the spine's arch
        let len=4.6-Math.abs(i-3.2)*0.55;   // chest ribs longest
        X.beginPath();
        X.moveTo(rx,ry);
        X.quadraticCurveTo(rx-1.6,ry+len*0.65, rx-1.1,ry+len);
        X.stroke();
      }
      X.lineCap='butt';
      // Neck vertebrae rising to the skull
      X.lineWidth=1.8/UNIT_SCALE;
      X.beginPath();X.moveTo(5,-8.5);X.quadraticCurveTo(7,-10.5,8.3,-12.3);X.stroke();
      // Skull kept simple: one elongated bone shape + eye socket, plain
      // bone white with no outline so it matches the ribcage strokes
      X.fillStyle=BONE;
      X.beginPath();X.ellipse(10.4,-12.2,3.2,1.6,0.25,0,Math.PI*2);X.fill();
      X.fillStyle='#000';
      X.beginPath();X.arc(9.2,-12.8,0.6,0,Math.PI*2);X.fill();
      X.restore();
    };
    if(isMountedUnit(c.utype)){
      horseSkeleton(1.35);
      humanSkeleton(-11,-11,1);     // the rider, beside his horse
    } else if(c.utype==='bear'){
      // Bear remains: same construction as the horse but squatter — the
      // boulder ribcage is the read
      horseSkeleton(1.15);
    } else {
      humanSkeleton(0,0,1.25);
    }
    X.restore();
    return;
  }

  // 3. Fresh corpse: the LIVING sprite itself, toppled over its feet — no
  //    simplified stand-in art. drawUnit() applies e.corpseRot after its
  //    own transform, so the character keeps every detail (outfit, hair,
  //    held weapon, the scout's whole horse+rider) at exactly its living
  //    size; only the pose changes. The pseudo-entity is cached on the
  //    corpse and frozen (path empty, no target) so nothing animates.
  X.restore(); // blood pool used screen coords; drawUnit sets its own transform
  if(!c.pose){
    c.pose = {type:'unit', utype:c.utype, team:c.team, id:c.id, x:c.x, y:c.y,
      female:c.female, dir:7, facing:c.facing, facingNorth:false,
      path:[], target:null, buildTarget:null, task:null, followId:undefined,
      hp:1, maxHp:1, carrying:0, carryType:null,
      lastX:c.x, lastY:c.y, corpseRot:0};
  }
  c.pose.corpseRot = rot;
  X.save();
  X.globalAlpha = alpha;
  drawUnit(c.pose);

  // Dropped weapon: drawUnit suppresses the held weapon on corpse poses,
  // and here it falls as its own body — released from the HAND's position
  // the moment the unit dies, dropping under gravity at its own rate
  // (a touch slower than the 600ms body topple) while tumbling to its
  // final lying angle, with a small clatter-wobble as it lands.
  let armed = c.utype==='militia'||isMountedUnit(c.utype)||c.utype==='spearman'||c.utype==='archer';
  if (armed) {
    const WDROP = 850;
    // Held position (where the living sprite draws the weapon) -> rest
    // spot on the ground beside the body, per type. {x,y,angle}.
    const HOLD = {
      militia:  {x:6.5,  y:-6,  a:0.5},
      scout:    {x:-4.5, y:-17, a:-0.6},
      knight:   {x:-4.5, y:-17, a:-0.6},
      spearman: {x:3,    y:-6,  a:0},
      archer:   {x:4,    y:-8,  a:0}
    };
    const REST = {
      militia:  {x:10,  y:1.5, a:2.0},
      scout:    {x:-11, y:1.5, a:-2.0},
      knight:   {x:-11, y:1.5, a:-2.0},
      spearman: {x:8,   y:2,   a:0.8},
      archer:   {x:9,   y:2,   a:1.2}
    };
    let h = HOLD[c.utype], r = REST[c.utype];
    let wt = Math.min(1, age / WDROP);
    let fall = wt * wt; // gravity: accelerating drop
    let wx = h.x + (r.x - h.x) * fall;
    let wy = h.y + (r.y - h.y) * fall;
    let wa = h.a + (r.a - h.a) * fall;
    if (age > WDROP && age < WDROP + 250) {
      wa += 0.1 * Math.sin((age - WDROP) / 250 * Math.PI); // landing wobble
    }
    X.translate(sx, sy);
    X.scale(c.facing * UNIT_SCALE, UNIT_SCALE);
    X.translate(wx, wy);
    X.rotate(wa);
    if(c.utype==='spearman'){
      // The spear, lying loose (static shapes of the living spear)
      X.save();X.scale(0.8,0.8);
      X.strokeStyle='#000';X.lineWidth=3.2/UNIT_SCALE;X.lineCap='round';
      X.beginPath();X.moveTo(-8,10);X.lineTo(12,-10);X.stroke();
      X.strokeStyle='#8B4513';X.lineWidth=1.6/UNIT_SCALE;
      X.beginPath();X.moveTo(-8,10);X.lineTo(12,-10);X.stroke();
      X.lineCap='butt';
      X.fillStyle='#dde3ea';X.strokeStyle='#000';X.lineWidth=1.1/UNIT_SCALE;X.lineJoin='round';
      X.beginPath();X.moveTo(10,-12);X.lineTo(17.6,-15.6);X.lineTo(13.9,-8.1);X.closePath();X.fill();X.stroke();
      X.restore();
    } else if(c.utype==='archer'){
      // The bow, lying loose with its string at rest
      X.save();X.scale(0.85,0.85);
      X.strokeStyle='#000';X.lineWidth=4.2/UNIT_SCALE;X.lineCap='round';
      X.beginPath();X.arc(0,0,10,-Math.PI/2.15,Math.PI/2.15);X.stroke();
      X.strokeStyle='#8B4513';X.lineWidth=2.3/UNIT_SCALE;
      X.beginPath();X.arc(0,0,10,-Math.PI/2.15,Math.PI/2.15);X.stroke();
      X.lineCap='butt';
      let tipX=10*Math.cos(Math.PI/2.15), tipY=10*Math.sin(Math.PI/2.15);
      X.strokeStyle='#e8e8e8';X.lineWidth=1/UNIT_SCALE;
      X.beginPath();X.moveTo(tipX,-tipY);X.lineTo(tipX,tipY);X.stroke();
      X.restore();
    } else {
      // Militia / scout broadsword
      X.rotate(0.35);
      drawBigSword(false, c.id);
    }
  }
  X.restore();
  return;
}

// The canvas is already mirrored via X.scale(e.facing,…) when a unit faces
// left, so left-pointing directions map onto their right-pointing twins and
// only right-facing poses ever need authoring. Was copy-pasted at every
// posed-sprite branch (bear, horse legs, scout).
function mirroredDir(e){
  if (e.facing === -1) {
    if (e.dir === 2) return 0;      // SW -> SE
    if (e.dir === 3) return 7;      // W -> E
    if (e.dir === 4) return 6;      // NW -> NE
  }
  return e.dir;
}

function drawUnit(e){
  if(e.garrisonedIn)return; // hidden inside a building
  let iso=toIso(e.x,e.y);
  let sx=Math.round(iso.ix-camX+W/2), sy=Math.round(iso.iy-camY+topH+H/2+HALF_TH);
  if(isOffscreen(sx,sy,50))return;
  // Group spread: offset based on unit ID so stacked units are visible
  let { ox, oy } = getUnitGroupOffset(e.id);
  sx += ox; sy += oy;
  let tc=teamColor(e.team);
  let anim=Math.sin(tick*0.15+e.id*2);
  let isActive=e.task||e.target||e.path.length>0;

  // Shadow — not part of the body silhouette: the outline mask pass must
  // skip it or the selection ring traces the shadow blob too.
  if(!window._maskDraw){
    X.fillStyle='rgba(0,0,0,0.3)';
    X.beginPath();X.ellipse(sx,sy+2,6*UNIT_SCALE,3*UNIT_SCALE,0,0,Math.PI*2);X.fill();
  }

  // Smart Face Direction: defaults to right, automatically flips based on movement or target location
  if(e.facing===undefined) e.facing = 1;
  let targetDx = 0;
  let tx = -1, ty = -1;
  if(e.target){
    let t = entitiesById.get(e.target);
    if(t) { tx = t.x; ty = t.y; }
  } else if(e.buildTarget){
    let t = entitiesById.get(e.buildTarget);
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
    if(window._maskDraw){
      // Outline mask pass re-invokes drawUnit — it must be READ-ONLY here,
      // or selected units advance the hysteresis twice per frame (turn
      // inertia halved to ~3 frames). Render with the committed facing.
      if(e.dir !== undefined) dir = e.dir;
    } else {
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
    }

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
  // Corpse pose (see drawCorpse): the dead are drawn with this very
  // function so they keep every living detail — just toppled over their
  // feet by this rotation. corpseRot also freezes the idle animations
  // (breathing, tail swish, idle "?") so the body lies still.
  if(e.corpseRot) X.rotate(e.corpseRot);

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
    let breath = (e.path.length===0 && !attacking && !e.corpseRot) ? Math.sin(tick*0.05+e.id)*0.25 : 0;

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
    let useDir = mirroredDir(e);
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
    let humanXOffset = isMountedUnit(e.utype) ? -3 : 0;
    let humanYOffset = isMountedUnit(e.utype) ? -11 : 0;

    // When the horse faces the camera its head hangs in front of the
    // rider, so that part is deferred and drawn after the rider.
    let horseHeadFront = null;

    // The whole mount (legs + horse body) is a layer of its own: facing
    // away, the rider's forward-held sword is on the FAR side of the
    // horse too, so the mount must paint over it.
    const drawMountLayer = () => {
    if(!isMountedUnit(e.utype)) return;
    {
      // Profile / front-diagonal tail is the FARTHEST part of the horse —
      // drawn before everything (legs included) so it sits behind them.
      let useDirM = mirroredDir(e);
      if (useDirM === 7 || useDirM === 0) {
        const coatM = e.utype==='knight'?'#9a948a':'#3f2810';
        let idleM = e.path.length===0 && !e.corpseRot;
        let swishM = e.corpseRot ? 0 : Math.sin(tick*0.08+e.id)*(idleM?0.2:0.08);
        let kM = useDirM === 7 ? 1 : 0.72;
        X.save(); X.translate(0,-1); X.scale(1.35,1.35);
        X.translate(-6.6*kM,-7); X.rotate(swishM);
        X.beginPath(); X.moveTo(0,0); X.quadraticCurveTo(-2.7*kM,3,-2.2*kM,9);
        X.strokeStyle='#000'; X.lineWidth=3.4/UNIT_SCALE; X.lineCap='round'; X.stroke();
        X.strokeStyle=coatM; X.lineWidth=1.8/UNIT_SCALE; X.stroke(); X.lineCap='butt';
        X.restore();
      }
    }
    // Walking leg cycle (swinging legs with constant leg length)
    if(isMountedUnit(e.utype)){
      let walk = e.path.length>0 ? Math.sin(tick*0.45+e.id)*4.5 : 0;
      X.save(); X.translate(0,-1); X.scale(1.35,1.35); // horse is drawn larger than the rider grid
      X.beginPath();
      
      let useDir = mirroredDir(e);

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
        // Diagonal 3/4 views: the +x pair is the horse's FRONT. Facing
        // the camera (SE/SW) the front is the NEAR end — it plants lower
        // and wider while the hind pair recedes (ends higher). Facing
        // away (NE/NW) the horse's front is the FAR end, so the depths
        // swap: hind pair near/low, front pair receding/high.
        let fy = useDir === 6 ? 3.4 : 4.8; // front pair endpoint
        let ry = useDir === 6 ? 4.8 : 3.4; // rear pair endpoint
        X.moveTo(3.4, -4); X.lineTo(3.4 + walk, fy);
        X.moveTo(5.2, -4); X.lineTo(5.2 - walk, fy);
        X.moveTo(-3.2, -4); X.lineTo(-3.2 + walk, ry);
        X.moveTo(-4.8, -4); X.lineTo(-4.8 - walk, ry);
      }
      X.strokeStyle = '#000000'; X.lineWidth=3.0/UNIT_SCALE; X.lineCap='round'; X.stroke();
      // Leg color follows the coat: grey legs on the knight's white
      // charger, brown on the scout's bay
      X.strokeStyle = e.utype==='knight' ? '#b3ada1' : '#6e4520'; X.lineWidth=1.5/UNIT_SCALE; X.stroke();
      X.lineCap='butt';
      // Hooves: dark caps at each leg endpoint
      let hoofPts;
      if (useDir === 1 || useDir === 5) hoofPts=[[-3,4.4+walk],[3,4.4-walk],[-4.5,3.4-walk],[4.5,3.4+walk]];
      else if (useDir === 7) hoofPts=[[3.5+walk,4.4],[5.5-walk,4.4],[-4.5+walk,4.4],[-6.5-walk,4.4]];
      else {
        let fy = useDir === 6 ? 3.4 : 4.8, ry = useDir === 6 ? 4.8 : 3.4;
        hoofPts=[[3.4+walk,fy],[5.2-walk,fy],[-3.2+walk,ry],[-4.8-walk,ry]];
      }
      X.fillStyle='#241408';
      hoofPts.forEach(p=>{X.beginPath();X.ellipse(p[0],p[1]+0.5,1.5,1.1,0,0,Math.PI*2);X.fill();});
      X.restore();
    }
    // (human legs are drawn inside drawBodyLayer below, so a weapon held
    // behind the body when facing away is occluded by the legs too)

    // Horse drawn under the rider. The neck+head are one arched silhouette
    // (curved crest, jaw, squared muzzle) — the key to reading "horse" at
    // icon size. Idle horses nod gently, swish their tail and flick an ear.
    if(isMountedUnit(e.utype)){
      let useDir = mirroredDir(e);
      // Knight rides a darker courser; scout keeps the bay.
      // Knight rides a WHITE charger (unmistakable vs the scout's bay).
      const coat=e.utype==='knight'?'#e9e6de':'#8b5a2b', maneC=e.utype==='knight'?'#9a948a':'#3f2810';
      let idle = e.path.length===0 && !e.corpseRot;
      let nod = idle ? Math.sin(tick*0.05+e.id)*0.8 : 0;
      let swish = e.corpseRot ? 0 : Math.sin(tick*0.08+e.id)*(idle?0.2:0.08);
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
        // Profile k=1; diagonal k=0.72 — the old 0.85 was so close to the
        // profile that SW/W read as the same sprite. The 3/4 view is sold
        // by real foreshortening plus receding hindquarters (legs below).
        let k = useDir === 7 ? 1 : 0.72;
        // (tail drawn earlier in drawMountLayer, behind the legs)
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
        X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE; X.fillStyle=coat;
        X.beginPath(); X.ellipse(0,-6,6.6,4.9,0,0,Math.PI*2); X.fill(); X.stroke();
        // Tail AFTER the body: facing away, the rump is the NEAR end, so
        // the tail hangs in front of it (SE/SW draw the tail behind,
        // since there the rump is the far end).
        X.save(); X.translate(-5.8,-6.5); X.rotate(swish);
        X.beginPath(); X.moveTo(0,0); X.quadraticCurveTo(-2.7,3,-2.2,9);
        X.strokeStyle='#000'; X.lineWidth=3.4/UNIT_SCALE; X.lineCap='round'; X.stroke();
        X.strokeStyle=maneC; X.lineWidth=1.8/UNIT_SCALE; X.stroke(); X.lineCap='butt';
        X.restore();
        X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE; X.fillStyle=coat;
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
          X.fillStyle = e.utype==='knight' ? '#b8b2a6' : '#6e4520';
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
    }; // end drawMountLayer

    // Layering: hand-held weapons/tools draw BEHIND the body when the
    // unit faces away from the camera (they're on the far side of the
    // torso); shields stay on top in every facing (front arm toward the
    // camera, or slung across the back). Body and held-item drawing are
    // wrapped in closures so the invocation order can flip per facing.
    const drawBodyLayer = () => {
    if(!isMountedUnit(e.utype)){
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
    // CASTLE-age archer wears a quiver on the back: facing the camera it
    // peeks BEHIND the shoulder (drawn before the torso); facing away
    // it's strapped across the near side (drawn after, see below).
    const drawQuiver = () => {
      X.save(); X.translate(-4.2+humanXOffset,-9+humanYOffset); X.rotate(-0.3);
      X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
      // arrows peeking out: shafts + red fletchings
      X.strokeStyle='#000';X.lineWidth=1.6/UNIT_SCALE;X.lineCap='round';
      X.beginPath();X.moveTo(-0.8,-3.2);X.lineTo(-0.8,-5.4);X.moveTo(0.8,-3.2);X.lineTo(0.8,-5.6);X.stroke();
      X.lineCap='butt';
      X.fillStyle='#cc4444';
      X.beginPath();X.arc(-0.8,-5.4,0.9,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(0.8,-5.6,0.9,0,Math.PI*2);X.fill();
      // leather tube
      X.fillStyle='#7a5230';X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
      X.beginPath();X.rect(-1.8,-3.6,3.6,7.2);X.fill();X.stroke();
      X.restore();
    };
    let hasQuiver = e.utype==='archer' && ageBonus(e.team) >= 2;
    if (hasQuiver && !e.facingNorth) drawQuiver();

    // Torso
    X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
    if(e.utype==='villager'&&e.female){
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
      // Militia mid-slash: the sword arm follows the pumping sword hand
      // (same swing phase as drawBigSword) instead of hanging loose.
      let slashing = e.utype==='militia' && e.path.length===0 && e.target && !e.corpseRot;
      let sA = slashing ? Math.sin(swordSwingAngle(e.id)) : 0;
      X.moveTo(3.5+humanXOffset,-8+humanYOffset);
      if(gripping) X.lineTo(3,-8.8);
      else if(slashing) X.lineTo(5.8+humanXOffset-1.4*sA, -5.8+humanYOffset-1.4*sA);
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
      if(e.utype==='militia' && ageBonus(e.team) === 1){
        // Back of the FEUDAL militia kettle hat (same as the spearman's):
        // dome first, brim on top — the near side of the brim crosses
        // the head when seen from behind.
        X.fillStyle=ageMetal(e.team);
        X.beginPath();X.arc(humanXOffset,-14.5+humanYOffset,4,0,Math.PI*2);X.fill();X.stroke();
        X.beginPath();X.ellipse(humanXOffset,-13.2+humanYOffset,5.4,1.5,0,0,Math.PI*2);X.fill();X.stroke();
      } else if(e.utype==='militia' && ageBonus(e.team) >= 2){
        // Back of the CASTLE Norman helm.
        X.fillStyle=ageMetal(e.team);
        X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.5,0,Math.PI*2);X.fill();X.stroke();
        X.save();
        X.strokeStyle='rgba(0,0,0,0.22)';X.lineWidth=1/UNIT_SCALE;
        X.beginPath();X.moveTo(humanXOffset,-18.4+humanYOffset);X.lineTo(humanXOffset,-14.6+humanYOffset);X.stroke();
        X.strokeStyle='rgba(255,255,255,0.5)';X.lineWidth=1.2/UNIT_SCALE;X.lineCap='round';
        X.beginPath();X.arc(humanXOffset,-14+humanYOffset,3.3,Math.PI*1.15,Math.PI*1.55);X.stroke();
        X.lineCap='butt';X.restore();
        X.fillStyle='#daa520';
        X.beginPath();X.rect(-4.5+humanXOffset,-14.5+humanYOffset,9,1.5);X.fill();X.stroke();
        X.fillStyle='rgba(0,0,0,0.45)';
        [-3,0,3].forEach(rx=>{X.beginPath();X.arc(humanXOffset+rx,-13.75+humanYOffset,0.4,0,Math.PI*2);X.fill();});
      } else if(e.utype==='archer') {
        // Back of archer hood — same at every age (quiver is the tell)
        X.fillStyle='#2e8b57';
        X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.5,0,Math.PI*2);X.fill();X.stroke();
      } else if(e.utype==='spearman') {
        X.fillStyle=ageMetal(e.team);
        if (ageBonus(e.team) >= 2) {
          // Back of the Castle Norman helm — same as the militia's
          X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.5,0,Math.PI*2);X.fill();X.stroke();
          X.save();
          X.strokeStyle='rgba(0,0,0,0.22)';X.lineWidth=1/UNIT_SCALE;
          X.beginPath();X.moveTo(humanXOffset,-18.4+humanYOffset);X.lineTo(humanXOffset,-14.6+humanYOffset);X.stroke();
          X.strokeStyle='rgba(255,255,255,0.5)';X.lineWidth=1.2/UNIT_SCALE;X.lineCap='round';
          X.beginPath();X.arc(humanXOffset,-14+humanYOffset,3.3,Math.PI*1.15,Math.PI*1.55);X.stroke();
          X.lineCap='butt';X.restore();
          X.fillStyle='#daa520';
          X.beginPath();X.rect(-4.5+humanXOffset,-14.5+humanYOffset,9,1.5);X.fill();X.stroke();
          X.fillStyle='rgba(0,0,0,0.45)';
          [-3,0,3].forEach(rx=>{X.beginPath();X.arc(humanXOffset+rx,-13.75+humanYOffset,0.4,0,Math.PI*2);X.fill();});
        } else {
          // Back of the Feudal kettle hat: dome first, brim ON TOP — seen
          // from behind, the near side of the brim crosses the head.
          X.beginPath();X.arc(humanXOffset,-14.5+humanYOffset,4,0,Math.PI*2);X.fill();X.stroke();
          X.beginPath();X.ellipse(humanXOffset,-13.2+humanYOffset,5.4,1.5,0,0,Math.PI*2);X.fill();X.stroke();
        }
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
      } else if(e.utype==='knight') {
        // Back of the blocky great helm: plume + crown band, no slit
        let hx = humanXOffset, hy = humanYOffset;
        X.fillStyle=tc;
        X.beginPath();
        X.moveTo(hx-1.2,-18.5+hy);
        X.quadraticCurveTo(hx-2.2,-21.5+hy,hx,-22.3+hy);
        X.quadraticCurveTo(hx+2.2,-21.5+hy,hx+1.2,-18.5+hy);
        X.closePath();X.fill();X.stroke();
        X.fillStyle=ageMetal(e.team);
        X.beginPath();X.rect(hx-4,-18.5+hy,8,7.5);X.fill();X.stroke();
        X.fillStyle='rgba(255,255,255,0.28)';
        X.fillRect(hx-4,-18.5+hy,8,1.6);
      } else if (e.utype==='scout' && ageBonus(e.team) >= 2) {
        // Back of the Castle spiked cavalry helm
        X.fillStyle=ageMetal(e.team);
        X.beginPath();
        X.moveTo(humanXOffset-0.8,-17.6+humanYOffset);
        X.lineTo(humanXOffset,-20.4+humanYOffset);
        X.lineTo(humanXOffset+0.8,-17.6+humanYOffset);
        X.closePath();X.fill();X.stroke();
        X.beginPath();X.arc(humanXOffset,-17.7+humanYOffset,0.9,0,Math.PI*2);X.fill();X.stroke(); // spike ball base
        X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.2,0,Math.PI*2);X.fill();X.stroke();
        // hard BLACK rim line at the helm's lower edge
        X.beginPath();X.moveTo(humanXOffset-3.7,-12+humanYOffset);X.lineTo(humanXOffset+3.7,-12+humanYOffset);X.stroke();
        X.save();
        X.strokeStyle='rgba(255,255,255,0.5)';X.lineWidth=1.1/UNIT_SCALE;X.lineCap='round';
        X.beginPath();X.arc(humanXOffset,-14+humanYOffset,3,Math.PI*1.15,Math.PI*1.55);X.stroke();
        X.lineCap='butt';X.restore();
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
      if(e.utype==='militia' && ageBonus(e.team) === 1){
        // FEUDAL militia: same tilted iron kettle hat as the spearman —
        // the levy gets standard-issue gear; the Norman helm below is the
        // Castle upgrade. (Dark age falls through to the peasant hood.)
        X.fillStyle=ageMetal(e.team);
        X.beginPath();X.ellipse(humanXOffset,-16.2+humanYOffset,5.4,1.5,0,0,Math.PI*2);X.fill();X.stroke();
        X.beginPath();X.arc(humanXOffset,-15.4+humanYOffset,3.8,Math.PI,0);X.fill();X.stroke();
      } else if(e.utype==='militia' && ageBonus(e.team) >= 2){
        // CASTLE militia: Norman iron helm with gold band + nose bar.
        X.fillStyle=ageMetal(e.team);
        X.beginPath();X.arc(humanXOffset,-15+humanYOffset,4.5,Math.PI,0);X.fill();X.stroke();
        // dome ridge + upper-left highlight for volume
        X.save();
        X.strokeStyle='rgba(0,0,0,0.22)';X.lineWidth=1/UNIT_SCALE;
        X.beginPath();X.moveTo(humanXOffset,-19.4+humanYOffset);X.lineTo(humanXOffset,-15.2+humanYOffset);X.stroke();
        X.strokeStyle='rgba(255,255,255,0.5)';X.lineWidth=1.2/UNIT_SCALE;X.lineCap='round';
        X.beginPath();X.arc(humanXOffset,-15+humanYOffset,3.3,Math.PI*1.15,Math.PI*1.55);X.stroke();
        X.lineCap='butt';X.restore();
        X.fillStyle='#daa520';
        X.beginPath();X.rect(-4.5+humanXOffset,-15+humanYOffset,9,1.5);X.fill();X.stroke();
        // rivets along the band
        X.fillStyle='rgba(0,0,0,0.45)';
        [-3,0,3].forEach(rx=>{X.beginPath();X.arc(humanXOffset+rx,-14.25+humanYOffset,0.4,0,Math.PI*2);X.fill();});
        X.fillStyle=ageMetal(e.team);
        X.beginPath();X.rect(-0.75+humanXOffset,-15+humanYOffset,1.5,4);X.fill();X.stroke();
      } else if(e.utype==='archer') {
        // Green hood at every age — the archer stays simple; the Castle
        // tell is the quiver on the back.
        X.fillStyle='#2e8b57';
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
      } else if (e.utype==='knight') {
        // Blocky GREAT HELM — flat-topped box covering the whole face.
        // Detail pass: team-color plume on top, riveted crown band,
        // vertical face ridge crossing the dark eye slit, breath holes.
        let hx = humanXOffset, hy = humanYOffset;
        // plume tuft first, so the helm's outline overlaps its base
        X.fillStyle=tc;
        X.beginPath();
        X.moveTo(hx-1.2,-18.5+hy);
        X.quadraticCurveTo(hx-2.2,-21.5+hy,hx,-22.3+hy);
        X.quadraticCurveTo(hx+2.2,-21.5+hy,hx+1.2,-18.5+hy);
        X.closePath();X.fill();X.stroke();
        X.fillStyle=ageMetal(e.team);
        X.beginPath();X.rect(hx-4,-18.5+hy,8,7.5);X.fill();X.stroke();
        // crown band across the top (slightly brighter strip)
        X.fillStyle='rgba(255,255,255,0.28)';
        X.fillRect(hx-4,-18.5+hy,8,1.6);
        // vertical face ridge (the cross's upright)
        X.strokeStyle='rgba(0,0,0,0.3)';X.lineWidth=1.1/UNIT_SCALE;
        X.beginPath();X.moveTo(hx,-16.9+hy);X.lineTo(hx,-11+hy);X.stroke();
        X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
        // dark eye slit (the cross's arms)
        X.fillStyle='#1c1c1c';
        X.fillRect(hx-2.6,-15.4+hy,5.2,1.2);
        // breathing holes low on the face
        X.fillStyle='rgba(0,0,0,0.45)';
        X.beginPath();X.arc(hx-1.6,-12.4+hy,0.4,0,Math.PI*2);X.fill();
        X.beginPath();X.arc(hx,-12.4+hy,0.4,0,Math.PI*2);X.fill();
        X.beginPath();X.arc(hx+1.6,-12.4+hy,0.4,0,Math.PI*2);X.fill();
      } else if (e.utype==='spearman') {
        X.fillStyle=ageMetal(e.team);
        if (ageBonus(e.team) >= 2) {
          // CASTLE: same Norman helm as the militia — dome with ridge and
          // highlight, riveted gold band, nose bar.
          X.beginPath();X.arc(humanXOffset,-15+humanYOffset,4.5,Math.PI,0);X.fill();X.stroke();
          X.save();
          X.strokeStyle='rgba(0,0,0,0.22)';X.lineWidth=1/UNIT_SCALE;
          X.beginPath();X.moveTo(humanXOffset,-19.4+humanYOffset);X.lineTo(humanXOffset,-15.2+humanYOffset);X.stroke();
          X.strokeStyle='rgba(255,255,255,0.5)';X.lineWidth=1.2/UNIT_SCALE;X.lineCap='round';
          X.beginPath();X.arc(humanXOffset,-15+humanYOffset,3.3,Math.PI*1.15,Math.PI*1.55);X.stroke();
          X.lineCap='butt';X.restore();
          X.fillStyle='#daa520';
          X.beginPath();X.rect(-4.5+humanXOffset,-15+humanYOffset,9,1.5);X.fill();X.stroke();
          X.fillStyle='rgba(0,0,0,0.45)';
          [-3,0,3].forEach(rx=>{X.beginPath();X.arc(humanXOffset+rx,-14.25+humanYOffset,0.4,0,Math.PI*2);X.fill();});
          X.fillStyle=ageMetal(e.team);
          X.beginPath();X.rect(-0.75+humanXOffset,-15+humanYOffset,1.5,4);X.fill();X.stroke();
        } else {
          // FEUDAL: iron kettle hat TILTED BACK on the head — the raised
          // brim sits above the brow (drawn behind the crown), leaving
          // the face and eyes fully visible.
          X.beginPath();X.ellipse(humanXOffset,-16.2+humanYOffset,5.4,1.5,0,0,Math.PI*2);X.fill();X.stroke();
          X.beginPath();X.arc(humanXOffset,-15.4+humanYOffset,3.8,Math.PI,0);X.fill();X.stroke();
        }
      } else if (e.utype==='scout' && ageBonus(e.team) >= 2) {
        // CASTLE scout: spiked cavalry helm — open face, small spike on
        // top; distinct from the knight's flat-topped great helm.
        X.fillStyle=ageMetal(e.team);
        X.beginPath();
        X.moveTo(humanXOffset-0.8,-18.6+humanYOffset);
        X.lineTo(humanXOffset,-21.4+humanYOffset);
        X.lineTo(humanXOffset+0.8,-18.6+humanYOffset);
        X.closePath();X.fill();X.stroke();
        X.beginPath();X.arc(humanXOffset,-18.7+humanYOffset,0.9,0,Math.PI*2);X.fill();X.stroke(); // spike ball base
        X.beginPath();X.arc(humanXOffset,-15+humanYOffset,4.2,Math.PI,0);X.fill();X.stroke();
        // hard BLACK lower edge so the helm/face boundary reads clearly
        X.beginPath();X.moveTo(humanXOffset-4.2,-15+humanYOffset);X.lineTo(humanXOffset+4.2,-15+humanYOffset);X.stroke();
        X.save();
        X.strokeStyle='rgba(255,255,255,0.5)';X.lineWidth=1.1/UNIT_SCALE;X.lineCap='round';
        X.beginPath();X.arc(humanXOffset,-15+humanYOffset,3,Math.PI*1.15,Math.PI*1.55);X.stroke();
        X.lineCap='butt';X.restore();
      } else {
        // Peasant leather hood cap for the scout (light cavalry)
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

    if (hasQuiver && e.facingNorth) drawQuiver();
    }; // end drawBodyLayer (the front-facing horse head is deferred
    // further: it draws after the held-items layer, so the horse's head
    // is in front of the rider AND the resting sword)

    // TRUE screen-space angle from this unit to its combat target. Used to
    // point aimed weapons (bow, spear) along the real attack line. Callers
    // must first UNDO the facing mirror (X.scale(e.facing,1) inside the
    // already-mirrored context cancels it) and then rotate by this — the
    // old version instead expressed the angle in the mirrored frame and
    // clamped it to ±1.15 rad, which meant a shot at anything steeply up/
    // down or slightly across the body rendered up to ~130° off the real
    // direction (an archer firing at a target up-screen showed its bow
    // pointing down-forward). Exact rotation needs no fold-through-body
    // clamp: the body's facing already tracks the target's horizontal
    // side, so the weapon never has to point backward more than the small
    // sector-boundary overshoot. When the target entity is gone
    // mid-swing, fall back to "straight ahead" in screen terms.
    let aimAngle = () => {
      let t = entitiesById.get(e.target);
      if (!t) return e.facing === -1 ? Math.PI : 0;
      let tcx = t.type === 'building' ? t.x + (t.w || 1) / 2 : t.x;
      let tcy = t.type === 'building' ? t.y + (t.h || 1) / 2 : t.y;
      let dix = ((tcx - e.x) - (tcy - e.y)) * HALF_TW;
      let diy = ((tcx - e.x) + (tcy - e.y)) * HALF_TH;
      if (dix === 0 && diy === 0) return e.facing === -1 ? Math.PI : 0;
      return Math.atan2(diy, dix);
    };

    // Archer variant: the LAUNCH tangent of the ballistic arc, not the flat
    // line to the target. drawProjectiles (js/render-fx.js) flies the arrow
    // along vy = Δiy − (cos(progress·π)·π·A + (endH − startH)); at
    // progress 0 that's Δiy − (π·A + endH − startH). Pointing the bow at
    // the same tangent means the nocked arrow releases exactly along the
    // real arrow's initial flight line — aiming flat at the target left a
    // visible kink at the moment of release. Constants (35, /5, startH 12,
    // endH 8) must stay in sync with spawnProjectile/drawProjectiles.
    let aimAngleBallistic = () => {
      let t = entitiesById.get(e.target);
      if (!t) return e.facing === -1 ? Math.PI : 0;
      let tcx = t.type === 'building' ? t.x + (t.w || 1) / 2 : t.x;
      let tcy = t.type === 'building' ? t.y + (t.h || 1) / 2 : t.y;
      let dix = ((tcx - e.x) - (tcy - e.y)) * HALF_TW;
      let diy = ((tcx - e.x) + (tcy - e.y)) * HALF_TH;
      let A = 35 * (Math.hypot(tcx - e.x, tcy - e.y) / 5); // arc amplitude
      diy -= Math.PI * A + (8 - 12); // + endH − startH (units launch at 12, impact at 8)
      if (dix === 0 && diy === 0) return e.facing === -1 ? Math.PI : 0;
      return Math.atan2(diy, dix);
    };

    // Tools & weapons (animated swinging swings during active tasks)
    const drawHeldLayer = () => {
    if(e.utype==='villager'){
      // Shaped work swing: slow wind-up (70% of the cycle), fast strike
      // (30%), instead of a symmetric sine wobble. swing is the tool's
      // rotation: -1.1 fully raised, +0.5 at the moment of impact.
      // "At the work site" — a villager whose task is already back to
      // chop/mine but who is still STANDING AT THE DROP-OFF (the tick after
      // depositing, or a guest waiting on the next sync) must not flash the
      // tool or swing it; require actual proximity to the work. Gather
      // tasks check the claimed gather tile, build checks the foundation's
      // footprint; other tasks are unaffected.
      let atSite = true;
      if (e.task === 'chop' || e.task === 'mine_gold' || e.task === 'mine_stone') {
        atSite = e.gatherX >= 0 &&
          Math.max(Math.abs(e.x - e.gatherX), Math.abs(e.y - e.gatherY)) < 1.8;
      } else if (e.task === 'build' && e.buildTarget) {
        let bt = entitiesById.get(e.buildTarget);
        atSite = !!bt && distToTarget(e, bt) < 1.8;
      }
      let working = isActive && e.path.length===0 && atSite;
      let phRaw = tick*0.055 + e.id*0.37;
      let ph = ((phRaw % 1) + 1) % 1;
      let u = ph < 0.7 ? ph/0.7 : 1-(ph-0.7)/0.3;
      let swing = working ? (0.5 - 1.6*u) : 0;
      // One impact burst per cycle, right as the tool lands. Detected by the
      // cycle COUNTER advancing between frames, not by a frame happening to
      // land inside the narrow strike window — at 4x speed that window (7%
      // of a ~0.15s cycle ≈ 10ms) is shorter than one frame, so impacts
      // dropped nondeterministically and the work sounds/particles
      // stuttered. Tracked in workSwingCycles (js/core.js), not
      // `e._swingCyc` — entities get wholesale-replaced by every sync,
      // which used to wipe that field and fire extras. Never during the
      // outline mask pass: it would consume this cycle's one impact (and
      // spawn duplicate particles) before the real draw.
      let swingCyc = Math.floor(phRaw);
      let prevCyc = workSwingCycles.get(e.id);
      let impact = !window._maskDraw && working && prevCyc !== undefined && swingCyc !== prevCyc;
      if(!window._maskDraw && working) workSwingCycles.set(e.id, swingCyc);
      // Impact point in tile coords: the gather tile if known, else just ahead
      let hitX = (e.gatherX >= 0 && e.gatherX !== undefined) ? e.gatherX + 0.5 : e.x + e.facing*0.4;
      let hitY = (e.gatherY >= 0 && e.gatherY !== undefined) ? e.gatherY + 0.3 : e.y;
      if(e.task==='chop'&&e.path.length===0&&atSite){
        // Sound at the axe's VISUAL impact, not at resource extraction (the
        // sim's gather cycle) — extraction lags the first visible hit by up
        // to a full cycle, which read as delayed audio. Render runs on the
        // guest too, so this also gives MP guests animation-synced chops.
        if(impact){
          spawnParticles(hitX, hitY, '#c9a15e', 2, 0.02, 1.5); // wood chips
          // At 4x the swing period drops to ~0.15s and every villager's hits
          // pile into the global rate limiter, which then drops them
          // ARBITRARILY — the texture turns inconsistent. Sounding every
          // OTHER swing at 4x restores the deterministic 2x cadence.
          if(window.playSound && (GAME_SPEED < 4 || swingCyc % 2 === 0)) playSound('chop', hitX, hitY);
        }
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
      } else if((e.task==='mine_gold'||e.task==='mine_stone')&&e.path.length===0&&atSite){
        if(impact){
          spawnParticles(hitX, hitY, e.task==='mine_gold' ? '#ffd700' : '#c0c0c0', 2, 0.02, 1.3); // sparks
          // Synced to the pick's visual impact; every other swing at 4x (see chop above)
          if(window.playSound && (GAME_SPEED < 4 || swingCyc % 2 === 0)) playSound('mine', hitX, hitY);
        }
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
      } else if(e.task==='build'&&e.path.length===0&&atSite){
        if(impact){
          spawnParticles(e.x + e.facing*0.35, e.y - 0.1, '#cbbca0', 2, 0.015, 1.2); // dust
          // Hammer audio at the mallet's visual impact; every other swing
          // at 4x (see chop above for both rationales)
          if(window.playSound && (GAME_SPEED < 4 || swingCyc % 2 === 0)) playSound('build', e.x + e.facing*0.35, e.y - 0.1);
        }
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
      // Militia broadsword (shaped combat slash). A corpse has dropped its
      // sword (drawCorpse draws it on the ground); the shield stays
      // strapped to the arm.
      if(!e.corpseRot){
        let swinging=e.target&&e.path.length===0;
        // Sword hand is fixed to the body — mirrored to the other screen
        // side when the militia faces away from the camera. While
        // swinging, the hand itself pumps with the slash (back and up on
        // the windup, forward and down on the strike).
        let fb = (!swinging && e.facingNorth) ? -1 : 1;
        let s = swinging ? Math.sin(swordSwingAngle(e.id)) : 0;
        X.save();X.translate((6.5-1.5*s)*fb,-6-1.5*s);X.scale(fb,1);
        drawBigSword(swinging, e.id);
        X.restore();
      }
      // (kite shield drawn in drawShieldLayer — always on top)
    } else if(e.utype==='spearman'&&!e.corpseRot){
      // Long spear with a big leaf-shaped head; the thrust is shaped —
      // slow pull-back, fast jab along the shaft. (Corpses drop it —
      // drawCorpse lays it on the ground.)
      let swinging=e.target&&e.path.length===0;
      X.save(); X.translate(3, -6+humanYOffset);
      if(swinging){
        // Point the shaft at the target: un-mirror first (same trick as
        // the bow above), then rotate. The spear is drawn along -45°
        // locally, so rotating by aim+45° lays it on the attack line; the
        // thrust offset below is along the shaft, so it follows for free.
        X.scale(e.facing,1);
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
    } else if(e.utype==='archer'&&!e.corpseRot){
      // Big bow with a full draw cycle: nock and pull back slowly, release,
      // string snaps forward and vibrates until the next arrow. (Corpses
      // drop it — drawCorpse lays it on the ground.)
      // The cycle is driven by the REAL reload timer (atkCooldown resets to
      // rof the moment the projectile spawns — js/logic.js), not the old
      // free-running per-id phase: the nocked arrow now releases exactly
      // when the real arrow leaves, so the flight reads as THE arrow off
      // the string. Works on the guest too — atkCooldown/target ride the
      // entity sync.
      let swinging=e.target&&e.path.length===0;
      let bowRof=(UNITS.archer&&UNITS.archer.rof)||60;
      let bowCd=e.atkCooldown||0;
      let justFired=bowCd>bowRof*0.85;                         // string still snapping forward
      let drawT=Math.min(1,Math.max(0,1-bowCd/(bowRof*0.85))); // 0 after the snap → 1 at release
      X.save(); X.translate(4, -8+humanYOffset);
      // Un-mirror (the context is under X.scale(e.facing,1); scaling by
      // e.facing again cancels it — the translate above stays mirrored so
      // the bow remains in the correct hand), then rotate to the arc's
      // LAUNCH tangent so the nocked arrow points exactly along the real
      // arrow's initial flight line (see aimAngleBallistic above).
      if(swinging){ X.scale(e.facing,1); X.rotate(aimAngleBallistic()); }
      // Thick recurve limbs — radius 8 (was 10): the bow should read as
      // carried BY the archer, not dominate the whole silhouette
      const BOW_R = 8;
      X.strokeStyle='#000'; X.lineWidth=3.6/UNIT_SCALE; X.lineCap='round';
      X.beginPath(); X.arc(0, 0, BOW_R, -Math.PI/2.15, Math.PI/2.15); X.stroke();
      X.strokeStyle='#8B4513'; X.lineWidth=2/UNIT_SCALE;
      X.beginPath(); X.arc(0, 0, BOW_R, -Math.PI/2.15, Math.PI/2.15); X.stroke();
      X.lineCap='butt';
      let tipX = BOW_R*Math.cos(Math.PI/2.15), tipY = BOW_R*Math.sin(Math.PI/2.15);
      if(swinging && !justFired){
        let pull = -1.6 - 4.4*drawT;
        // Drawn string
        X.strokeStyle='#e8e8e8'; X.lineWidth=1/UNIT_SCALE;
        X.beginPath(); X.moveTo(tipX, -tipY); X.lineTo(pull, 0); X.lineTo(tipX, tipY); X.stroke();
        // Nocked arrow: thick shaft, steel head, red fletching
        X.strokeStyle='#000'; X.lineWidth=2.4/UNIT_SCALE; X.lineCap='round';
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull+13, 0); X.stroke();
        X.strokeStyle='#f5f2e9'; X.lineWidth=1.2/UNIT_SCALE;
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull+13, 0); X.stroke();
        X.lineCap='butt';
        X.fillStyle='#dde3ea'; X.strokeStyle='#000'; X.lineWidth=1/UNIT_SCALE;
        X.beginPath(); X.moveTo(pull+15, 0); X.lineTo(pull+11, -2.1); X.lineTo(pull+11, 2.1); X.closePath(); X.fill(); X.stroke();
        X.fillStyle='#cc4444';
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull-2.6, -2.3); X.lineTo(pull+1.1, -0.4); X.closePath(); X.fill();
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull-2.6, 2.3); X.lineTo(pull+1.1, 0.4); X.closePath(); X.fill();
      } else {
        // String at rest — vibrates briefly right after the release, decaying
        // over the first 15% of the reload window
        let vib = swinging ? Math.sin(tick*1.2)*1.8*Math.max(0,(bowCd-bowRof*0.85)/(bowRof*0.15)) : 0;
        X.strokeStyle='#e8e8e8'; X.lineWidth=1/UNIT_SCALE;
        X.beginPath(); X.moveTo(tipX, -tipY); X.quadraticCurveTo(vib, 0, tipX, tipY); X.stroke();
      }
      X.restore();
    } else if(isMountedUnit(e.utype)&&!e.corpseRot){
      // Scout broadsword (same big sword as the militia, shaped slash).
      // At rest it parks on the rider's LEFT side, mirrored — the right is
      // where the horse's head rises, and the blade would point into it.
      // (Corpses drop it — drawCorpse lays it on the ground.)
      let swinging=e.target&&e.path.length===0;
      X.save();
      if(swinging){
        X.translate(6+humanXOffset, -6+humanYOffset);
        drawBigSword(true, e.id);
      } else {
        // Both riders rest the sword on the RIGHT (sword hand), angled
        // forward over the horse's shoulder. The hand is fixed to the
        // BODY: seen from behind it appears on the opposite screen side,
        // mirrored.
        let fb = e.facingNorth ? -1 : 1;
        X.translate(5.5*fb+humanXOffset, -6+humanYOffset);
        X.scale(fb,1);
        drawBigSword(false, e.id);
      }
      X.restore();
      // (knight's kite shield drawn in drawShieldLayer — always on top)
    }
    }; // end drawHeldLayer

    // Shields render on top in EVERY facing: facing the camera the shield
    // arm is the near side; facing away it reads as slung across the back
    // (which is also the near side). One shared drawing for militia
    // (Feudal+, on foot) and knight (mounted).
    // Steel kite shield with the team cross (militia Castle / knight)
    const drawKiteShield = (shx, shy) => {
      X.strokeStyle='#000000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
      X.fillStyle=ageMetal(e.team);X.beginPath();
      X.moveTo(shx-4.2, shy-5.5);X.lineTo(shx+4.2, shy-5.5);
      X.lineTo(shx+5.6, shy);X.lineTo(shx, shy+8.5);X.lineTo(shx-5.6, shy);X.closePath();X.fill();X.stroke();
      X.fillStyle=tc;X.beginPath();
      X.fillRect(shx-4.2, shy-0.8, 8.4, 1.7);
      X.fillRect(shx-0.85, shy-4.5, 1.7, 9);
      X.strokeStyle='#000000';X.lineWidth=0.8/UNIT_SCALE;X.stroke();
    };
    // Round WOODEN shield with an iron center boss (militia Feudal)
    const drawRoundShield = (shx, shy) => {
      X.strokeStyle='#000000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
      X.fillStyle='#a5723a';
      X.beginPath();X.arc(shx,shy,4.8,0,Math.PI*2);X.fill();X.stroke();
      X.fillStyle=ageMetal(e.team);
      X.beginPath();X.arc(shx,shy,1.6,0,Math.PI*2);X.fill();X.stroke();
    };
    const drawShieldLayer = () => {
      // Shield is strapped to the LEFT arm — like the sword, it mirrors
      // to the opposite screen side when the unit faces away.
      let fb = e.facingNorth ? -1 : 1;
      if (e.utype==='knight') {
        drawKiteShield(-6*fb+humanXOffset, -5+humanYOffset);
      } else if (e.utype==='militia' && ageBonus(e.team) >= 1) {
        // Feudal: round WOODEN shield; Castle: upgraded steel kite
        if (ageBonus(e.team) >= 2) drawKiteShield(-6*fb, -6);
        else drawRoundShield(-6*fb, -5);
      } else if (e.utype==='scout' && ageBonus(e.team) >= 2) {
        // Castle scout: same round wooden shield (iron boss) as the
        // Feudal militia — light cavalry carries the simple gear.
        drawRoundShield(-6*fb+humanXOffset, -5+humanYOffset);
      }
    };

    // Facing away → held weapons/tools are on the far side of the torso,
    // so the body must paint over them; facing the camera → the reverse.
    // Facing away: held items are on the far side of BOTH the horse and
    // the rider, so they draw first and everything paints over them.
    if (e.facingNorth) { drawHeldLayer(); drawMountLayer(); drawBodyLayer(); }
    else { drawMountLayer(); drawBodyLayer(); drawHeldLayer(); }
    // Front-facing horse head over rider + weapons (it's the nearest thing
    // to the camera); shield last — worn on the near arm.
    if (horseHeadFront) horseHeadFront();
    drawShieldLayer();
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
      let useDir = mirroredDir(e);
      if (useDir === 7)      { headX = 6.5; headY = -3.5; sheepHead(headX, headY, 'side'); }
      else if (useDir === 0) { headX = 5.5; headY = -1.5; sheepHead(headX, headY, 'side'); }
      else                   { headX = 3.5; headY = -7.5; sheepHead(headX, headY, 'back'); }
    }

    if(e.eatingGrass){
      X.strokeStyle='#4e8c2d'; X.lineWidth=1.2/UNIT_SCALE;
      X.beginPath();X.moveTo(headX,headY+1.2);X.lineTo(headX+4,headY+3);X.stroke();
      X.beginPath();X.moveTo(headX-0.5,headY+1.5);X.lineTo(headX+3,headY+4);X.stroke();
      
      // Spawn tiny grass particle puffs (not in the outline mask pass —
      // a SELECTED grazing sheep used to double-spawn them)
      if(tick % 24 === 0 && !window._maskDraw){
        spawnParticles(e.x + (e.facing * 0.25), e.y + 0.1, '#4e8c2d', 1, 0.008, 0.9);
      }
    }
    X.restore();
  }

  X.restore(); // restore to absolute coordinates so text and UI aren't mirrored

  // Floating overlays (HP bar, idle "?") are NOT part of the body silhouette
  // — skip them in the outline mask pass, or a wounded selected unit gets a
  // detached gold ring hovering around its HP bar rectangle.
  if(window._maskDraw) return;

  // HP bar floats clear above the head (higher for the scout — horse and
  // rider stand taller) so it never covers the unit's face.
  if(e.hp<e.maxHp){
    let hpTop = isMountedUnit(e.utype) ? sy-40*UNIT_SCALE : sy-30*UNIT_SCALE;
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
  if(e.team===myTeam&&e.utype==='villager'&&!e.task&&!e.target&&!e.corpseRot){
    X.fillStyle='#ffd700';X.strokeStyle='#000';X.lineWidth=2; // absolute coords — not under UNIT_SCALE
    X.font='bold 16px sans-serif';X.textAlign='center';
    X.strokeText('?',sx,sy-20*UNIT_SCALE);
    X.fillText('?',sx,sy-20*UNIT_SCALE);
  }
}

