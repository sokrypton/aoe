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

// Should this unit be showing its attack/harvest ANIMATION right now? The
// animation must match what the sim actually DOES: the sim only deals damage /
// harvests when the unit is genuinely in range (see updateUnit — damageEntity
// gated by adjToBuilding / distToTarget<=range, harvest by SHEEP_HARVEST_RANGE).
// The old gates ("has a target and is standing still") let a unit that halted
// just OUTSIDE range — or a surplus attacker with no reachable slot — swing at
// thin air with nothing happening. This mirrors the sim's range checks EXACTLY,
// so a swing always coincides with a real hit. Render-only: reads sim state,
// never writes it.
function inActionRange(e){
  if(e.__animAttack) return true;            // style-gallery preview swings freely
  if(!e.target) return false;
  let t = entitiesById.get(e.target);
  if(!t || t.hp<=0) return false;
  let range = (typeof UNITS!=='undefined' && UNITS[e.utype] && UNITS[e.utype].range) || 0;
  if(t.type==='building') return range>0 ? distToTarget(e,t)<=range : adjToBuilding(e.x,e.y,t);
  let maxD = range>0 ? range
           : (e.utype==='villager' && (t.utype==='sheep'||t.utype==='sheep_carcass')) ? SHEEP_HARVEST_RANGE : 1.5;
  return distToTarget(e,t)<=maxD;
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

// ---- skeleton decay art (shared by drawCorpse and the trade cart wreck) ----
const BONE='#e8e4d8';
function drawHumanSkeleton(ox2,oy2,ss){
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
}
function drawHorseSkeleton(hs){
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
}

// ---- vehicle wreck helpers (trade cart + battering ram death) ----
// Projection basis for a vehicle corpse: the same RAM_AXES bases the live
// art uses, resolved from the corpse's stored dir/facing — 5 authored bases
// + the sprite mirror give every death facing without per-view authoring.
function corpseVehicleAxes(c){
  let d = mirroredDir({ dir: c.dir !== undefined ? c.dir : 7, facing: c.facing || 1 });
  if (d === 7) return SIDE_AXES; // E/W wrecks lie in true side elevation
  return RAM_AXES[d] || SIDE_AXES;
}
// One detached wheel at the origin of the current (vehicle-scaled) space:
// squash 0.85 ≈ still upright on its rim → 0.5 = lying flat on the ground.
// Style matches the vehicle's LIVE wheels: the cart's are open spoked rims,
// the ram's are solid wooden discs with a single spoke line (`solid`).
function drawFallenWheel(R, squash, seed, weathered, lw, solid){
  X.save(); X.scale(1, squash);
  if (solid) {
    X.fillStyle=weathered?'#8d8271':'#5a4630'; X.strokeStyle='#000'; X.lineWidth=lw;
    X.beginPath();X.arc(0,0,R,0,Math.PI*2);X.fill();X.stroke();
    X.strokeStyle=weathered?'#6f675a':'#3a2c1c'; X.lineWidth=1/UNIT_SCALE;
    X.beginPath();X.moveTo(-Math.cos(seed)*R*0.8,-Math.sin(seed)*R*0.8);X.lineTo(Math.cos(seed)*R*0.8,Math.sin(seed)*R*0.8);X.stroke();
  } else {
    // see-through chariot ring: rim annulus + spokes, open between them
    X.beginPath();
    X.arc(0,0,R,0,Math.PI*2); X.arc(0,0,R-1.5,0,Math.PI*2,true);
    X.fillStyle=weathered?'#8d8271':'#6b543a'; X.fill('evenodd');
    X.strokeStyle='#000'; X.lineWidth=lw;
    X.beginPath();X.arc(0,0,R,0,Math.PI*2);X.stroke();
    X.beginPath();X.arc(0,0,R-1.5,0,Math.PI*2);X.stroke();
    X.strokeStyle=weathered?'#9a917f':'#8a6a4a'; X.lineWidth=1.3/UNIT_SCALE;
    for(let k=0;k<3;k++){
      let A=seed+k*Math.PI/3;
      X.beginPath();X.moveTo(-Math.cos(A)*R*0.85,-Math.sin(A)*R*0.85);X.lineTo(Math.cos(A)*R*0.85,Math.sin(A)*R*0.85);X.stroke();
    }
  }
  X.fillStyle=weathered?'#9a917f':'#8a6a4a';
  X.strokeStyle='#000'; X.lineWidth=0.7/UNIT_SCALE;
  X.beginPath();X.arc(0,0,R*0.24,0,Math.PI*2);X.fill();X.stroke();
  X.restore();
}

// Trade cart death — a staged physical fall in the cart's own projection
// basis (facing-aware, not a canonical morph):
//   wheels tip off their axles one by one (0–~600ms, staggered) →
//   the unsupported bed drops to the ground with a dust thud (~280–580ms) →
//   the walls and end boards fold outward flat (~600–1050ms), the cargo
//   tumbling out beside the bed (gold scatter on the loaded leg).
// The ox buckles separately (rigid topple, +350ms). At CORPSE_SKEL the wood
// weathers gray in place (the final fold layout IS the decay layout — no
// pop) and the cargo is gone. Render-only; one-time particle bursts gated
// through corpseImpactFxDone so lockstep resyncs don't re-fire them.
function drawTradeCartCorpse(c, sx, sy, age, alpha){
  const { L, WB, CB, CH, WR, WA, WTH, SCALE } = CART_DIM;
  const OXDELAY=350, OXFALL=700;
  const WDUR=320, BSTART=280, BDUR=300, CSTART=600, CDUR=450;
  let ax = corpseVehicleAxes(c), u = ax.u, v = ax.v;
  let P = (a,b,h) => ({ x:a*u.x + b*v.x, y:a*u.y + b*v.y - h });
  let vlen = Math.hypot(v.x, v.y), ulen = Math.hypot(u.x, u.y);
  let clamp01 = x => Math.min(1, Math.max(0, x));
  let eo = t => 1-(1-t)*(1-t);                 // ease-out (folding to rest)
  let jit = n => { let s=Math.sin(c.id*7.3+n*13.7)*43758.5453; return s-Math.floor(s)-0.5; };
  let weathered = age >= CORPSE_SKEL;
  let tc = teamColor(c.team);

  if (!corpseImpactFxDone.has(c.id)) {
    corpseImpactFxDone.add(c.id);
    spawnParticles(c.x, c.y, '#c9a15e', 8, 0.04, 1.8);              // wood chips
    spawnParticles(c.x, c.y, 'rgba(140,120,90,0.7)', 5, 0.02, 1.8); // dust
  }
  if (age >= BSTART+BDUR && !corpseImpactFxDone.has(c.id+':thud')) {
    corpseImpactFxDone.add(c.id+':thud');
    spawnParticles(c.x, c.y, 'rgba(140,120,90,0.7)', 6, 0.03, 2.0); // bed hits the ground
  }

  // phase clocks (all pinned to 1 once weathered so the decay layout is
  // exactly the settled wreck, weathered in place)
  let tWheel = k => weathered ? 1 : clamp01((age - (CSTART + k*70))/WDUR); // wheels slide off WITH the collapse
  let tBed   = weathered ? 1 : clamp01((age - BSTART)/BDUR);          // bed drop
  let tFold  = weathered ? 1 : clamp01((age - CSTART)/CDUR);          // walls fold flat

  // ox yoked ahead along the movement axis (hitch snaps at death — no rods)
  let hoofDrop = OX_PROFILE.legBot*OX_PROFILE.scale - 1;
  let oxOff = { x: SCALE*(L+10)*u.x, y: SCALE*(L+10)*u.y + SCALE*(WB+0.4)*Math.abs(v.y) - hoofDrop };

  X.save();
  X.globalAlpha = alpha;

  // ox blood pool (screen coords, same recipe as the shared corpse pool)
  let obp = clamp01((age-(OXDELAY+OXFALL*0.7))/2000);
  if (obp > 0) {
    let spread = eo(obp);
    let dry = clamp01((age-8000)/8000);
    let poolA = 0.6*Math.min(1,obp*3)*(1-dry*0.55);
    X.fillStyle='rgba('+Math.round(120-40*dry)+', '+Math.round(25*dry)+', '+Math.round(10*dry)+', '+poolA.toFixed(3)+')';
    X.beginPath();
    X.ellipse(sx+c.facing*(oxOff.x-u.x*CART_RECENTER*SCALE)*UNIT_SCALE, sy+(oxOff.y-u.y*CART_RECENTER*SCALE)*UNIT_SCALE+3,
              8*UNIT_SCALE*spread, 4*UNIT_SCALE*spread, 0, 0, Math.PI*2);
    X.fill();
  }

  X.translate(sx, sy);
  X.scale(c.facing*UNIT_SCALE, UNIT_SCALE);
  X.translate(-u.x*CART_RECENTER*SCALE, -u.y*CART_RECENTER*SCALE); // same rig recentering as the live cart
  let lw = 1.2/UNIT_SCALE;
  X.lineJoin='round';

  // The ox: buckles a beat after the cart, as a RIGID topple over the feet
  // (any non-uniform scale mixed into a fall reads as squish/stretch).
  let drawOx = () => {
    let ot = age<=OXDELAY ? 0 : Math.min(1, (age-OXDELAY)/OXFALL);
    let oxRot = (Math.PI/2.3)*ot*ot;
    if (age>OXDELAY+OXFALL && age<OXDELAY+OXFALL+300)
      oxRot *= 1+0.06*Math.sin((age-OXDELAY-OXFALL)/300*Math.PI); // impact recoil
    X.save(); X.translate(oxOff.x, oxOff.y);
    if (weathered) {
      X.rotate(Math.PI/2.3);
      drawHorseSkeleton(1.05); // squat ox bones (bear-style horse skeleton)
    } else {
      X.rotate(oxRot);
      if(!c.oxPose) c.oxPose={id:c.id, dir:7, facing:1, facingNorth:false, path:[], corpseRot:1};
      drawQuadruped(c.oxPose, OX_PROFILE);
    }
    X.restore();
  };
  let frontNear = (mirroredDir({dir: c.dir !== undefined ? c.dir : 7, facing: c.facing||1}) === 0 ||
                   mirroredDir({dir: c.dir !== undefined ? c.dir : 7, facing: c.facing||1}) === 1);
  if (!frontNear) drawOx();

  X.save(); X.scale(SCALE, SCALE);
  let lw2 = lw; // stroked inside the cart scale, same as the live cart
  let poly = (pts, fill) => {
    X.fillStyle=fill; X.beginPath(); pts.forEach((p,i)=>i?X.lineTo(p.x,p.y):X.moveTo(p.x,p.y)); X.closePath(); X.fill();
    X.strokeStyle='#000'; X.lineWidth=lw2; X.lineJoin='round'; X.stroke();
  };
  let wood = (fresh, gray) => weathered ? gray : fresh;
  let bedInner= wood('#74593a', '#9a917f'); // shadowed inner faces (matches the live cart)
  let bedNear = wood('#a07c4c', '#877e6c');
  let bedTop  = wood('#b48c58', '#9a917f');
  let bedFloor= wood('#3a2c1c', '#55503f');

  // A wheel mid-tip: from its mounted axle position to flat on the ground
  // just outside it, squashing from near-upright to the flat rest pose.
  let wheelAt = (a, b, k) => {
    let t = eo(tWheel(k));
    // rest offset normalized by the axis length so wheels land a constant
    // SCREEN distance outside the bed (they peek from under the folded
    // walls in every facing, incl. the near-vertical side-elevation axis)
    let bRest = b + Math.sign(b)*(0.8*(WB+0.4))*(vlen < 0.5 ? 0.55 : 1)/vlen; // damped in the compressed side view
    let p0 = P(a, b, WR), p1 = P(a*(1+0.25*Math.abs(jit(k))), bRest, 0);
    X.save();
    X.translate(p0.x+(p1.x-p0.x)*t, p0.y+(p1.y-p0.y)*t);
    X.rotate(jit(k+40)*0.45*t); // settles at a lazy lean, not flat
    let raw = tWheel(k);
    if (u.x === 0 && raw < 0.5) {
      // head-on facings keep the live cart's SQUARE slab wheels until
      // midway through the collapse tip-off
      let w2 = WTH*1.3, h2 = WR*0.78;
      X.fillStyle='#33261a'; X.fillRect(-w2, -h2, w2*2, h2*2);
      X.strokeStyle='#1d150c'; X.lineWidth=0.9/UNIT_SCALE; X.strokeRect(-w2,-h2,w2*2,h2*2);
      X.fillStyle='#5a4630'; X.fillRect(-0.6,-h2+0.6,1.2,h2*2-1.2);
    } else {
      // widening from the edge-on slab into the side-view disc
      if (u.x === 0) X.scale(0.45+0.55*Math.min(1,(raw-0.5)*2), 1);
      drawFallenWheel(WR*1.15, 0.9-0.18*t, 0.5+k+jit(k+20), weathered, lw2);
    }
    X.restore();
  };
  let nearB = Math.sign(v.y) || 1; // +v is the near side on every authored facing

  // two-wheeler: ONE big wheel per side on the center axle.
  // far wheel first (behind the bed)
  wheelAt(0, -nearB*(WB+0.4), 0);

  // Near wheel: in FRONT of the standing box while it tips off, but UNDER
  // the near wall once it folds out over it — the order swaps mid-fold,
  // when the wall is still mostly upright and the wheel is already at rest
  // clear of it, so the two barely overlap and no pop reads.
  // Head-on (u.x===0): both wheels behind the body, like the live cart.
  let nearWheels = () => wheelAt(0, nearB*(WB+0.4), 2);
  if (u.x === 0 || tFold > 0.3) nearWheels();

  // the bed: rides at axle height while the wheels hold, then drops CB to
  // the ground with a small landing recoil
  let drop = CB*tBed*tBed;
  if (!weathered && age>BSTART+BDUR && age<BSTART+BDUR+250)
    drop -= 0.6*Math.sin((age-BSTART-BDUR)/250*Math.PI);
  X.save(); X.translate(0, drop);
  // walls/end boards fold outward flat as the fold clock runs: the bottom
  // edge stays put, the top edge swings out into the ground plane. Fold
  // reach is divided by the axis length so a board of height H covers ~H px
  // on screen in EVERY facing — the head-on basis cheats (v widened to
  // 1.25, u squashed to 0.55) otherwise splay the side walls way too far
  // and barely fold the end boards (they read distorted).
  let f = eo(tFold);
  let reachB = (CH-CB)/vlen, reachA = (CH-CB)/ulen;
  let wallQ = (sgn, fill) => poly([
    P(-L, sgn*WB, CB), P(L, sgn*WB, CB),
    P( L, sgn*(WB+reachB*f), CH-(CH-CB)*f), P(-L, sgn*(WB+reachB*f), CH-(CH-CB)*f)
  ], fill);
  let endQ = (aE, fill) => { let sA = Math.sign(aE); poly([
    P(aE, -WB, CB), P(aE, WB, CB),
    P(aE+sA*reachA*f, WB, CH-(CH-CB)*f), P(aE+sA*reachA*f, -WB, CH-(CH-CB)*f)
  ], fill); };
  // The SAME canonical load as the living cart rides inside the box, then
  // tumbles out over the folding near wall as it opens: each piece lerps
  // from its in-bed seat to its own spilled ground rest with the fold
  // clock. In the bed's translated space the true ground sits at height CB
  // once the bed has landed.
  let cargoT = eo(tFold);
  let drawCargo = () => {
    let anchor = P(0, 0, CH-2.2);
    let out = P(-L*0.3, nearB*(WB+reachB*0.7), CB); // the sack tumbles out over the near wall
    drawCartLoad((k,dx,dy)=>({
      x: (anchor.x+dx)+(out.x-(anchor.x+dx))*cargoT,
      y: (anchor.y+dy)+(out.y-(anchor.y+dy))*cargoT
    }), lw2);
  };

  wallQ(-nearB, bedInner);          // far side wall: inner face
  endQ(u.y<0 ? L : -L, bedInner);   // far end (view-dependent): inner face
  poly([P(-L,-WB,CB),P(L,-WB,CB),P(L,WB,CB),P(-L,WB,CB)], bedFloor); // floor
  if (!weathered && cargoT < 0.55) drawCargo(); // still boxed in: walls occlude it
  // near outer faces are TEAM-COLORED panels (the live cart's ownership
  // read) — but once a wall folds past ~45° its blue outer face turns
  // toward the ground, so the visible side becomes the brown INNER face
  let faceFlipped = tFold > 0.5;
  wallQ(nearB, wood(faceFlipped ? '#74593a' : teamColor(c.team), '#877e6c'));
  endQ(u.y<0 ? -L : L, wood(faceFlipped ? '#74593a' : teamColorDark(c.team), '#877e6c'));
  X.restore();

  if (u.x !== 0 && tFold <= 0.3) nearWheels(); // still tipping: over the standing box

  // once the walls have mostly folded open the spilled cargo lies ON them
  if (!weathered && cargoT >= 0.55) {
    X.save(); X.translate(0, drop);
    drawCargo();
    X.restore();
  }
  X.restore();

  if (frontNear) drawOx();
  X.restore();
}

// Battering ram death — a staged physical fall in the ram's own projection
// basis (facing-aware, all 8 views from the live art's 5 bases + mirror):
//   the six wheels tip off one by one (0–~650ms, staggered) →
//   the unsupported shed drops its ground clearance with a dust thud →
//   the roof caves (ridge falls), the skirt walls crush flat beneath it,
//   the gable ends fold outward, the roof slopes settle as two flat slabs,
//   and the all-wood log drops out of its slings to rest inside the
//   wreck. The team fascia stays on the near roof edge through the fold.
// At CORPSE_SKEL the wood weathers gray in place (the settled fold IS the
// decay layout — no pop). Render-only;
// one-time bursts gated through corpseImpactFxDone (resync-safe).
function drawRamCorpse(c, sx, sy, age, alpha){
  const { L, WE, WB, CB, CE, CR, RLOG, RHEAD, WR, WA, WTH, SCALE } = RAM_DIM;
  const WDUR=320, BSTART=260, BDUR=280, CSTART=540, CDUR=380, SSTART=700, SDUR=450, LSTART=620, LDUR=430;
  let ax = corpseVehicleAxes(c), u = ax.u, v = ax.v;
  // Size constancy for the E/W side pose is baked into the PROJECTION
  // (profK scales P's output), not a canvas scale — scaling the context
  // also scaled every stroke width, so the side wreck's outlines rendered
  // ~13% heavier than the other facings'.
  let profK = (ax === SIDE_AXES) ? RAM_PROFILE_K : 1;
  let P = (a,b,h) => ({ x:(a*u.x + b*v.x)*profK, y:(a*u.y + b*v.y - h)*profK });
  let vlen = Math.hypot(v.x, v.y), ulen = Math.hypot(u.x, u.y);
  let clamp01 = x => Math.min(1, Math.max(0, x));
  let eo = t => 1-(1-t)*(1-t);
  let jit = n => { let s=Math.sin(c.id*7.3+n*13.7)*43758.5453; return s-Math.floor(s)-0.5; };
  let weathered = age >= CORPSE_SKEL;
  let tc = teamColor(c.team);

  if (!corpseImpactFxDone.has(c.id)) {
    corpseImpactFxDone.add(c.id);
    spawnParticles(c.x, c.y, '#c9a15e', 12, 0.05, 2.2);
    spawnParticles(c.x, c.y, 'rgba(140,120,90,0.7)', 8, 0.02, 2.4);
  }
  if (age >= BSTART+BDUR && !corpseImpactFxDone.has(c.id+':thud')) {
    corpseImpactFxDone.add(c.id+':thud');
    spawnParticles(c.x, c.y, 'rgba(140,120,90,0.7)', 6, 0.03, 2.2); // shed hits the ground
  }
  if (age >= SSTART && !corpseImpactFxDone.has(c.id+':cave')) {
    corpseImpactFxDone.add(c.id+':cave');
    spawnParticles(c.x, c.y, 'rgba(140,120,90,0.7)', 7, 0.03, 2.4); // roof comes down
  }

  let tWheel = k => weathered ? 1 : clamp01((age - (SSTART + k*60))/WDUR); // wheels slide off WITH the collapse
  let tBed   = weathered ? 1 : clamp01((age - BSTART)/BDUR);   // shed drop
  let tCave  = weathered ? 1 : clamp01((age - CSTART)/CDUR);   // ridge falls
  let tSplay = weathered ? 1 : clamp01((age - SSTART)/SDUR);   // fold flat
  let tLog   = weathered ? 1 : clamp01((age - LSTART)/LDUR);   // log slides out

  X.save();
  X.globalAlpha = alpha;
  X.translate(sx, sy);
  X.scale(c.facing*UNIT_SCALE, UNIT_SCALE);
  X.lineJoin='round';

  // profile wrecks match the live ram's side-pose size constancy scale
  X.save(); X.scale(SCALE, SCALE);
  let lw = 1.2/UNIT_SCALE;
  let poly = (pts, fill) => {
    X.fillStyle=fill; X.beginPath(); pts.forEach((p,i)=>i?X.lineTo(p.x,p.y):X.moveTo(p.x,p.y)); X.closePath(); X.fill();
    X.strokeStyle='#000'; X.lineWidth=lw; X.lineJoin='round'; X.stroke();
  };
  let wood = (fresh, gray) => weathered ? gray : fresh;
  let roofC  = wood(WOOD.plankL, '#9a917f');
  let gabC   = wood(WOOD.plankR, '#877e6c');
  let nearB = Math.sign(v.y) || 1;
  let farA  = (u.y > 0) ? -1 : 1;    // which shed end is farther up-screen

  // wheels — 3 axles per side, tipping off staggered; far side behind the shed
  let wheelAt = (a, b, k) => {
    let t = eo(tWheel(k));
    // rest offset normalized by the axis length: constant SCREEN distance
    // outside the shed — damped in the side view, whose compressed wreck
    // otherwise leaves the wheels looking flung far away from it
    let bRest = b + Math.sign(b)*(0.85*WB)*(vlen < 0.5 ? 0.55 : 1)/vlen;
    let p0 = P(a, b, WR), p1 = P(a*(1+0.18*Math.abs(jit(k))), bRest, 0);
    X.save();
    X.translate(p0.x+(p1.x-p0.x)*t, p0.y+(p1.y-p0.y)*t);
    X.rotate(jit(k+40)*0.45*t); // settles at a lazy lean, not flat
    let raw = tWheel(k);
    if (u.x === 0 && raw < 0.5) {
      // head-on facings keep the live ram's SQUARE slab wheels until
      // midway through the collapse tip-off
      let w2 = WTH*1.15, h2 = WR*0.7;
      X.fillStyle='#33261a'; X.fillRect(-w2, -h2, w2*2, h2*2);
      X.strokeStyle='#1d150c'; X.lineWidth=0.9/UNIT_SCALE; X.strokeRect(-w2,-h2,w2*2,h2*2);
      X.fillStyle='#5a4630'; X.fillRect(-0.6,-h2+0.6,1.2,h2*2-1.2);
    } else {
      // widening from the edge-on slab into the side-view disc
      if (u.x === 0) X.scale(0.45+0.55*Math.min(1,(raw-0.5)*2), 1);
      drawFallenWheel(WR*1.05*profK, 0.9-0.18*t, 0.4+k+jit(k+20), weathered, lw, true); // solid: matches the live ram wheels
    }
    X.restore();
  };
  [-WA,0,WA].forEach((a,i)=>wheelAt(a, -nearB*WB, i));
  // head-on: ALL wheels behind the body, like the live ram's assembly
  if (u.x === 0) [-WA,0,WA].forEach((a,i)=>wheelAt(a, nearB*WB, i+3));

  // the shed: its base rides at CB clearance while the wheels hold, then
  // drops to true ground with a small landing recoil (heights below are
  // measured from the ground, offset by hB — no translate, so the settled
  // fold sits exactly ON the ground instead of sinking below it)
  let hB = CB*(1-tBed*tBed);
  if (!weathered && age>BSTART+BDUR && age<BSTART+BDUR+250)
    hB += 0.7*Math.sin((age-BSTART-BDUR)/250*Math.PI);

  // fold reach normalized by axis length so boards cover their true length
  // on screen in every facing (the head-on basis widens v / squashes u)
  // Shed heights are measured from the shed BASE (which rides at hB): the
  // live art measures CE/CR from the ground, so subtract the CB clearance
  // here or the standing wreck starts taller than the living ram.
  let fS = eo(tSplay);
  // The E/W side basis projects b nearly vertically, so the v-normalized
  // splay that reads right in the other facings makes the settled flaps
  // hang far below the ground line (the wreck read as still standing).
  // Side view gets tighter rest targets that hug the ground.
  let sideV = vlen < 0.5;
  let hSkirt = (CE-CB)*(1-eo(tCave)*0.92);                // walls crush under the roof
  let hEave  = (CE-CB)*(1-fS) + (sideV ? 0.3 : 0.8)*fS;   // eaves ride down to the ground
  let eaveB  = (WE+1.5) + (sideV ? 2.5 : 3.2/vlen)*fS;    // slabs slide outward as they land
  // The slabs rest on a LIGHT incline over the log's cylinder (ridge at
  // ~RLOG-ish height, eaves on the ground) — enough lean to read as
  // draped over a 3D log, but well short of the heavy bulge that sheared
  // the slab faces into distortion.
  let hRidge = ((CR-CB) - ((CR-CB)-CE*0.55)*eo(tCave)) * (1-fS) + (sideV ? 1.2 : RLOG*0.9)*fS;
  let ridgeB = 1.4*fS;                                    // ridge line splits apart

  // gable ends fold outward beyond the shed, PRESERVING the pentagon's
  // proportions when flat: eave corners land at their true panel distance
  // (CE-CB) and the apex at nearly the full panel height (CR-CB) — with a
  // short apex reach the folded panel read as a box instead of a pentagon
  let gable = (aE) => {
    let sA = Math.sign(aE), g = eo(tSplay);
    poly([
      P(aE, -WB, hB), P(aE, WB, hB),
      P(aE + sA*((CE-CB)*0.95/ulen)*g, WE*(1-g*0.15), hB+hEave*0.9),
      P(aE + sA*((CR-CB)*0.85/ulen)*g, 0, hB+hRidge*0.9),
      P(aE + sA*((CE-CB)*0.95/ulen)*g, -WE*(1-g*0.15), hB+hEave*0.9),
    ], gabC);
  };
  let skirt = (sgn) => poly([
    P(-L,sgn*WB,hB),P(L,sgn*WB,hB),P(L,sgn*WB,hB+hSkirt),P(-L,sgn*WB,hB+hSkirt)
  ], gabC);
  // the ram log drops straight down out of its slings — under the roof
  // (which caves onto it), but ON TOP of the front panel in the
  // toward-viewer facings (SE/S/SW), where its tip projects at the camera.
  // No forward slide; gravity ease-in with a small landing bounce.
  let drawLog = () => {
    let t = tLog*tLog; // accelerating fall
    let h = (hB + CE*0.5)*(1-t) + RLOG*0.75*t;
    if (!weathered && age>LSTART+LDUR && age<LSTART+LDUR+220)
      h += 0.8*Math.sin((age-LSTART-LDUR)/220*Math.PI); // bounce
    let p0 = P(-L*0.35, 0, h), p1 = P(L*1.05, 0, h);
    // ALL-WOOD shaft, like the living ram. The END EDGES run along the
    // projected cross axis v — the same slant as the slabs' and end
    // boards' short edges, so the cuts align with the wreck's facing —
    // scaled so the silhouette thickness stays exactly RLOG*2.
    let ldx=p1.x-p0.x, ldy=p1.y-p0.y, llen=Math.hypot(ldx,ldy)||1;
    let lnX=-ldy/llen, lnY=ldx/llen;
    let cvv = v.x*lnX + v.y*lnY;
    let lk = RLOG*profK / (Math.abs(cvv) > 0.15 ? cvv : (cvv < 0 ? -0.15 : 0.15));
    let Dx = v.x*lk, Dy = v.y*lk;
    poly([
      {x:p0.x+Dx,y:p0.y+Dy},{x:p1.x+Dx,y:p1.y+Dy},
      {x:p1.x-Dx,y:p1.y-Dy},{x:p0.x-Dx,y:p0.y-Dy}
    ], wood('#6e473b','#877e6c'));
  };

  gable(farA*L);
  skirt(-nearB);
  drawLog(); // inside the shed: the near skirt and front panel paint over it
  skirt(nearB);
  gable(-farA*L);
  // near wheels BEFORE the roof: they tip off beside the shed while the
  // roof is still high overhead (no overlap), and once the slabs splay
  // outward they land ON the wheels — so the roof must paint over them
  // (head-on already drew them behind the body above)
  if (u.x !== 0) [-WA,0,WA].forEach((a,i)=>wheelAt(a, nearB*WB, i+3));
  // roof slopes last — they land ON everything: log, crushed skirts, wheels.
  // Plank seams run lengthwise like the live roof's (rgba .18 hairlines).
  let slope = (sgn) => {
    poly([
      P(-L, sgn*eaveB, hB+hEave), P(L, sgn*eaveB, hB+hEave),
      P(L, sgn*ridgeB, hB+hRidge), P(-L, sgn*ridgeB, hB+hRidge)
    ], roofC);
    // plank seams run ridge→eave (down the slope), like the live roof's
    X.strokeStyle='rgba(0,0,0,0.18)'; X.lineWidth=0.8/UNIT_SCALE;
    for (let a2 of [-L*0.5, 0, L*0.5]) {
      let s1 = P(a2, sgn*ridgeB, hB+hRidge), s2 = P(a2, sgn*eaveB, hB+hEave);
      X.beginPath(); X.moveTo(s1.x,s1.y); X.lineTo(s2.x,s2.y); X.stroke();
    }
  };
  slope(-nearB);
  slope(nearB);
  // team fascia — thick enough to read at gameplay zoom. The NEAR eave
  // carries it always (like the live ram); the FAR eave's stripe is hidden
  // behind the standing roof, so it only appears once the collapse splays
  // the slopes open — EXCEPT head-on (u.x===0), where both eaves are the
  // roof's left/right edges and the live ram shows both stripes already.
  if (!weathered) {
    X.strokeStyle=tc; X.lineWidth=3.2/UNIT_SCALE; X.lineCap='round';
    for (let sgn of (u.x === 0 || tSplay > 0.35 ? [-1, 1] : [nearB])) {
      let e1 = P(-L*0.92, sgn*eaveB, hB+hEave), e2 = P(L*0.92, sgn*eaveB, hB+hEave);
      X.beginPath(); X.moveTo(e1.x,e1.y); X.lineTo(e2.x,e2.y); X.stroke();
    }
    X.lineCap='butt';
  }
  X.restore();
  X.restore();
}

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

  // Wooden vehicles get their own break-apart wreck sequences — they don't
  // topple like bodies (the cart's ox falls separately; the ram caves in).
  if (c.utype === 'tradecart') { drawTradeCartCorpse(c, sx, sy, age, alpha); return; }
  if (c.utype === 'ram') { drawRamCorpse(c, sx, sy, age, alpha); return; }

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
    if(isMountedUnit(c.utype)){
      drawHorseSkeleton(1.35);
      drawHumanSkeleton(-11,-11,1);     // the rider, beside his horse
    } else if(c.utype==='bear'){
      // Bear remains: same construction as the horse but squatter — the
      // boulder ribcage is the read
      drawHorseSkeleton(1.15);
    } else {
      drawHumanSkeleton(0,0,1.25);
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

// Per-ram last rolling-creak period that already played (render-side
// cosmetic state, like workSwingCycles for the villagers' work swing).
let ramCreakCycles = new Map();

// ---- BATTERING RAM: one physical model, projected per view ----
// Every facing AND the ground shadow derive from these numbers, so
// proportions cannot drift between views. World units are local px at
// scale 1 (RAM_SCALE applied at draw time): X = movement axis (a),
// Y = width axis (b), Z = up (c).
const RAM_DIM = {
  L: 12,      // body half-length (gable planes at a=±L)
  WE: 7,      // eave half-width
  WB: 6,      // skirt-base half-width
  CB: 3,      // ground clearance (bottom of walls)
  CE: 9,      // eave height — also the log's axis height
  CR: 17,     // ridge height
  OV: 1.2,    // roof overhang past the gables
  RLOG: 2.6,  // log shaft radius → beam width 5.2 in EVERY projection
  RHEAD: 3.2, // (legacy head radius — the log is all wood now; kept for shadow math)
  HLEN: 2.8,  // (legacy head length)
  WR: 3,      // wheel radius
  WA: 8,      // axle spacing (three axles at a = -WA, 0, +WA)
  WTH: 1.4,   // wheel tread width along the axle
  SCALE: 1.45 // overall ram scale vs the unit grid
};
// Screen basis per authored facing (mirroredDir): u = movement axis,
// v = ground-plane width axis, height is always (0,-1).
// dir7 (E): u exactly horizontal (true profile heading); dir0/6 the 2:1
// iso diagonals; dir1/5 head-on with a widened v (see drawRamBody).
// Size-constancy factor for the true-profile pose (dir 7): a side
// ELEVATION of the same body spans only 2·L where the 3/4 views span
// 2·L·|u.x| + 2·(WE+WTH)·|v.x| — ~1.4x more. Classic sprite-art practice
// (AoE2 included) keeps silhouette presence roughly constant across
// facings, so the profile is drawn uniformly scaled by this factor about
// the ground anchor. Derived, not eyeballed:
//   K = (L·0.894 + (WE+WTH)·0.894) / L  for the current model ≈ 1.27
// Half-way between true elevation (1.0) and full span-matching (~1.27):
// full compensation overshot — the flat pose carries more solid mass than
// the 3/4s, so equal bounding span reads LARGER. Split the difference.
const RAM_PROFILE_K = (1 + 0.894 * (RAM_DIM.L + RAM_DIM.WE + RAM_DIM.WTH) / RAM_DIM.L) / 2; // ≈ 1.13
// TRUE side-elevation basis for the E/W profile facing: the cross axis
// projects nearly vertical (far side slightly up-screen, near side down),
// so the vehicle reads straight-on — "portrait" — instead of slightly
// rotated toward 3/4 like the generic dir-7 basis below. Used by the live
// trade cart and both vehicle wrecks; the live ram has its own hand-drawn
// profile pose that already reads straight.
const SIDE_AXES = { u:{x:1,y:0}, v:{x:0,y:0.38} };
const RAM_AXES = {
  7: { u:{x:1,y:0},          v:{x:-0.6,y:0.4} },
  0: { u:{x:0.894,y:0.447},  v:{x:-0.72,y:0.36} },
  1: { u:{x:0,y:0.55},       v:{x:1.25,y:0} },
  5: { u:{x:0,y:-0.55},      v:{x:1.25,y:0} },
  6: { u:{x:0.894,y:-0.447}, v:{x:0.72,y:0.36} }
};
// Footprint shadow half-extents (local px, before UNIT_SCALE): the ground
// rectangle |a| ≤ L+OV, |b| ≤ WE+WTH projected through the view basis —
// |a|·|u| + |b|·|v| per screen axis is exact for an axis-aligned box.
// 0.92 tucks the shadow slightly inside the silhouette. Mirrored dirs
// (2/3/4) share their right-facing twin's extents (all terms are |abs|).
function ramShadowExtent(dir){
  let m = dir === 2 ? 0 : dir === 3 ? 7 : dir === 4 ? 6 : dir;
  let ax = RAM_AXES[m] || RAM_AXES[7];
  // the profile pose is drawn RAM_PROFILE_K larger (size constancy) — its
  // footprint shadow scales with it
  let k = m === 7 ? RAM_PROFILE_K : 1;
  let A = (RAM_DIM.L + RAM_DIM.OV) * RAM_DIM.SCALE * 0.78 * k;
  let B = (RAM_DIM.WE + RAM_DIM.WTH) * RAM_DIM.SCALE * 0.78 * k;
  // rx spans the full projected footprint, but ry is flattened to ~half:
  // an ellipse tall enough to reach the footprint's far corners pools out
  // BELOW the near wheels (it's centered on the anchor) and reads as the
  // ram hovering over a puddle. Ground shadows hug the contact line.
  return {
    rx: A * Math.abs(ax.u.x) + B * Math.abs(ax.v.x),
    ry: Math.max(3, (A * Math.abs(ax.u.y) + B * Math.abs(ax.v.y)) * 0.5)
  };
}

// ---- BATTERING RAM (covered ram, AoE2 style) ----
// A rigid wooden shed on four wheels with a suspended log protruding from
// the front gable, drawn as a true iso box: every vertex is
// P(a,b,c) = a·u + b·v + c·(0,-1), where u is the body/movement axis in
// SCREEN space, v the ground-plane width axis and c the height. The five
// authored facings (mirroredDir 0,1,5,6,7) differ only in their u/v
// vectors and which faces/wheels are visible; dirs 2/3/4 come free from
// the facing mirror like every other unit. Called inside drawUnit's
// translated+mirrored context, so all coords are local px around the
// ground anchor at (0,0).
function drawRamBody(e){
  let useDir = mirroredDir(e);
  // dir7 (E) is pure screen-horizontal (tile (1,-1) → screen (64,0));
  // dir0/6 run along the 2:1 iso diagonals; dir1/5 point at/away from the
  // viewer (u vertical, foreshortened) with the width axis lying flat.
  // dir7 (E): the body axis u is EXACTLY horizontal — the ram points due
  // east/west in profile. The 3/4 richness (visible front gable + roof
  // pitch, vs the flat-topped-cart a true edge-on projection gives) comes
  // entirely from the skewed width axis v, which costs nothing in heading.
  // Head-on dirs 1/5 widen v: at true iso a shed pointing at the camera
  // is narrower than it is tall, which reads as a tent, not a vehicle.
  let ax = RAM_AXES[useDir] || RAM_AXES[7];
  let u = ax.u, v = ax.v;
  let P = (a,b,c) => ({ x: a*u.x + b*v.x, y: a*u.y + b*v.y - c });

  // All proportions come from the shared physical model (RAM_DIM above).
  const { L, WE, WB, CB, CE, CR, OV, RLOG, RHEAD, HLEN, WR, WA, WTH, SCALE } = RAM_DIM;

  let tc = teamColor(e.team);
  let rolling = e.path.length > 0;
  let ramming = (!!e.target && e.path.length === 0) || e.__animAttack;

  // Thrust cycle: slow windup 70% (log drags back), fast strike 30%
  // (ease-out cubic), one monotonic phase so an impact-per-cycle counter
  // can hook in later (workSwingCycles pattern).
  let dLog = 0, recoil = 0;
  if (ramming) {
    // ~45-tick cycle (1.5 game-s): a heavy ram swings SLOWLY (AoE2), and
    // the per-cycle impact boom needs the slower cadence to not spam.
    let phRaw = tick*0.022 + e.id*0.4;
    let ph = ((phRaw % 1) + 1) % 1;
    if (ph < 0.7) dLog = -4 * (ph/0.7);
    else { let t = (ph-0.7)/0.3; dLog = -4 + 8 * (1 - Math.pow(1-t,3)); }
    recoil = Math.max(0, dLog) * 0.2;
    // One impact per thrust cycle, exactly when the strike lands (the
    // cycle counter rolls over at the end of the fast 30% strike phase).
    // Same counter pattern as the villagers' work swing (workSwingCycles):
    // detected by the COUNTER advancing, so no impact is dropped or
    // doubled at any game speed; never during the outline mask pass; only
    // with a real target (the gallery's __animAttack stays silent).
    let cyc = Math.floor(phRaw);
    if (!window._maskDraw && e.target && workSwingCycles.get(e.id) !== cyc) {
      if (workSwingCycles.has(e.id) && window.playSound) {
        playSound('ram_hit', e.x, e.y);
      }
      workSwingCycles.set(e.id, cyc);
    }
  }
  // Idle log sway — the only idle motion; a vehicle sits still.
  else if (!rolling) dLog = Math.sin(tick*0.05 + e.id) * 0.4;

  // Rolling creak: a slow wooden groan while the ram is moving — sparse
  // (every ~3 game-s, staggered per unit), skipped at 4x speed on odd
  // cycles like the chop sound. Fired by the period COUNTER advancing
  // (ramCreakCycles), not by a frame landing on an exact tick — frames
  // skip ticks, and an equality check dropped most creaks.
  if (rolling && !window._maskDraw && window.playSound) {
    let ck = Math.floor((tick + e.id * 7) / 90);
    if (ramCreakCycles.get(e.id) !== ck) {
      if (ramCreakCycles.has(e.id) && (GAME_SPEED < 4 || ck % 2 === 0)) playSound('ram_creak', e.x, e.y);
      ramCreakCycles.set(e.id, ck);
    }
  }

  X.save();
  // Rolling: gentle sway, no head-bob (suppressed in drawUnit's translate)
  if (rolling) X.translate(0, Math.sin(tick*0.2 + e.id) * 0.5);
  X.translate(recoil * u.x, recoil * u.y);
  X.scale(SCALE, SCALE); // the ram out-bulks even the horse units

  let lw = 1.2 / UNIT_SCALE;
  let poly = (pts, fill) => {
    X.fillStyle = fill; X.beginPath();
    pts.forEach((p,i) => i ? X.lineTo(p.x,p.y) : X.moveTo(p.x,p.y));
    X.closePath(); X.fill();
    X.strokeStyle = '#000'; X.lineWidth = lw; X.lineJoin = 'round'; X.stroke();
  };
  // Wheel: a short CYLINDER, not a flat disc — a dark tread capsule runs
  // from the inner face to the outer face along the axle (the width axis
  // v), then the lit wooden face with rotating cross-spokes and a hub sits
  // on the outer end. Head-on facings see a wheel edge-on: only the tread
  // shows, a dark rounded slab.
  let wheelRot = tick*0.35 + e.id;
  let wheel = (a, b, r) => {
    let thin = (useDir === 1 || useDir === 5);
    if (thin) {
      // Edge-on wheel: a plain SQUARE slab — these are solid wooden
      // wheels, not tires; head-on there's no curve to show. Soft dark
      // outline, faint lit strip for the rolling surface.
      let p = P(a, b, r);
      let w2 = WTH * 1.15, h2 = WR * 0.7; // tread width / wheel radius, edge-on
      X.fillStyle = '#33261a';
      X.fillRect(p.x - w2, p.y - h2, w2*2, h2*2);
      X.strokeStyle = '#1d150c'; X.lineWidth = 0.9 / UNIT_SCALE;
      X.strokeRect(p.x - w2, p.y - h2, w2*2, h2*2);
      X.fillStyle = '#5a4630';
      X.fillRect(p.x - 0.6, p.y - h2 + 0.6, 1.2, h2*2 - 1.2);
      return;
    }
    // thickness extends toward the vehicle's centerline
    let bIn = b - Math.sign(b) * WTH;
    let pIn = P(a, bIn, r), pF = P(a, b, r);
    // The disc lies in the plane spanned by the movement axis u and the
    // vertical: a rim point is r·cosθ·u + r·sinθ·(0,-1), i.e. EXACTLY a
    // unit circle under the canvas transform (u.x, u.y, 0, -1). Drawing
    // the face inside that transform gets the per-facing foreshortening
    // and tilt from the math (dir7 near-circle, diagonals squeezed along
    // the run) instead of eyeballing screen-facing circles — and a spoke
    // drawn in disc-local coords genuinely rotates about the axle.
    let discPath = (cx, cy) => {
      X.save(); X.transform(u.x, u.y, 0, -1, cx, cy);
      X.beginPath(); X.arc(0, 0, r, 0, Math.PI*2);
      X.restore(); // pop BEFORE stroking so line width isn't distorted
    };
    // Tread: the cylinder silhouette is the disc ellipse SWEPT along the
    // axle — a screen-space capsule has circular caps that disagree with
    // the tilted end ellipses (visible bulge). Sweep = outline the inner
    // cap, then fill the disc shape at a few steps toward the outer face;
    // the union is the exact cylinder.
    X.strokeStyle = '#1d150c'; X.lineWidth = 1.8 / UNIT_SCALE;
    discPath(pIn.x, pIn.y); X.stroke();
    X.fillStyle = '#33261a';
    for (let t3 = 0; t3 <= 1.001; t3 += 0.2) {
      discPath(pIn.x + (pF.x - pIn.x) * t3, pIn.y + (pF.y - pIn.y) * t3);
      X.fill();
    }
    // outer face disc: lit wood, one true-rotating spoke, hub
    X.fillStyle = '#5a4630';
    X.strokeStyle = '#1d150c'; X.lineWidth = 0.9 / UNIT_SCALE;
    discPath(pF.x, pF.y); X.fill(); X.stroke();
    let ang = (rolling ? wheelRot : 0.6);
    // Spoke rotates in the disc plane (û, up). The vertical term is +sin,
    // not -sin: with -sin the diagonal wheels spun BACKWARD relative to
    // travel (opposite the E/W profile wheels, which roll forward) — the
    // sign flip makes the contact point track rearward as the ram advances.
    let sp = t => ({ x: pF.x + (Math.cos(ang)*u.x)*r*t, y: pF.y + (Math.cos(ang)*u.y + Math.sin(ang))*r*t });
    let s1 = sp(-0.7), s2 = sp(0.7);
    X.strokeStyle = '#3a2c1c'; X.lineWidth = 1 / UNIT_SCALE;
    X.beginPath(); X.moveTo(s1.x, s1.y); X.lineTo(s2.x, s2.y); X.stroke();
    X.fillStyle = '#8a6a4a';
    X.beginPath(); X.arc(pF.x, pF.y, 0.7, 0, Math.PI*2); X.fill();
  };
  // Gable end (pentagon) at a=const: skirt base, eaves, ridge point.
  let gable = (a, fill) => poly([P(a,-WB,CB),P(a,WB,CB),P(a,WE,CE),P(a,0,CR),P(a,-WE,CE)], fill);
  // Roof slope quad on side sgn (=±1), with overhang past the gables AND
  // past the wheels: the eave reaches wider and lower than the wall line
  // (WE+1.5 at c=CE-1.2) so the roof visibly shelters the running gear.
  let slope = (sgn, fill) => poly([P(-L-OV,sgn*(WE+1.5),CE-1.2),P(L+OV,sgn*(WE+1.5),CE-1.2),P(L+OV,0,CR),P(-L-OV,0,CR)], fill);
  // Skirt side wall on side sgn.
  let skirt = (sgn, fill) => poly([P(-L,sgn*WB,CB),P(L,sgn*WB,CB),P(L,sgn*WE,CE),P(-L,sgn*WE,CE)], fill);
  // Team-color fascia board along a slope's eave edge (ownership read).
  let fascia = (sgn) => {
    X.strokeStyle = tc; X.lineWidth = 3.2 / UNIT_SCALE; // thick enough to read at gameplay zoom
    let p1 = P(-L-OV, sgn*(WE+1.5), CE-1.4), p2 = P(L+OV, sgn*(WE+1.5), CE-1.4);
    X.beginPath(); X.moveTo(p1.x,p1.y); X.lineTo(p2.x,p2.y); X.stroke();
  };
  // Plank seams down a slope (matches drawTCAnnexRoof's seam treatment).
  let seams = (sgn) => {
    X.strokeStyle = 'rgba(0,0,0,0.18)'; X.lineWidth = 1 / UNIT_SCALE;
    for (let t of [-0.5, 0, 0.5]) {
      let a = (L+OV) * t * 1.4;
      let p1 = P(a, sgn*(WE+1.5), CE-1.2), p2 = P(a, 0, CR);
      X.beginPath(); X.moveTo(p1.x,p1.y); X.lineTo(p2.x,p2.y); X.stroke();
    }
  };
  // The ram itself: an ALL-WOOD timber shaft (the forged iron head was
  // removed — a head redesign may come later). The tip shows plain end
  // grain where it faces the viewer. One spec, four projections; every
  // width comes from RLOG so it can't drift. Kept deliberately clean: no
  // rivets/ropes/grain at this sprite size (clean-over-busy).
  // All beam widths are GEOMETRY units (no /UNIT_SCALE): the beam must
  // scale with the body polygons.
  const GRAIN = '#8a6a4a'; // lighter end-grain wood at the cut tip
  let logBeam = () => {
    if (useDir === 5) return; // fully hidden from directly behind
    if (useDir === 6) {
      // NE back-diagonal: only the tip pokes past the FAR gable, emerging
      // from behind the roofline (called FIRST in the branch so the body
      // occludes its base). Hard damping (×0.35) and a short rest
      // protrusion: at height CE the beam projects ABOVE the far roofline,
      // so any long extension reads as a bar floating in mid-air behind
      // the shed.
      let d6 = dLog * 0.35;
      let tip = L + 5.2 + d6;
      let q1 = P(L + 0.6, 0, CE), q2 = P(tip, 0, CE);
      // outlined flat-ended quad; the shaft is WIDENED to the end disc's
      // exact screen extent perpendicular to the shaft, so shaft and tip
      // read as one radius
      let qdx=q2.x-q1.x, qdy=q2.y-q1.y, ql=Math.hypot(qdx,qdy)||1;
      let qux=-qdy/ql, quy=qdx/ql;
      let qw = RLOG * Math.hypot(v.x*qux + v.y*quy, quy);
      let qnx=qux*qw, qny=quy*qw;
      // the cut face points AWAY from the viewer here — no end disc at
      // all, just the shaft's clean outlined silhouette with a flat tip
      X.fillStyle = '#6e473b'; X.strokeStyle = '#000'; X.lineWidth = 1 / UNIT_SCALE; X.lineJoin='round';
      X.beginPath();
      X.moveTo(q1.x+qnx,q1.y+qny); X.lineTo(q2.x+qnx,q2.y+qny);
      X.lineTo(q2.x-qnx,q2.y-qny); X.lineTo(q1.x-qnx,q1.y-qny);
      X.closePath(); X.fill(); X.stroke();
      return;
    }
    if (useDir === 1) {
      // Head-on: the log's end grain surges at the viewer. Swells slightly
      // on the thrust, shrinks back into the opening on windup.
      let p = P(L + 1.5 + dLog*0.55, 0, CE);
      let rr = Math.max(1.8, RLOG + dLog*0.13);
      X.fillStyle = '#6e473b'; X.strokeStyle = '#000'; X.lineWidth = lw;
      X.beginPath(); X.arc(p.x, p.y, rr, 0, Math.PI*2); X.fill(); X.stroke();
      X.fillStyle = GRAIN;
      X.beginPath(); X.arc(p.x, p.y, rr*0.62, 0, Math.PI*2); X.fill();
      return;
    }
    // SE front-diagonal. The shaft STARTS at the opening plane (a=L) — so
    // retracting genuinely slides it into the dark hole and the thrust
    // makes it burst out. The cut face points toward the viewer here, so
    // the tip shows the lit END GRAIN disc.
    let tip = L + 6 + dLog;
    let p1 = P(L - 0.8, 0, CE), p2 = P(tip, 0, CE);
    // outlined flat-ended quad, widened to the end disc's perpendicular
    // screen extent (see NE note) — then the lit end-grain disc
    let pdx=p2.x-p1.x, pdy=p2.y-p1.y, pl=Math.hypot(pdx,pdy)||1;
    let pux=-pdy/pl, puy=pdx/pl;
    let pw = RLOG * Math.hypot(v.x*pux + v.y*puy, puy);
    let pnx=pux*pw, pny=puy*pw;
    // fill the shaft but stroke ONLY the two long edges: the unstroked
    // back end vanishes into the opening's dark ellipse, so the log reads
    // as emerging from the hole instead of butting flat against the box
    // (the tip's end disc covers the front edge)
    X.fillStyle = '#6e473b';
    X.beginPath();
    X.moveTo(p1.x+pnx,p1.y+pny); X.lineTo(p2.x+pnx,p2.y+pny);
    X.lineTo(p2.x-pnx,p2.y-pny); X.lineTo(p1.x-pnx,p1.y-pny);
    X.closePath(); X.fill();
    X.strokeStyle = '#000'; X.lineWidth = 1 / UNIT_SCALE; X.lineCap='butt';
    X.beginPath(); X.moveTo(p1.x+pnx,p1.y+pny); X.lineTo(p2.x+pnx,p2.y+pny); X.stroke();
    X.beginPath(); X.moveTo(p1.x-pnx,p1.y-pny); X.lineTo(p2.x-pnx,p2.y-pny); X.stroke();
    // true perpendicular end disc showing the lit END GRAIN (cut face
    // points toward the viewer here)
    X.save(); X.transform(v.x, v.y, 0, -1, p2.x, p2.y);
    X.beginPath(); X.arc(0, 0, RLOG, 0, Math.PI*2);
    X.restore();
    X.fillStyle = GRAIN; X.fill();
    X.strokeStyle = '#000'; X.lineWidth = 0.9 / UNIT_SCALE; X.stroke();
    // exit seam: a short black line across the shaft at the panel plane
    // (a=L), a touch wider than the shaft — pins the log to the front
    // panel so it reads as coming out THROUGH it
    // seam center shifted along the shaft's perpendicular (lower-left in
    // SE, mirrored to lower-right in SW) to align with the shaft's axis
    let ex = P(L, 0, CE + 0.4);
    ex = { x: ex.x + pux*0.45, y: ex.y + puy*0.45 };
    X.strokeStyle = '#000'; X.lineWidth = 1.3 / UNIT_SCALE; X.lineCap='round';
    X.beginPath();
    X.moveTo(ex.x+pux*(pw+1.1), ex.y+puy*(pw+1.1));
    X.lineTo(ex.x-pux*(pw+1.1), ex.y-puy*(pw+1.1));
    X.stroke(); X.lineCap='butt';
  };
  // Dark opening in a gable face that the log emerges from. MUST be
  // clearly larger than the log's screen cross-section (half-width
  // ~RLOG*1.1) so a dark ring shows AROUND the shaft — a hole smaller than
  // the log can never read as the log passing through it. Drawn BEHIND the
  // log; the shaft's cut base hides inside the dark area.
  let opening = (a) => {
    let p = P(a, 0, CE);
    X.fillStyle = '#2a1f14';
    X.beginPath(); X.ellipse(p.x, p.y, 4.6, 5.1, 0, 0, Math.PI*2); X.fill();
    X.strokeStyle = '#000'; X.lineWidth = 0.9 / UNIT_SCALE; X.stroke();
  };
  // Cross-brace X on the rear gable (plain planks otherwise).
  let brace = (a) => {
    X.strokeStyle = WOOD.beam; X.lineWidth = 1.4 / UNIT_SCALE;
    let c1=P(a,-WB+1,CB+1), c2=P(a,WB-1,CE-1), c3=P(a,WB-1,CB+1), c4=P(a,-WB+1,CE-1);
    X.beginPath(); X.moveTo(c1.x,c1.y); X.lineTo(c2.x,c2.y);
    X.moveTo(c3.x,c3.y); X.lineTo(c4.x,c4.y); X.stroke();
  };

  // Wheel layout: three axles at a = -WA/0/+WA, mounted OUTSIDE the shed
  // (AoE2) — fully visible, overlapping the skirt from in front on the
  // near side, peeking past the body on the far side. Head-on, the square
  // slabs stick out at the sides beyond the eave line. wheelPair draws
  // ONE side's wheels sorted by projected screen depth, so the nearer
  // wheel always paints over the farther one in every facing.
  let wa = WA, wb = WB + 1.1, wbThin = WE + 1.2;
  let wheelPair = (bSide) => {
    // Head-on the true axle spacing climbs the stack too far up the body;
    // compress it toward the NEAR end so the squares hug the ground line
    // (the depth stagger stays, just tighter).
    let thin = (useDir === 1 || useDir === 5);
    let nearA = useDir === 5 ? -wa : wa;
    let m = a => thin ? nearA - (nearA - a) * 0.5 : a;
    [{a:-wa},{a:0},{a:wa}].map(w=>({a:m(w.a), y:P(m(w.a),bSide,WR).y}))
      .sort((w1,w2)=>w1.y-w2.y)
      .forEach(w=>wheel(w.a,bSide,WR));
  };

  if (useDir === 7) {
    // TRUE PROFILE (E/W): a dedicated side ELEVATION, like the horse's
    // profile pose — no iso box math. Viewer looks straight along the
    // width axis: side wall below, the near roof slope as a band up to
    // the horizontal ridge (slightly inset at the top ends so it doesn't
    // read as a flat box), gable ends edge-on, log dead horizontal at the
    // front. Ground at y=0, front = +x; the facing mirror makes W.
    // Same physical model, elevation projection: lengths/heights map 1:1,
    // then the whole pose is scaled by the size-constancy factor (see
    // RAM_PROFILE_K) about the ground anchor.
    X.scale(RAM_PROFILE_K, RAM_PROFILE_K);
    const PL = L, PWAL = CB, PEAVE = CE, PRIDGE = CR, PWR = WR, PWA = WA;
    let el = (pts, fill) => poly(pts.map(([x2,y2]) => ({x:x2, y:y2})), fill);
    // far wheel row: the viewer sits above the ground plane, so the far
    // side's wheels peek slightly HIGHER; dark silhouettes only.
    X.fillStyle = '#241a10';
    [-PWA, 0, PWA].forEach(x2 => {
      X.beginPath(); X.arc(x2 + 1, -PWR - 2, PWR, 0, Math.PI*2); X.fill();
    });
    // Log BEHIND the body: in a true side view a cylinder IS a rectangle —
    // no end-face ellipse, no perspective. Drawn before the wall/roof so
    // the shed occludes its base and it reads as sliding out of the front.
    // ALL WOOD (the iron head was removed; redesign may come later).
    {
      let xTip = PL + 6 + dLog, h2 = RLOG, y0 = -PEAVE;
      X.fillStyle = '#6e473b';
      X.strokeStyle = '#000'; X.lineWidth = 1 / UNIT_SCALE;
      X.beginPath(); X.rect(PL - 4, y0 - h2, xTip - (PL - 4), h2*2); X.fill(); X.stroke();
    }
    // side wall
    el([[-PL,-PWAL],[PL,-PWAL],[PL,-PEAVE],[-PL,-PEAVE]], WOOD.plankR);
    // roof band: eave to ridge, ridge inset for depth
    el([[-PL-1.2,-PEAVE],[PL+1.2,-PEAVE],[PL-0.6,-PRIDGE],[-PL+0.6,-PRIDGE]], WOOD.plankL);
    // plank seams following the end slant
    X.strokeStyle = 'rgba(0,0,0,0.18)'; X.lineWidth = 1 / UNIT_SCALE;
    for (let t of [-0.5, 0, 0.5]) {
      X.beginPath();
      X.moveTo((PL+1.2) * t * 1.4, -PEAVE);
      X.lineTo((PL-0.6) * t * 1.4, -PRIDGE);
      X.stroke();
    }
    // team fascia along the eave
    X.strokeStyle = tc; X.lineWidth = 3.2 / UNIT_SCALE; // thick enough to read at gameplay zoom
    X.beginPath(); X.moveTo(-PL-1.2, -PEAVE+0.6); X.lineTo(PL+1.2, -PEAVE+0.6); X.stroke();
    // near wheel row, full circles with the rolling spoke
    [-PWA, 0, PWA].forEach(x2 => {
      X.fillStyle = '#5a4630';
      X.strokeStyle = '#1d150c'; X.lineWidth = 0.9 / UNIT_SCALE;
      X.beginPath(); X.arc(x2, -PWR, PWR, 0, Math.PI*2); X.fill(); X.stroke();
      let ang = rolling ? wheelRot : 0.6;
      X.strokeStyle = '#3a2c1c'; X.lineWidth = 1 / UNIT_SCALE;
      X.beginPath();
      X.moveTo(x2 - Math.cos(ang)*PWR*0.7, -PWR - Math.sin(ang)*PWR*0.7);
      X.lineTo(x2 + Math.cos(ang)*PWR*0.7, -PWR + Math.sin(ang)*PWR*0.7);
      X.stroke();
      X.fillStyle = '#8a6a4a';
      X.beginPath(); X.arc(x2, -PWR, 0.8, 0, Math.PI*2); X.fill();
    });
  } else if (useDir === 0) {
    // SE front-diagonal: far wheels → far slope sliver → near skirt +
    // front gable → dark opening → LOG through it → near slope. The hole
    // is bigger than the shaft, so its dark ring shows around the log and
    // the log's cut base hides inside the darkness — clearly exiting the
    // port.
    wheelPair(-wb);
    slope(-1, WOOD.plankL);
    skirt(1, WOOD.plankR);
    // plank front panel, NO hole — the log simply rides over the face
    // (the near slope drawn after laps its exit from above)
    gable(L, WOOD.plankR);
    logBeam();
    wheelPair(wb); // exterior wheels over the skirt, under the roof overhang
    slope(1, WOOD.plankL); seams(1); fascia(1);
  } else if (useDir === 6) {
    // NE back-diagonal: log (far side, mostly hidden) → far wheels →
    // near slope is the DOWN-facing one; rear gable toward the viewer.
    logBeam(); // far tip first: everything after occludes its base
    wheelPair(-wb);
    slope(-1, WOOD.plankL);
    skirt(1, WOOD.plankR);
    gable(-L, WOOD.plankR);
    brace(-L);
    wheelPair(wb); // exterior wheels over the skirt, under the roof overhang
    slope(1, WOOD.plankL); seams(1); fascia(1);
  } else if (useDir === 1) {
    // S head-on: rear slopes as flanks behind, front gable dominant,
    // foreshortened log cap pointing at the viewer.
    // Wheel stacks FIRST: all three axles show as a receding ladder of
    // squares at each side, but the body paints over them — wheels live
    // beside/under the ram, never on top of it. wheelPair keeps the
    // far-to-near order within each stack.
    wheelPair(-wbThin); wheelPair(wbThin);
    slope(-1, WOOD.plankL); slope(1, WOOD.plankR);
    seams(1); seams(-1);
    // plank front panel, NO hole — the log's end disc rides over the face
    gable(L, WOOD.plankR);
    fascia(1); fascia(-1);
    logBeam();
  } else {
    // N back view: rear gable toward the viewer, both slopes rising away.
    // The far/front gable (a=+L) is fully hidden by the roof — don't draw
    // it, or it paints over the slopes (painter's order).
    // wheel stacks first — same occluded-by-body rule as S
    wheelPair(-wbThin); wheelPair(wbThin);
    slope(-1, WOOD.plankL); slope(1, WOOD.plankR);
    seams(1); seams(-1);
    gable(-L, WOOD.plankL);
    brace(-L);
    fascia(1); fascia(-1);
  }

  X.restore();
}

// ---- DRAFT QUADRUPED (ox) ----
// Horse-derived body/legs (see the mount block in drawUnit) RESHAPED via the
// `p` profile so it reads as an OX rather than a recolored horse: a heavy
// barrel, a shoulder hump, a short neck carried LOW, a blocky head, and curved
// horns. Drawn in drawUnit's translated/mirrored/scaled context at the animal's
// ground origin, same convention as the horse. Only the 5 right-facing poses
// are authored ({0,1,5,6,7}); mirroredDir folds the left three onto them. Legs
// plod on the shared clock while moving. `p` supplies colors + a few shape
// knobs so the same routine can back other draft animals later.
function drawQuadruped(e, p){
  let useDir = mirroredDir(e);
  let moving = e.path && e.path.length>0 && !e.corpseRot;
  let walk = moving ? Math.sin(tick*0.4 + e.id)*p.walkAmp : 0; // oxen plod: shorter, slower stride
  let idle = !moving;
  let swish = e.corpseRot ? 0 : Math.sin(tick*0.08+e.id)*(idle?0.18:0.07);
  let nod = (idle && !e.corpseRot) ? Math.sin(tick*0.05+e.id)*0.5 : 0; // a dead ox's head doesn't bob
  const coat=p.coat, dark=p.maneC, legC=p.legC, hornC=p.hornC;
  const LT=p.legTop, LB=p.legBot;
  X.save(); X.translate(0,-1); X.scale(p.scale, p.scale);
  X.lineJoin='round';

  // One FILLED crescent horn (single path, outer-silhouette stroke only —
  // the old fat stroke-curls read as white bananas): broad at the poll,
  // sweeping out along sd, tapering to an upturned tip.
  let horn=(bx,by,sd,s,rot=0)=>{
    X.save(); X.translate(bx,by); if(rot) X.rotate(rot);
    X.fillStyle=hornC; X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
    X.beginPath();
    X.moveTo(0, 1.0*s);
    X.quadraticCurveTo(sd*3.1*s, 1.1*s, sd*4.0*s, -1.6*s);  // long outward sweep
    X.quadraticCurveTo(sd*4.4*s, -3.0*s, sd*3.6*s, -3.4*s); // high upturned tip
    X.quadraticCurveTo(sd*2.4*s, -1.3*s, 0, -0.5*s);
    X.closePath(); X.fill(); X.stroke();
    X.restore();
  };
  // small droopy ear, tucked behind/below the horn
  let ear=(xx,yy,rot)=>{
    X.fillStyle=dark; X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
    X.beginPath(); X.ellipse(xx,yy,1.5,0.9,rot,0,Math.PI*2); X.fill(); X.stroke();
  };

  // Tail (rump end): drawn first for profile/SE so the legs/body overlap it.
  if(useDir===7||useDir===0){
    let k = useDir===7?1:0.74;
    X.save(); X.translate(-6.8*k,-7.5); X.rotate(swish);
    X.beginPath(); X.moveTo(0,0); X.quadraticCurveTo(-2.4*k,3,-1.8*k,8.5);
    X.strokeStyle='#000'; X.lineWidth=3.0/UNIT_SCALE; X.lineCap='round'; X.stroke();
    X.strokeStyle=dark; X.lineWidth=1.6/UNIT_SCALE; X.stroke();
    X.fillStyle=dark; X.beginPath(); X.arc(-1.8*k,8.9,1.4,0,Math.PI*2); X.fill(); // tuft
    X.lineCap='butt'; X.restore();
  }

  // Legs — shorter, stockier than the horse, same swing scheme.
  {
    X.beginPath();
    if(useDir===1||useDir===5){
      X.moveTo(-3.2,LT); X.lineTo(-3.2, LB+walk);
      X.moveTo(3.2,LT);  X.lineTo(3.2, LB-walk);
      X.moveTo(-4.6,LT); X.lineTo(-4.6, LB-1-walk);
      X.moveTo(4.6,LT);  X.lineTo(4.6, LB-1+walk);
    } else if(useDir===7){
      X.moveTo(3.6,LT); X.lineTo(3.6+walk, LB);
      X.moveTo(5.6,LT); X.lineTo(5.6-walk, LB);
      X.moveTo(-4.6,LT);X.lineTo(-4.6+walk, LB);
      X.moveTo(-6.6,LT);X.lineTo(-6.6-walk, LB);
    } else {
      let fy=useDir===6?LB-1:LB, ry=useDir===6?LB:LB-1;
      X.moveTo(3.6,LT); X.lineTo(3.6+walk, fy);
      X.moveTo(5.4,LT); X.lineTo(5.4-walk, fy);
      X.moveTo(-3.4,LT);X.lineTo(-3.4+walk, ry);
      X.moveTo(-5.0,LT);X.lineTo(-5.0-walk, ry);
    }
    X.strokeStyle='#000'; X.lineWidth=3.4/UNIT_SCALE; X.lineCap='round'; X.stroke();
    X.strokeStyle=legC; X.lineWidth=1.9/UNIT_SCALE; X.stroke(); X.lineCap='butt';
    let hoof;
    if(useDir===1||useDir===5) hoof=[[-3.2,LB+walk],[3.2,LB-walk],[-4.6,LB-1-walk],[4.6,LB-1+walk]];
    else if(useDir===7) hoof=[[3.6+walk,LB],[5.6-walk,LB],[-4.6+walk,LB],[-6.6-walk,LB]];
    else { let fy=useDir===6?LB-1:LB, ry=useDir===6?LB:LB-1; hoof=[[3.6+walk,fy],[5.4-walk,fy],[-3.4+walk,ry],[-5.0-walk,ry]]; }
    X.fillStyle='#1e1408';
    hoof.forEach(h=>{X.beginPath();X.ellipse(h[0],h[1]+0.4,1.6,1.2,0,0,Math.PI*2);X.fill();});
  }

  X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;

  if(useDir===7||useDir===0){
    let k=useDir===7?1:0.74;
    // heavy barrel
    X.fillStyle=coat; X.beginPath(); X.ellipse(0,-6.5, 8.0*k, 5.6, 0,0,Math.PI*2); X.fill(); X.stroke();
    // Working-ox head carriage: thick neck sloping DOWN from the withers,
    // the head carried clearly BELOW the topline, with a long face ending
    // in a broad blunt muzzle and a dewlap fold hanging under the throat.
    // One open path (fill closes it invisibly inside the barrel; the
    // stroke stays open so no seam cuts across the body).
    X.save(); X.translate(1.2*k, nod); // head pulled back toward the body
    X.fillStyle=coat; X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
    X.beginPath();
    X.moveTo(4.8*k,-10.8);                            // withers (inside the barrel)
    X.quadraticCurveTo(8.5*k,-9.6, 11.2*k,-8.0);      // thick neck sloping down
    X.quadraticCurveTo(12.5*k,-8.2, 12.9*k,-7.2);     // low poll / brow
    X.quadraticCurveTo(15.0*k,-5.6, 15.4*k,-3.4);     // LONG face down to the muzzle
    X.quadraticCurveTo(15.7*k,-2.2, 14.2*k,-2.2);     // broad blunt muzzle
    X.quadraticCurveTo(11.8*k,-2.6, 9.6*k,-3.8);      // jaw back to the cheek
    X.quadraticCurveTo(8.6*k,-2.7, 7.2*k,-3.3);       // dewlap: loose fold hanging
    X.quadraticCurveTo(6.0*k,-3.0, 4.4*k,-4.8);       //   under the throat into the chest
    X.fill(); X.stroke();
    ear(10.6*k,-7.5, -0.3);                           // droopy ear behind the poll
    horn(11.6*k,-8.1, 1, 1.25*k, -0.5);               // near horn from the poll top, up-forward (exaggerated)
    X.fillStyle='#000';
    X.beginPath(); X.arc(12.7*k,-6.0,0.7,0,Math.PI*2); X.fill();   // eye high on the long face
    X.beginPath(); X.arc(14.7*k,-3.0,0.5,0,Math.PI*2); X.fill();   // nostril
    X.restore();
  } else if(useDir===6){
    // NE back-diagonal: rump near, head recedes.
    X.fillStyle=coat; X.beginPath(); X.ellipse(0,-6.5, 7.0, 5.6, 0,0,Math.PI*2); X.fill(); X.stroke();
    X.save(); X.translate(-5.6,-7); X.rotate(swish); // near tail
    X.beginPath(); X.moveTo(0,0); X.quadraticCurveTo(-2.2,3,-1.6,8.5);
    X.strokeStyle='#000'; X.lineWidth=3.0/UNIT_SCALE; X.lineCap='round'; X.stroke();
    X.strokeStyle=dark; X.lineWidth=1.6/UNIT_SCALE; X.stroke(); X.lineCap='butt'; X.restore();
    X.save(); X.translate(1.4,nod);
    // back-ish view of the low head (horse logic): short thick neck wedge,
    // then the head ball seen from behind with BOTH horns sweeping out
    X.fillStyle=coat; X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
    X.beginPath();
    X.moveTo(1.0,-8.6); X.quadraticCurveTo(2.8,-11.3, 4.3,-11.9); // left edge pulled left: wider neck
    X.lineTo(6.2,-11.5); X.quadraticCurveTo(5.7,-9.2, 5.1,-7.4);
    X.fill(); X.stroke();
    // kept simple: just the head circle and the two horns
    X.beginPath(); X.arc(5.6,-11.9,2.1,0,Math.PI*2); X.fill(); X.stroke(); // head, low
    horn(4.3,-12.2, -1, 1.0, 0.15); horn(6.8,-12.4, 1, 1.0, -0.3); // both horns, out and up
    X.restore();
  } else if(useDir===1){
    // S head-on: body behind; the head hangs LOW in front of the chest —
    // broad flat poll, long face tapering to a broad muzzle near the
    // ground, horns from the poll's top corners, horizontal droopy ears.
    X.fillStyle=coat; X.beginPath(); X.ellipse(0,-6, 6.4,5.6,0,0,Math.PI*2); X.fill(); X.stroke();
    X.save(); X.translate(0,nod);
    // dewlap hint: a soft fold peeking below the muzzle
    X.fillStyle=coat; X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
    X.beginPath(); X.ellipse(0,-1.3,2.7,1.1,0,0,Math.PI*2); X.fill(); X.stroke();
    X.beginPath();
    X.moveTo(-3.6,-8.8);
    X.quadraticCurveTo(-3.9,-5.2, -2.5,-2.8);         // cheeks taper down the long face
    X.quadraticCurveTo(0,-1.5, 2.5,-2.8);             // broad blunt muzzle
    X.quadraticCurveTo(3.9,-5.2, 3.6,-8.8);
    X.quadraticCurveTo(0,-10.4, -3.6,-8.8);           // broad flat poll
    X.closePath(); X.fill(); X.stroke();
    ear(-4.6,-8.4, 0.15); ear(4.6,-8.4, -0.15);       // ears held out horizontally
    horn(-2.6,-9.0, -1, 1.5); horn(2.6,-9.0, 1, 1.5); // horn pair from the poll corners (exaggerated)
    X.fillStyle='#000';
    X.beginPath(); X.arc(-2.0,-6.6,0.7,0,Math.PI*2); X.fill();     // wide-set eyes
    X.beginPath(); X.arc(2.0,-6.6,0.7,0,Math.PI*2); X.fill();
    X.beginPath(); X.arc(-0.9,-2.9,0.5,0,Math.PI*2); X.fill();     // nostrils
    X.beginPath(); X.arc(0.9,-2.9,0.5,0,Math.PI*2); X.fill();
    X.restore();
  } else {
    // N back view: with the low head carriage the head hides behind the
    // body — only the poll sliver, horn crescents and ear tips peek above
    // the topline. Rump + tail nearest.
    X.save(); X.translate(0,nod);
    X.fillStyle=coat; X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
    X.beginPath(); X.ellipse(0,-12.2,2.5,1.5,0,0,Math.PI*2); X.fill(); X.stroke(); // poll sliver
    ear(-3.2,-11.9, 0.3); ear(3.2,-11.9, -0.3);
    horn(-1.6,-12.6, -1, 1.2); horn(1.6,-12.6, 1, 1.2); // horn tips peek from behind
    X.restore();
    X.fillStyle=coat; X.beginPath(); X.ellipse(0,-6,6.2,5.6,0,0,Math.PI*2); X.fill(); X.stroke(); // body
    X.save(); X.translate(0,-3.5); X.rotate(swish); // tail down center
    X.beginPath(); X.moveTo(0,0); X.quadraticCurveTo(-0.7,4,0,8);
    X.strokeStyle='#000'; X.lineWidth=3.0/UNIT_SCALE; X.lineCap='round'; X.stroke();
    X.strokeStyle=dark; X.lineWidth=1.6/UNIT_SCALE; X.stroke(); X.lineCap='butt'; X.restore();
  }
  X.restore();
}

// ---- TRADE CART: ox-drawn covered wagon ----
// Reuses the ram's iso projection (RAM_AXES / mirroredDir) and wheel machinery,
// swapping the ram shed for a covered canvas tilt and yoking an ox
// (drawQuadruped) at the front. Gold cargo rides hidden under the canvas.
// Drawn inside drawUnit's translated + mirrored + scaled context, coords local
// px around the ground anchor.
// The trade cart's ONE canonical load: crate + sack + gold, drawn
// identically on the living cart (every trade phase — kept constant for
// visual consistency) and through the death sequence. `pos(key, dx, dy)`
// maps each piece's local offset from the load anchor to its final center,
// which lets the wreck spill the pieces apart along their own paths.
function drawCartLoad(pos, lw){
  X.lineJoin='round';
  // one BIG plump grain sack, tied at the neck — clean over busy
  let p = pos('sack', 0, -3.0);
  X.strokeStyle='#000'; X.lineWidth=lw; X.fillStyle='#cdb98c';
  X.beginPath(); X.ellipse(p.x, p.y, 5.2, 5.6, 0, 0, Math.PI*2); X.fill(); X.stroke();
  X.fillStyle='#cdb98c';
  X.beginPath(); X.ellipse(p.x+1.6, p.y-6.3, 1.9, 1.3, 0.5, 0, Math.PI*2); X.fill(); X.stroke();
  X.strokeStyle=WOOD.beam; X.lineWidth=1.2/UNIT_SCALE;
  X.beginPath(); X.moveTo(p.x-0.6, p.y-5.1); X.lineTo(p.x+2.4, p.y-4.5); X.stroke();
  X.strokeStyle='#000'; X.lineWidth=lw; X.fillStyle='#b6a074';
  X.beginPath(); X.ellipse(p.x+1.1, p.y+1.9, 2.2, 2.5, 0, 0, Math.PI*2); X.fill();
}

const CART_DIM = { L:8, WB:4.4, CB:2.4, CH:7.6, TILT:8.5, WR:5.4, WA:9, WTH:1.3, SCALE:1.32, GAP:3 };
// Shift (in a-units) that recenters the whole bed+ox composite on the unit
// anchor — half of the rig's span from the bed's rear to the ox's muzzle.
const CART_RECENTER = 13.5;
const OX_PROFILE = { coat:'#8d6b47', maneC:'#5a3f28', legC:'#705232', hornC:'#ece4cf', scale:1.2, walkAmp:3.0, legTop:-4, legBot:3.8 };
function drawTradeCartBody(e){
  let useDir = mirroredDir(e);
  // E/W uses the true side-elevation basis: straight-on profile, not the
  // slightly-rotated generic dir-7 basis (matches the ram's profile pose)
  let ax = useDir === 7 ? SIDE_AXES : (RAM_AXES[useDir] || SIDE_AXES);
  let u = ax.u, v = ax.v;
  let P = (a,b,c) => ({ x:a*u.x + b*v.x, y:a*u.y + b*v.y - c });
  const { L, WB, CB, CH, TILT, WR, WA, WTH, SCALE, GAP } = CART_DIM;
  let tc = teamColor(e.team), tcD = teamColorDark(e.team);
  let rolling = e.path.length > 0;
  // Whether the ox draws ON TOP of the wagon (ox nearer the camera). For the
  // side profile (E/W, dir7) the cart reads better drawn in FRONT of the ox,
  // so 7 is excluded here (ox drawn first, wagon laps over it).
  let frontNear = (useDir===0 || useDir===1);

  // Rolling creak — same cadence/counter as the ram.
  if (rolling && !window._maskDraw && window.playSound) {
    let ck = Math.floor((tick + e.id*7)/90);
    if (ramCreakCycles.get(e.id) !== ck) {
      if (ramCreakCycles.has(e.id) && (GAME_SPEED<4 || ck%2===0)) playSound('ram_creak', e.x, e.y);
      ramCreakCycles.set(e.id, ck);
    }
  }

  X.save();
  if (rolling) X.translate(0, Math.sin(tick*0.2+e.id)*0.5);
  // Recenter the RIG on the unit anchor: the ox extends far ahead of the
  // bed, so shift the whole drawing back along the facing axis — the
  // anchor (pathing position, shadow, selection) sits mid-composite.
  X.translate(-u.x*CART_RECENTER*SCALE, -u.y*CART_RECENTER*SCALE);

  // Ox yoked ahead along the movement axis. Drawn in its own UNIT_SCALE space
  // (drawQuadruped applies its own scale); the offset uses the CART-scaled
  // projection so it lines up with the wagon's front. Grounding: the ox's
  // origin sits a hoof-height ABOVE its feet, and the wagon's near wheels sit a
  // half-width BELOW the axle center — offset y by (nearWheelDrop − hoofDrop)
  // so the ox's hooves land on the wagon's near-wheel contact line (level).
  //
  // The hitch gap is per-facing: the projection compresses the offset along
  // u (head-on |u.y|=0.55) but the drawn ART doesn't compress, so a single
  // world-space GAP left the ox's hindquarters buried in the bed on some
  // facings. Values tuned so the ox's rump just clears the wagon front with
  // the shafts visibly bridging the gap.
  const HITCH_GAP = {7:12.5, 0:10, 6:10, 1:14, 5:14};
  let gap = HITCH_GAP[useDir] !== undefined ? HITCH_GAP[useDir] : GAP;
  let hoofDrop = OX_PROFILE.legBot*OX_PROFILE.scale - 1;
  let nearDrop = SCALE*(WB+0.4)*Math.abs(v.y);
  let oxOff = { x: SCALE*(L+gap)*u.x, y: SCALE*(L+gap)*u.y + nearDrop - hoofDrop };
  let drawOx = () => { X.save(); X.translate(oxOff.x, oxOff.y); drawQuadruped(e, OX_PROFILE); X.restore(); };
  // Hitch: a PARALLEL pair of shaft rods, one along each side of the ox,
  // from the wagon's front top corners to the shoulder area. Same ±WB
  // perpendicular offset at both ends keeps them parallel on screen, and
  // riding high (bed top rim → just under the topline) lets the far rod
  // show above the body silhouette instead of vanishing behind it. The +v
  // side is nearer the camera on every authored facing: far rod draws
  // before the ox, near rod after, lying visibly along the flank. Head-on
  // (v.y=0, sides are pure left/right) both draw behind the ox so nothing
  // crosses the face.
  let rod = sgn => {
    let a = { x: SCALE*P(L, sgn*WB, CH-1).x, y: SCALE*P(L, sgn*WB, CH-1).y };
    // ox end rises to the withers (above the topline, ~-12.3 local) so the
    // far rod is actually visible over the back instead of hiding behind
    // it; the far rod gets extra lift — in iso the far side genuinely sits
    // higher on screen, and without it the body swallows the whole rod
    let lift = (sgn<0 && !headOn) ? 2.5 : 0;
    let b = { x: oxOff.x + SCALE*(3.8*u.x + WB*v.x*sgn), y: oxOff.y + SCALE*(3.8*u.y + WB*v.y*sgn) - 12 - lift };
    X.lineCap='round';
    X.strokeStyle='#000'; X.lineWidth=2.8/UNIT_SCALE; X.beginPath(); X.moveTo(a.x,a.y); X.lineTo(b.x,b.y); X.stroke();
    X.strokeStyle=WOOD.beam; X.lineWidth=1.4/UNIT_SCALE; X.beginPath(); X.moveTo(a.x,a.y); X.lineTo(b.x,b.y); X.stroke();
    X.lineCap='butt';
  };
  let headOn = (useDir===1 || useDir===5);
  // Paint order around the wagon: the far rod always sits behind the ox;
  // the near rod lies over BOTH the ox and the wagon (it's the closest
  // thing to the camera along its whole run), so on facings where the
  // wagon draws after the ox (E/W profile, NE) it must wait for the wagon.
  let hitchPre, hitchPost;
  if (headOn) {
    let grp = () => { rod(-1); rod(1); drawOx(); };
    hitchPre  = useDir===5 ? grp : null;   // facing away: whole hitch behind the wagon
    hitchPost = useDir===1 ? grp : null;   // facing viewer: whole hitch over the wagon
  } else if (frontNear) { // SE diagonal: wagon first, hitch entirely on top
    hitchPre  = null;
    hitchPost = () => { rod(-1); drawOx(); rod(1); };
  } else { // E/W profile, NE: far rod + ox behind the wagon, near rod over it
    hitchPre  = () => { rod(-1); drawOx(); };
    hitchPost = () => rod(1);
  }

  if (hitchPre) hitchPre();

  X.save(); X.scale(SCALE, SCALE);
  let lw = 1.2/UNIT_SCALE;
  let poly = (pts, fill) => {
    X.fillStyle=fill; X.beginPath(); pts.forEach((p,i)=>i?X.lineTo(p.x,p.y):X.moveTo(p.x,p.y)); X.closePath(); X.fill();
    X.strokeStyle='#000'; X.lineWidth=lw; X.lineJoin='round'; X.stroke();
  };
  // Wheels — proper spoked cartwheels: wooden rim ring, dark interior seen
  // through the spokes, 3 rotating spoke diameters, hub. Two axles (±WA/2).
  let wheelRot = tick*0.35 + e.id;
  // Edge-on wheel slab for the head-on facings (also used by the head-on
  // body assembly below).
  let slab = (a,b,r,w2) => {
    let p=P(a,b,r), h2=r*0.7;
    X.fillStyle='#33261a'; X.fillRect(p.x-w2,p.y-h2,w2*2,h2*2);
    X.strokeStyle='#1d150c'; X.lineWidth=0.9/UNIT_SCALE; X.strokeRect(p.x-w2,p.y-h2,w2*2,h2*2);
    X.fillStyle='#5a4630'; X.fillRect(p.x-0.6,p.y-h2+0.6,1.2,h2*2-1.2);
  };
  let wheel = (a,b,r) => {
    if (useDir===1||useDir===5) { slab(a,b,r,WTH*1.15); return; }
    // CHARIOT wheel: a big open ring — wooden rim annulus, spokes, hub —
    // with the world visible THROUGH the gaps (no solid interior disc, no
    // swept 3D tread).
    // the wheel's camera-side face: +v points toward the viewer, so the
    // NEAR wheel (b>0) faces at its outer plane b, but the FAR wheel (b<0)
    // faces at its inner plane b+WTH — getting this backwards drew the far
    // wheel's lit face behind its own dark rim
    let bF = b > 0 ? b : b + WTH, bB = b > 0 ? b - WTH : b;
    let pF=P(a,bF,r), pIn=P(a,bB,r);
    let discPath=(cx,cy,rr)=>{X.save();X.transform(u.x,u.y,0,-1,cx,cy);X.beginPath();X.arc(0,0,rr,0,Math.PI*2);X.restore();};
    let annulus=(cx,cy,fill)=>{
      X.save();X.transform(u.x,u.y,0,-1,cx,cy);
      X.beginPath();
      X.arc(0,0,r,0,Math.PI*2); X.arc(0,0,r-1.5,0,Math.PI*2,true);
      X.restore();
      X.fillStyle=fill; X.fill('evenodd');
    };
    // depth: the wheel's FAR rim face peeks behind the near one, dark
    annulus(pIn.x, pIn.y, '#453522');
    X.strokeStyle='#1d150c';X.lineWidth=0.7/UNIT_SCALE;
    discPath(pIn.x,pIn.y,r);X.stroke();
    // near rim face
    annulus(pF.x, pF.y, '#6b543a');
    X.strokeStyle='#1d150c';X.lineWidth=0.9/UNIT_SCALE;
    discPath(pF.x,pF.y,r);X.stroke();
    discPath(pF.x,pF.y,r-1.5);X.stroke();
    // 3 spoke diameters (6 spokes) turning with the wheel
    let ang=(rolling?wheelRot:0.6);
    let sp=(A,t)=>({x:pF.x+(Math.cos(A)*u.x)*r*t, y:pF.y+(Math.cos(A)*u.y+Math.sin(A))*r*t});
    X.strokeStyle='#8a6a4a';X.lineWidth=1.4/UNIT_SCALE;
    for(let k=0;k<3;k++){
      let A=ang+k*Math.PI/3, s1=sp(A,-0.85), s2=sp(A,0.85);
      X.beginPath();X.moveTo(s1.x,s1.y);X.lineTo(s2.x,s2.y);X.stroke();
    }
    X.fillStyle='#8a6a4a';X.strokeStyle='#1d150c';X.lineWidth=0.7/UNIT_SCALE;
    X.beginPath();X.arc(pF.x,pF.y,r*0.2,0,Math.PI*2);X.fill();X.stroke();
  };
  // Classic two-wheeler: ONE large wheel per side on a single center axle.
  let wheelPair = (bSide) => wheel(0, bSide, WR);
  // OPEN wooden bed (no tarp) so the cargo shows. Colors — pieces on the
  // FAR side of the view show their shadowed INNER surface (bedInner);
  // near-side pieces show lit outer wood:
  let bedInner= '#74593a';
  let bedNear = '#a07c4c';
  let bedTop  = '#b48c58';
  let bedFloor= '#3a2c1c';
  // Plank seams: light interior strokes (convention: rgba .13, never hard
  // black inside one piece of timber).
  let seam = (p,q) => {
    X.strokeStyle='rgba(0,0,0,0.13)';X.lineWidth=0.8/UNIT_SCALE;
    X.beginPath();X.moveTo(p.x,p.y);X.lineTo(q.x,q.y);X.stroke();
  };
  let wall = (sgn, fill) => {
    poly([P(-L,sgn*WB,CB),P(L,sgn*WB,CB),P(L,sgn*WB,CH),P(-L,sgn*WB,CH)], fill);
    for(let t of [1/3,2/3]) seam(P(-L,sgn*WB,CB+(CH-CB)*t), P(L,sgn*WB,CB+(CH-CB)*t));
    if (sgn===1) for(let a of [-0.45*L,0.45*L]) seam(P(a,WB,CB), P(a,WB,CH)); // stakes on the near wall
  };
  let endBoard = (a, fill) => {
    poly([P(a,-WB,CB),P(a,WB,CB),P(a,WB,CH),P(a,-WB,CH)], fill);
    seam(P(a,0,CB), P(a,0,CH));
  };
  // Ownership read: the box's visible OUTER walls are painted flat team
  // color (a solid panel reads far better at gameplay zoom than the old
  // thin rim stripe). Interior faces/floor stay wood for contrast.
  // (cargo is the shared drawCartLoad — one canonical load, identical in
  // every trade phase and through the death sequence)

  // Assemble far→near. Near side is +WB for the authored right-facings.
  let nearB = WB+0.4, farB = -(WB+0.4);
  if (useDir===1 || useDir===5) {
    // Head-on (S/N): a real shallow open box using the projection's depth
    // (u.y=±0.55) instead of the old single flat plank — far board first,
    // thin side rails, floor, cargo peeking over the far rim, then the near
    // board and near wheels over it. Widened (like the ram's head-on v) so
    // it doesn't read as a narrow spike.
    let nearA = useDir===5 ? -L : L; // the end toward the camera
    let farA  = -nearA;
    // modest widening only (WB*1.25): the old 1.7 made the head-on cart
    // read wider than every other view
    let hw = WB*1.25, fw = hw*0.82, fh = CH*0.9; // far board slightly narrower/shorter (depth cue)
    // the single axle's two big wheel slabs, behind the body at its sides
    [-1,1].forEach(sd=>slab(0, sd*hw, WR, WTH*1.2));
    // far board — we're looking INTO the box, so it shows its inner face
    poly([P(farA,-fw,CB),P(farA,fw,CB),P(farA,fw,fh),P(farA,-fw,fh)], bedInner);
    // side rails, edge-on slivers tapering far→near (inner faces too)
    poly([P(farA,-fw,fh),P(nearA,-hw,CH),P(nearA,-hw,CB),P(farA,-fw,CB)], bedInner);
    poly([P(farA, fw,fh),P(nearA, hw,CH),P(nearA, hw,CB),P(farA, fw,CB)], bedInner);
    // interior floor
    poly([P(farA,-fw,CB),P(farA,fw,CB),P(nearA,hw,CB),P(nearA,-hw,CB)], bedFloor);
    // the load sits IN the box, sunk low between the boards: the near
    // board occludes its base, the top rising only to the far rim
    let cc=P(0,0,CH-3.4);
    drawCartLoad((k,dx,dy)=>({x:cc.x+dx, y:cc.y+dy}), lw);
    // near board: team-colored outer face with plank seams
    let bl=P(nearA,-hw,CB), br=P(nearA,hw,CB), tl=P(nearA,-hw,CH), tr=P(nearA,hw,CH);
    poly([bl,br,tr,tl], tc);
    seam(P(nearA,-hw,(CB+CH)/2), P(nearA,hw,(CB+CH)/2));
    for(let t of [-0.5,0,0.5]) seam(P(nearA,hw*t,CB), P(nearA,hw*t,CH));
  } else {
    // Which END faces away is view-dependent: for the up-facing diagonals
    // (u.y<0, NE/NW) the +L end points away — hardcoding back=-L left the
    // actually-near end painted early and buried under the floor, so the
    // box read as open at the back. Far pieces show their INNER faces.
    let farEnd = u.y < 0 ? L : -L, nearEnd = -farEnd;
    wheelPair(farB);
    wall(-1, bedInner);        // far side wall: inner face
    endBoard(farEnd, bedInner); // far end: inner face
    // open interior floor
    poly([P(-L,-WB,CB),P(L,-WB,CB),P(L,WB,CB),P(-L,WB,CB)], bedFloor);
    // the load sits INSIDE the open-topped box: drawn between the floor and
    // the near wall, so the wall occludes its base and only the tops peek
    // over the rim
    let cc=P(0,0,CH-2.2);
    drawCartLoad((k,dx,dy)=>({x:cc.x+dx, y:cc.y+dy}), lw);
    // near structure (open top): team-colored outer faces — side wall lit
    // (tc), end board shaded (tcD)
    wall(1, tc);
    endBoard(nearEnd, tcD);
    wheelPair(nearB);
  }
  X.restore();

  if (hitchPost) hitchPost();
  X.restore();
}

// Ground-shadow footprint per unit type, in TILE units: half-length along
// the body's facing and half-width across it. Radially-symmetric units set
// len==wid (facing then doesn't matter); elongated ones (mounts, bear) are
// longer along the body so their shadow stretches in profile and shortens
// head-on. Tuned so the humanoid footprint matches the old 6×3-ish ellipse.
const UNIT_SHADOW = {
  villager:{len:0.17,wid:0.17}, militia:{len:0.18,wid:0.18},
  spearman:{len:0.18,wid:0.18}, archer:{len:0.18,wid:0.18},
  scout:{len:0.42,wid:0.19},    knight:{len:0.44,wid:0.21},
  bear:{len:0.34,wid:0.26},     sheep:{len:0.17,wid:0.17},
  sheep_carcass:{len:0.22,wid:0.2},
  // Ram: big, elongated, and its wheels touch AT the anchor line (yoff),
  // unlike foot units whose feet sit ~6px above it. Goes through the same
  // rotated ground-oval path so its diagonal facings cast a tilted shadow.
  ram:{len:0.62,wid:0.34,yoff:1.5},
  tradecart:{len:0.7,wid:0.32,yoff:1.5}
};
// A grounded contact shadow: an oval lying on the iso ground plane,
// oriented to the unit's heading. Drawn by mapping the canvas into ground
// space (columns = the two iso tile axes, exactly toIso) then filling a
// rotated unit circle — so the 2:1 iso squash, the diagonal tilt, and the
// per-facing foreshortening all come from the projection, not hand-picked
// per-view ellipses. Origin nudged toward the lower-right, away from the
// upper-left light, matching the building shadows (buildingShadowPath).
function drawUnitShadow(e, sx, sy){
  let f = UNIT_SHADOW[e.utype] || {len:0.18, wid:0.18};
  let ta = (e.dir || 0) * Math.PI / 4; // facing angle in TILE space
  X.save();
  X.fillStyle = 'rgba(0,0,0,0.28)';
  // No horizontal nudge: units are small enough that the buildings' cast-
  // to-the-right offset reads as the shadow being off its feet rather than
  // as light direction — center it on the legs (origin x). Drop is per-type
  // (f.yoff): foot units' feet sit ~6px above the anchor, vehicles (ram)
  // contact the ground right at it. The ram's profile pose (dir 3/7 = W/E)
  // is drawn larger (RAM_PROFILE_K), riding its wheels a touch higher, so
  // its shadow tucks up to meet them.
  let yoff = f.yoff !== undefined ? f.yoff : 6;
  if(e.utype==='ram' && (e.dir===3 || e.dir===7)) yoff = -1.5;
  X.transform(HALF_TW, HALF_TH, -HALF_TW, HALF_TH, sx, sy + yoff);
  X.rotate(ta);
  if (e.utype === 'tradecart') {
    // TWO shadows for the recentered rig: one under the bed (behind the
    // anchor), one under the ox (ahead of it). The rig's recentering is a
    // SCREEN-space shift, so the offsets are fixed screen px converted to
    // tile units per facing (a tile-unit along the facing projects ~36px
    // on the diagonals but ~45px on E/W — one tile constant sat off-center
    // on SE/SW).
    let fxv = Math.cos(ta), fyv = Math.sin(ta);
    let slen = Math.hypot(fxv*HALF_TW - fyv*HALF_TW, fxv*HALF_TH + fyv*HALF_TH) || 1;
    // the head-on basis compresses the facing axis (|u|=0.55), so the
    // drawn rig only shifts ~55% as far on S/N — match it
    let ulen = (e.dir === 1 || e.dir === 5) ? 0.55 : 1;
    for (const [px, l, w2] of [[-22*ulen, 0.42, 0.30], [11.5*ulen, 0.30, 0.24]]) {
      X.save(); X.translate(px/slen, 0); X.scale(l, w2);
      X.beginPath(); X.arc(0, 0, 1, 0, Math.PI * 2); X.fill();
      X.restore();
    }
    X.restore();
    return;
  }
  X.scale(f.len, f.wid);
  X.beginPath(); X.arc(0, 0, 1, 0, Math.PI * 2); X.fill();
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
  let tc=teamColor(e.team);
  let anim=Math.sin(tick*0.15+e.id*2);
  let isActive=e.task||e.target||e.path.length>0;
  // "Moving" for animation = following a path OR pressing into contact this
  // tick (js/logic.js pressToContact sets e.pressWalk=tick when it steps). A
  // pressing unit walks at its normal pace now, so it should show the walk
  // cycle (legs), not the planted attack/idle pose, until it settles at contact.
  let moving = e.path.length>0 || e.pressWalk===tick;

  // Shadow — not part of the body silhouette: the outline mask pass must
  // skip it or the selection ring traces the shadow blob too.
  if(!window._maskDraw){
    // Every unit — ram included — uses the shared drawUnitShadow, which
    // projects a per-type ground oval through the real iso transform and
    // rotates it to the unit's facing. So a horse (or ram) in profile
    // casts a long flat shadow, head-on a shorter rounder one, and the
    // diagonal facings (SE/SW/NW/NE) a properly TILTED one.
    drawUnitShadow(e, sx, sy);
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
  let bob=moving?Math.sin(tick*0.3+e.id)*1.5:0;
  let sbob=moving?Math.sin(tick*0.2+e.id)*1:0;

  // Save context and apply horizontal flipping based on facing direction
  X.save();
  if(e.utype==='sheep'||e.utype==='bear') X.translate(sx, sy + sbob);
  // Vehicles don't head-bob — the ram applies its own subtle rolling sway
  else if(e.utype==='sheep_carcass'||e.utype==='ram'||e.utype==='tradecart') X.translate(sx, sy);
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
  } else if(e.utype==='ram'){
    drawRamBody(e);
  } else if(e.utype==='tradecart'){
    drawTradeCartBody(e);
  } else if(e.utype==='bear'){
    // Bear — heavy quadruped in the sheep's style: one black silhouette
    // pass, then fur fill. Side profile; X.scale(e.facing,…) flips it.
    let attacking = inActionRange(e) && !moving;
    // Chase/attack read: forward lunge while mauling, slight prowl sway walking
    let lunge = attacking ? Math.max(0, Math.sin(tick*0.35+e.id)) * 3 : 0;
    let sway = moving ? Math.sin(tick*0.25+e.id)*0.05 : 0;
    let breath = (!moving && !attacking && !e.corpseRot) ? Math.sin(tick*0.05+e.id)*0.25 : 0;

    X.save();
    X.rotate(sway);
    X.translate(lunge, 0);
    // Cartoon proportions: one huge boulder of a body on tiny stub legs.
    X.scale(1.4, 1.4);

    // Stub-leg walk cycle: comically short, thick legs mostly hidden
    // under the body mass — just paws scuttling along
    let lw1 = moving ? Math.sin(tick*0.5+e.id)*1.8 : 0;
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
        let idleM = !moving && !e.corpseRot;
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
      let walk = moving ? Math.sin(tick*0.45+e.id)*4.5 : 0;
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
      let idle = !moving && !e.corpseRot;
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
          let nod2 = (!moving) ? Math.sin(tick*0.05+e.id)*0.8 : 0;
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
      let walk = moving ? Math.sin(tick*0.4+e.id)*2.5 : 0;
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
      let sway = moving ? Math.sin(tick*0.4+e.id)*0.7 : 0;
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
      let armSwing = moving ? Math.sin(tick*0.4+e.id)*1.5 : 0;
      // While a villager works a tool, the front hand grips the handle base
      // (the tool's rotation anchor at (3,-9)) instead of hanging loose.
      let gripping = e.utype==='villager' && !moving &&
        (e.task==='chop'||e.task==='mine_gold'||e.task==='mine_stone'||e.task==='build');
      // Picking (berries/farm/butchering a carcass): no tool — the front arm
      // just reaches out and down repeatedly, like plucking. Carcass
      // harvesters are target-driven (no task), hence the extra check.
      let carcassTarget = !e.task&&e.target&&entitiesById.get(e.target)?.utype==='sheep_carcass';
      let picking = e.utype==='villager' && !moving &&
        (e.task==='forage'||e.task==='farm'||carcassTarget);
      let pick = Math.sin(tick*0.18+e.id);
      // Fighting (AoE2 villagers have an attack animation): a fast forward
      // jab — sharp punch out, slower recovery — whenever a villager is
      // engaging a combat target (incl. slaughtering a live sheep).
      let fighting = e.utype==='villager' && !moving && !e.task &&
        e.target && !picking && !carcassTarget;
      let jabPh = ((tick*0.06 + e.id*0.41) % 1 + 1) % 1;
      let jab = jabPh < 0.25 ? jabPh/0.25 : 1-(jabPh-0.25)/0.75; // 0..1 spike
      X.beginPath();
      X.moveTo(-3.5+humanXOffset,-8+humanYOffset); X.lineTo(-5+humanXOffset-armSwing,-3.5+humanYOffset);
      // Militia mid-slash: the sword arm follows the pumping sword hand
      // (same swing phase as drawBigSword) instead of hanging loose.
      let slashing = e.utype==='militia' && e.path.length===0 && (e.target||e.__animAttack) && !e.corpseRot;
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
      } else if (e.target) {
        // Harvesting/attacking a target (sheep, carcass, enemy): only swing when
        // actually in range to act on it — not while halted just short of it.
        atSite = inActionRange(e);
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
        let swinging=inActionRange(e)&&e.path.length===0; // __animAttack: style-gallery preview, silent like the ram's
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
      let swinging=inActionRange(e)&&e.path.length===0; // __animAttack: style-gallery preview, silent like the ram's
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
      let swinging=inActionRange(e)&&e.path.length===0; // __animAttack: style-gallery preview, silent like the ram's
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
      let swinging=inActionRange(e)&&e.path.length===0; // __animAttack: style-gallery preview, silent like the ram's
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
    let hpTop = (isMountedUnit(e.utype)||e.utype==='tradecart') ? sy-40*UNIT_SCALE : sy-30*UNIT_SCALE;
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

