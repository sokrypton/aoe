// The swing's angle at phase ph (0..1, the hit at SWORD_HIT) — both views' sword swing (pov3d follows the same arc).
const SWORD_HIT = 0.52;
function swordSwingCurve(ph){
  if(ph<0.35){let t=ph/0.35;return 0.5+0.65*t*t;}                        // windup -> 1.15
  if(ph<0.52){let t=(ph-0.35)/0.17;return 1.15-2.5*(1-Math.pow(1-t,3));} // strike -> -1.35
  if(ph<0.68){let t=(ph-0.52)/0.16;return -1.35+0.25*t;}                 // settle -> -1.1
  let t=(ph-0.68)/0.32;return -1.1+1.6*(t*t*(3-2*t));                    // recover -> 0.5
}

// The swing's arc at angle ssa (art px, +x the attack direction, y down): the grip's offset from its rest anchor
// (ox, oy) orbiting the shoulder — base: the orbit radius (mounted 3.4, on foot 4.2) — and the blade's canvas rotation
// rot (0 up, π/2 forward). Wide and DRAMATIC (user call): the grip rises over the head at the windup and drives down
// through the strike. The radius is BOOSTED past the neutral on the windup side so the HAND genuinely rises OVER the
// head (a short cocked radius left the overhead drama all wrist, user caught it); the boost is zero AT the neutral
// (s = sin 0.5), so the orbit lands exactly ON the rest anchor and engage can't pop. The blade: OVER THE HEAD at the
// windup (tipped back ~−69°), down through vertical, HORIZONTAL at the strike — never past it into the ground.
function swordSwingArc(ssa, base){
  const s = Math.sin(ssa), phi = -0.63 - 1.3*ssa;
  const r = base - 1.2*s + 18*Math.max(0, s - 0.479), r0 = base - SWING_NEUTRAL.rs;
  return { ox: -r0*SWING_NEUTRAL.cos + r*Math.cos(phi), oy: -r0*SWING_NEUTRAL.sin + r*Math.sin(phi), rot: 1.366 - 1.275*ssa - 0.831*ssa*ssa };
}
// Should this unit be showing its attack/harvest ANIMATION right now? It must
// be the SAME predicate the sim fires on — inWeaponRange (js/logic.js) — never a
// re-spelling: a looser gate swings at thin air, a tighter one shoots in silence
// (this file's own copy omitted the ranged +0.5 slack, so an archer hitting a
// mill from range+0.4 played no draw at all). Render-only: reads sim state,
// never writes it.
function inActionRange(e){
  if(e.__animAttack) return true;            // style-gallery preview swings freely
  if(!e.target) return false;
  let t = entitiesById.get(e.target);
  if(!t || t.hp<=0) return false;
  return inWeaponRange(e, t);                // THE shared gate (js/logic.js)
}




// Uniform size multiplier for every drawn character (units and corpses).
const UNIT_SCALE = 1.25;

// Swing-orbit neutral pose (angle 0.5): the orbit centre anchored so the swing's neutral frame lands exactly on the
// rest grip (engage can't pop); the blade-angle constant (swordSwingArc) stands the NEUTRAL blade dead vertical and
// tips the windup PAST vertical before the strike sweeps forward.
const SWING_NEUTRAL = (() => {
  let p0 = -0.8 - 0.96*0.5;
  return { rs: 1.2*Math.sin(0.5), cos: Math.cos(p0), sin: Math.sin(p0) };
})();

// ---- POSE RIG ----
// Body-local 3D anchors (lat = the unit's RIGHT, fwd = the facing
// direction, up) projected per dir through the iso camera: screen
// position, DEPTH (draw order) and arm choice DERIVE from one 3D pose
// instead of per-dir tables; the mounts' profileHeld carries the one
// deliberate exception (profile sort pin).
// C1 = 1/√2 makes profile forward = 1 screen px per body px (how all
// existing art offsets were authored); C2 = C1·(HALF_TH/HALF_TW).
// Depth = world (x+y) toward the camera; the body center is depth 0.
const RIG_DIRV = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]]; // SE,S,SW,W,NW,N,NE,E
const RIG_C1 = Math.SQRT1_2, RIG_C2 = RIG_C1 * 0.5;
// Per-dir FORWARD screen basis {sx,sy,d}; the RIGHT basis is row
// (d+2)&7 — the right of facing d is the facing two dirs clockwise.
const RIG = RIG_DIRV.map(([wx, wy]) => {
  let n = Math.hypot(wx, wy), x = wx / n, y = wy / n;
  return { sx: (x - y) * RIG_C1, sy: (x + y) * RIG_C2, d: (x + y) * RIG_C1 };
});
// ---- skeleton decay art (drawBones2D and the trade cart's ox): pov3d's bone and socket ----
const BONE = '#e8e0cc', BONE_HOLE = '#2a241c';

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
  let scr=mapToScreen(c.x,c.y);
  let sx=Math.round(scr.sx), sy=Math.round(scr.sy+HALF_TH);
  if(isOffscreen(sx,sy,50))return;
  
  let { ox, oy } = getUnitGroupOffset(c.id);
  sx += ox; sy += oy;
  let age = performance.now() - c.deathTime;

  // AoE2-style death sequence, staged instead of popping in flat:
  // (1) the unit's own rig plays its death (a fall, a thrown rider, a rolled beast) with a dust puff as it lands;
  // (2) blood seeps out from under it and spreads over ~2s, drying to a brown stain over time;
  // (3) at CORPSE_SKEL it decays to bones (AoE2 skeleton stage), and only fades away in the last seconds of CORPSE_LIFE.
  const TOPPLE = 600;                                                   // (when the body is down: the puff, the blood)
  let alpha = age < CORPSE_LIFE - 3000 ? 1 : Math.max(0, 1 - (age - (CORPSE_LIFE - 3000)) / 3000);
  let big = isMountedUnit(c.utype) || isWildPredator(c); // horse/bear-sized corpse

  // Wooden vehicles get their own break-apart wreck sequences — they don't
  // topple like bodies (the cart's ox falls separately; the ram caves in).
  if (c.utype === 'tradecart') { drawTradeCartCorpse(c, sx, sy, age, alpha); return; }
  if (c.utype === 'ram') { drawRamCorpse(c, sx, sy, age, alpha); return; }

  // Impact dust puff, once, the moment the body hits the ground (same
  // render-side particle spawning the sheep's grass nibbling uses).
  // Tracked in corpseImpactFxDone (js/core.js), not a `c.impactFx` field —
  // corpses get wholesale-replaced by every sync, which would wipe that
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
    const rider = isMountedUnit(c.utype), spread = (1 - (1 - bp) * (1 - bp)) * (big && !rider ? 1.4 : 1); // ease-out growth
    // under the body: the villager rig falls backward; a thrown rider lies where he landed (drawPerson2D), not under his horse
    const at = rider ? projKit((c.dir || 0) * Math.PI / 4).P(-0.8 + 0.25 * HORSE_TILE, 0, -0.72 * HORSE_TILE - 13).map(v => v * UNIT_SCALE)
      : c.utype === 'bear' ? projKit((c.dir || 0) * Math.PI / 4).P(0, 0, -0.38 * HORSE_TILE).map(v => v * UNIT_SCALE)   // (the bear rolled a body-height onto its side)
      : [c.utype === 'villager' || FOOT_SOLDIERS.has(c.utype) ? -9 * UNIT_SCALE * c.facing : 0, 0];
    let dry = Math.max(0, Math.min(1, (age - 8000) / 8000));
    let poolA = 0.7 * Math.min(1, bp * 3) * (1 - dry * 0.55);
    X.fillStyle = 'rgba(' + Math.round(120 - 40*dry) + ', ' + Math.round(25*dry) + ', ' + Math.round(10*dry) + ', ' + poolA.toFixed(3) + ')';
    X.beginPath();
    X.ellipse(sx + at[0], sy + 3 + at[1], 9*UNIT_SCALE*spread, 4.5*UNIT_SCALE*spread, 0, 0, Math.PI * 2);
    X.fill();
  }

  // 2. Skeleton decay stage (AoE2): after CORPSE_SKEL the body is bones, where it came to rest (drawBones2D)
  if (age >= CORPSE_SKEL) { drawBones2D(c, sx, sy, age); X.restore(); return; }

  // 3. Fresh corpse: the unit's own rig, playing its death at the corpse's age (e.__deathAge) — every living detail at
  //    its living size. The pseudo-entity is cached on the corpse and frozen (path empty, no target).
  X.restore(); // blood pool used screen coords; drawUnit sets its own transform
  if(!c.pose){
    c.pose = {type:'unit', utype:c.utype, team:c.team, id:c.id, x:c.x, y:c.y,
      female:c.female, dir:7, facing:c.facing, facingNorth:false,
      path:[], target:null, buildTarget:null, task:null, order:null,
      hp:1, maxHp:1, carrying:0, carryType:null,
      lastX:c.x, lastY:c.y};
  }
  c.pose.__deathAge = age;
  if (c.dir != null) c.pose.dir = c.dir;   // (the rigs fall along the facing they died in)
  X.save();
  X.globalAlpha = alpha;
  drawUnit(c.pose);

  X.restore();
  return;
}

// The canvas is already mirrored via X.scale(e.facing,…) when a unit faces
// left, so left-pointing directions map onto their right-pointing twins and
// only right-facing poses ever need authoring. Was copy-pasted at every
// posed-sprite branch (bear, horse legs, scout).
// 8-direction index (0: SE, 1: S, 2: SW, 3: W, 4: NW, 5: N, 6: NE, 7: E) to
// the sprite's mirror (facing) and front/back (facingNorth) quadrant.
function setFacingFromDir(e, dir){
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

// The sprite direction (0..7 = map angle k·45°) whose ON-SCREEN heading is nearest a map move (dx,dy): iso squashes
// the 8 map directions into uneven screen sectors, so an any-angle walk snapped in map angle could face 37° off.
const DIR_SCREEN_ANG = [0, 1, 2, 3, 4, 5, 6, 7].map(d => { const c = Math.cos(d * Math.PI / 4), s = Math.sin(d * Math.PI / 4); return Math.atan2((c + s) * HALF_TH, (c - s) * HALF_TW); });
function spriteDir(dx, dy){
  const a = Math.atan2((dx + dy) * HALF_TH, (dx - dy) * HALF_TW); let best = 0, bd = Infinity;
  for (let d = 0; d < 8; d++) { const g = Math.abs(Math.atan2(Math.sin(a - DIR_SCREEN_ANG[d]), Math.cos(a - DIR_SCREEN_ANG[d]))); if (g < bd) { bd = g; best = d; } }
  return best;
}
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
let grazeCycles = new Map(); // per-sheep grazing-puff cycle (same pattern)

// ---- BATTERING RAM: one physical model, projected per view ----
// Every facing AND the ground shadow derive from these numbers, so
// proportions cannot drift between views. World units are local px at
// scale 1 (RAM_SCALE applied at draw time): X = movement axis (a),
// Y = width axis (b), Z = up (c).
// 2D walk cycles (legs, bobs, wheels) run on this clock, not animTick: a walk's ground speed is the same every way,
// but on screen one heading covers 0.63×–1.26× the px of another, so a fixed rate slid the feet. Viewer-only.
const _paceClk = new WeakMap();
function paceClock(e){
  let c = _paceClk.get(e); if (!c) _paceClk.set(e, c = { t: animTick, at: animTick });
  const d = animTick - c.at; c.at = animTick;
  if (d > 0) { const n = e.path && e.path[0]; let k = 1;
    if (n) { const dx = n.x - e.x, dy = n.y - e.y, w = Math.hypot(dx, dy); if (w > 1e-6) k = Math.hypot((dx - dy) * HALF_TW, (dx + dy) * HALF_TH) / (w * TILE_PX); }
    c.t += d * k; }
  return c.t;
}
// A rolling wheel's turn (rad) for a vehicle whose wheel radius is rPx art px
// (before UNIT_SCALE): rolled, not spun — the ground it covers (speed ×
// UNIT_PX_PER_TICK screen px a tick, animTick running at the authored 30/s)
// over its radius. Viewer-only: never unitMoveSpeed, which can clear the hashed
// groupSpeed (a render-side write would desync); the ram's rider boost is read here.
function wheelSpin(e, rPx){
  const sp = e.speed * (e.utype === 'ram' && e.garrison ? 1 + 0.08 * e.garrison.length : 1);
  return paceClock(e) * sp * UNIT_PX_PER_TICK * (TPS / 30) / (rPx * UNIT_SCALE) + e.id;
}
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
    let phRaw = animTick*0.022 + e.id*0.4;
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
  else if (!rolling) dLog = Math.sin(animTick*0.05 + e.id) * 0.4;

  // Rolling creak: a slow wooden groan while the ram is moving — sparse
  // (every ~3 game-s, staggered per unit), skipped at 4x speed on odd
  // cycles like the chop sound. Fired by the period COUNTER advancing
  // (ramCreakCycles), not by a frame landing on an exact tick — frames
  // skip ticks, and an equality check dropped most creaks.
  if (rolling && !window._maskDraw && window.playSound) {
    let ck = Math.floor((animTick + e.id * 7) / 90);
    if (ramCreakCycles.get(e.id) !== ck) {
      if (ramCreakCycles.has(e.id) && (GAME_SPEED < 4 || ck % 2 === 0)) playSound('ram_creak', e.x, e.y);
      ramCreakCycles.set(e.id, ck);
    }
  }

  X.save();
  // Rolling: gentle sway, no head-bob (suppressed in drawUnit's translate)
  if (rolling) X.translate(0, Math.sin(paceClock(e)*0.2 + e.id) * 0.5);
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
  let wheelRot = wheelSpin(e, RAM_DIM.WR * RAM_DIM.SCALE);
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

// ---- The trade cart: pov3d's cartModel projected at its heading (projKit) ----
// An open team-walled bed on two spoked wheels, the grain sack while loaded, an ox yoked ahead on shafts — rigid parts
// on their own hinges, so the living cart and its wreck are the same pieces. pose: roll (wheel turn, rad), step (the
// ox's walk phase, or null standing), load (the sack shows), tail (swish), wreck { age, weathered }: the wheels tip off
// outward, the bed drops and its walls fall open, the sack slumps out; the ox, a beat later, goes down on its side
// (its bones at the skeleton stage). Weathered: grey. Art px (x forward, up, z across); the rig recentred on the anchor.
const CART_STRIDE = 0.2825;                                                            // tiles per ox stride: 1/6 of a wheel turn (pov3d's MIL_STRIDE.cart)
const CART_RECENTER = 13.5 * 1.32;                                                    // half the rig's span, bed's rear to the ox's muzzle
const cartRot = (p, ax, a) => { const c = Math.cos(a), s = Math.sin(a), [x, y, z] = p;   // three's rotation about one axis
  return ax === 'x' ? [x, y * c - z * s, y * s + z * c] : ax === 'y' ? [x * c + z * s, y, -x * s + z * c] : [x * c - y * s, x * s + y * c, z]; };
const addV = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const shadeHex = (hex, f) => { const n = parseInt(hex.slice(1), 16); return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v * f).toString(16).padStart(2, '0')).join(''); };
// a box [x0,x1]×[y0,y1]×[z0,z1] through m: one outlined hull, its visible faces filled on it (the top lit, the sides by
// which way they turn: top > left > right), sorted as one piece by its centre
function box2D(k, m, col, top, x0, y0, z0, x1, y1, z1, bias = 0){
  const C = [0, 1].flatMap(i => [0, 1].flatMap(j => [0, 1].map(l => m(i ? x1 : x0, j ? y1 : y0, l ? z1 : z0)))), S = C.map(q => k.P(...q));
  const ctr = C.reduce((a, q) => addV(a, q), [0, 0, 0]).map(v => v / 8), d = k.depth(ctr[0], ctr[2]) + bias;
  const hull = loadHull(S); k.add(col, d, () => { X.moveTo(...hull[0]); for (const q of hull.slice(1)) X.lineTo(...q); X.closePath(); }, 'cart');
  // faces: [corner indices], its outward normal from the box's own axes (i: x, j: y, l: z — index = i*4 + j*2 + l)
  const F = [[[0, 1, 3, 2], -4], [[4, 5, 7, 6], 4], [[0, 1, 5, 4], -2], [[2, 3, 7, 6], 2], [[0, 2, 6, 4], -1], [[1, 3, 7, 5], 1]];
  F.forEach(([ix, nn], f) => { const a = Math.abs(nn), sgn = Math.sign(nn), b = a === 4 ? 0 : a === 2 ? 2 : 1;   // the axis index pair
    const e0 = C[a === 4 ? 4 : a === 2 ? 2 : 1], n = [0, 1, 2].map(i => (e0[i] - C[0][i]) * sgn);
    const v = k.faces(n); if (v <= 0.02) return; const isTop = a === 2 && sgn > 0, P2 = ix.map(i => S[i]);
    const sx = (P2[0][0] + P2[2][0]) / 2 - (S.reduce((t, q) => t + q[0], 0) / 8);   // (left of the centre: the lit side)
    k.add(isTop ? top : shadeHex(col, sx < 0 ? 0.9 : 0.78), d + 0.0001 * (f + 1), () => { X.moveTo(...P2[0]); for (const q of P2.slice(1)) X.lineTo(...q); X.closePath(); }, 'cart', false); });
}
function cartRig2D(h, pose, tc){
  const k = projKit(h), { tube, blob } = k, kc = 1.32, R = r => r * kc, Wr = pose.wreck, age = Wr ? Wr.age : 0, grey = !!(Wr && Wr.weathered);
  const cl = v => Math.max(0, Math.min(1, v)), fall = (a, d) => Wr ? (grey ? 1 : cl((age - a) / d) ** 2) : 0;
  const bump = (a, d, amp) => Wr && !grey && age > a && age < a + d ? amp * Math.sin((age - a) / d * Math.PI) : 0;
  const G = c => grey ? '#8a826f' : c, TC = grey ? '#8f877a' : tc, shift = [-CART_RECENTER, 0, 0];
  const WR = 7.4, y0 = R(WR - 1.2), y1 = R(WR - 1.2 + 7.6), w = 5, L = 9, t = 0.5, jog = pose.step != null ? R(0.25) * Math.abs(Math.sin(2 * Math.PI * pose.step * 2)) : 0;
  // the bed rides the axle; drops when the wheels go
  const bedY = jog - (y0 - R(0.6)) * fall(280, 300) + bump(580, 220, R(0.5)), bedRx = 0.06 * fall(280, 300);
  const mB = p => addV(addV(cartRot(p, 'x', bedRx), [0, bedY, 0]), shift), mb = (x, y, z) => mB([x, y, z]);
  box2D(k, mb, G('#3a2c1c'), G('#4a3826'), R(-L), y0 - R(0.6), R(-w), R(L), y0, R(w));                       // floor
  const tw = (Math.PI / 2) * fall(600, 450) - bump(1050, 200, 0.07);                                            // the walls fall open about their bottom edges
  for (const [a0, b0, a1, b1, ax_, sg] of [[-L, -w, L, -w + t, 'x', -1], [-L, w - t, L, w, 'x', 1], [-L, -w, -L + t, w, 'z', -1], [L - t, -w, L, w, 'z', 1]]) {
    const o = ax_ === 'x' ? [0, y0, R(sg > 0 ? w : -w)] : [R(sg > 0 ? L : -L), y0, 0], rot = ax_ === 'x' ? ['x', sg * tw] : ['z', -sg * tw];
    box2D(k, (x, y, z) => mB(addV(o, cartRot([x - o[0], y, z - o[2]], rot[0], rot[1]))), TC, G('#b48c58'), R(a0), 0, R(b0), R(a1), y1 - y0, R(b1));
  }
  if (pose.load) { // a big fat sack heaped high over the rim, its neck tied off on top; it slumps out as the walls fall
    const sf = cl((age - 650) / 500), iL = L - t - 0.35, iW = w - t - 0.3, up = 7.4, sp = [R(7) * sf, y1 - (y1 - y0 - R(4)) * sf, R(3.5) * sf];
    const ms = (x, y, z) => mB(addV(sp, cartRot([x, y, z], 'z', -0.5 * sf))), sack = G('#cdb98c');
    const belly = blob(sack, ms, 0, 0, 0, R(iL), R(up) * (1 - 0.2 * sf), R(iW), 'cart');                          // the belly
    // the gathered neck, its tie and its tuft, each just over the last (they sit on the belly's top: sorted by their own
    // depths, from some sides the neck went under the belly and the tie with it)
    const neck = blob(sack, ms, -R(0.5), R(up - 0.2), 0, R(2), R(2), R(1.8), 'cart'), nd = neck.pt.d = belly.pt.d + 0.01;
    // the cord round it: its far half under the neck, its near half over it (a whole ring over it read as painted on)
    { const cx = -R(0.4), cy = R(up - 1.2), r = R(1.7), dp = q => k.depth(q[0], q[2]), c0 = dp(ms(cx, cy, 0));
      const th = Math.atan2(dp(ms(cx, cy, r)) - c0, dp(ms(cx + r, cy, 0)) - c0);   // the angle round it that faces us
      for (const [a0, d] of [[th + Math.PI / 2, nd - 0.001], [th - Math.PI / 2, nd + 0.001]])
        tube(G('#8b5a2b'), Array.from({ length: 7 }, (_, i) => { const a = a0 + i / 6 * Math.PI; return ms(cx + r * Math.cos(a), cy, r * Math.sin(a)); }), R(0.45), 'cart').d = d; }
    blob(sack, ms, -R(0.7), R(up + 1.7), 0, R(1.4), R(1.3), R(1.5), 'cart').pt.d = nd + 0.002;                // the tuft above the tie
  }
  for (const s of [-1, 1]) { // spoked wheels, each hinged at its outer rim: rolling alive, tipping off in the wreck
    const kk = s > 0 ? 1 : 0, tw2 = (Math.PI / 2) * fall(600 + kk * 70, 320) - bump(920 + kk * 70, 180, 0.08), cz = s * R(w + 1.2);
    const mw = (x, y, z) => addV(addV([0, 0, cz + s * R(0.6)], cartRot(addV([0, R(WR), -s * R(0.6)], cartRot([x, y, z], 'z', -(pose.roll || 0))), 'x', s * tw2)), shift);
    const wc = G('#5a4630'), wd = k.depth(mw(0, 0, 0)[0], mw(0, 0, 0)[2]);
    tube(wc, Array.from({ length: 25 }, (_, i) => { const a = i / 24 * 2 * Math.PI; return mw(R(WR - 0.5) * Math.cos(a), R(WR - 0.5) * Math.sin(a), 0); }), R(0.75), 'cart').d = wd;
    for (let i = 0; i < 3; i++) { const a = i * Math.PI / 3, dx = Math.cos(a) * R(WR - 0.8), dy = Math.sin(a) * R(WR - 0.8); tube(G('#74593a'), [mw(-dx, -dy, 0), mw(dx, dy, 0)], R(0.45), 'cart').d = wd + 0.001; }
    blob(G('#74593a'), mw, 0, 0, 0, R(1.6), R(1.6), R(0.75), 'cart').pt.d = wd + 0.002;                          // the hub
  }
  // The ox: heavy barrel, shoulder hump, stocky legs stepping with the walk, the head low on a thick neck nodding, big
  // horns, the yoke (O: the ox's art px, y down, ×1.2)
  const K = 1.2, O = (x, y, z = 0) => [x * K, (5 - y) * K, z * K], q = v => v * K, coat = G('#8d6b47'), root = [R(L + 13), 0, 0];
  const of = cl((age - 350) / 700), orot = Wr ? (Math.PI / 2.1) * (grey ? 1 : of * of) * (age > 1050 && age < 1350 && !grey ? 1 + 0.07 * Math.sin((age - 1050) / 300 * Math.PI) : 1) : 0;
  const mO = p => addV(addV(addV(root, [0, q(5.4) * Math.sin(Math.min(orot, Math.PI / 2)) * 0.9, 0]), cartRot(p, 'x', -orot)), shift);
  const gait = pose.step != null ? horseGait('walk', pose.step) : { legs: [[0, 0], [0, 0], [0, 0], [0, 0]], bob: 0, nod: 0 };
  const B = gait.bob * 0.6, OB = (x, y, z = 0) => O(x, y - B, z), mo = (x, y, z) => mO([x, y, z]);
  if (grey) oxBones2D(k, (x, y, z) => addV(addV(root, [x, y, z - 13.8]), shift));                              // (rolled onto its side: a body-height over)
  else {
    const bar = blob(coat, mo, ...OB(0, -6.5), q(8), q(5.4), q(5), 'ox'), bd = bar.pt.d;                            // heavy barrel
    blob(coat, mo, ...OB(3.5, -9.8), q(3.8), q(2.6), q(3.6), 'ox');                                                // shoulder hump
    [[-5, -2.6], [-4.4, 2.6], [4.4, -2.6], [5, 2.6]].forEach(([x, z], i) => { const [dx, lift] = gait.legs[i], d = dx * 1.3, hy = 3.6 - lift * 0.7;
      const foot = mO(O(x + 0.3 + d, hy - 0.2, z)), fd = k.depth(foot[0], foot[2]);                                 // (behind the barrel: only what hangs below shows)
      tube(G('#705232'), [mO(OB(x, -5, z)), mO(O(x + 0.3 + d * 0.5, (-5 - B + hy) / 2, z)), foot], q(1.25), 'ox').d = bd - 1 + (fd - bd) * 0.01;
      blob(G('#241408'), mo, ...O(x + 0.3 + d, hy + 0.35, z), q(1.55), q(1), q(1.4), 'ox').pt.d = bd - 1 + (fd - bd) * 0.01 + 1e-4; });
    const pv = OB(6, -8), hr = -(gait.nod || 0) - 0.3 * (Wr ? of : 0), H = (x, y, z = 0) => mO(addV(pv, cartRot(addV(OB(x, y, z), pv.map(v => -v)), 'z', hr)));
    const hm = (x, y, z) => mO(addV(pv, cartRot([x - pv[0], y - pv[1], z - pv[2]], 'z', hr)));                   // (the head's frame, for blobs: O coords in)
    tube(coat, [H(6, -8), H(9, -8.8), H(10.5, -6.5)], q(2.6), 'ox');                                             // thick neck sloping down
    const hc = O(12, -5.8 + B * 0), head = blob(coat, hm, ...OB(12, -5.8), q(3.4), q(3), q(3), 'ox');            // head, low
    blob(G('#5a3f28'), hm, ...OB(14.6, -4.3), q(1.9), q(1.7), q(2.2), 'ox', 0.01);                                // broad muzzle
    for (const s of [-1, 1]) {
      const c = OB(12, -5.8), dd = [0.55 / q(3.4), 0.45 / q(3), s * 0.75 / q(3)], tl = 1 / Math.hypot(...dd), p = [c[0] + 0.55 * tl, c[1] + 0.45 * tl, c[2] + s * 0.75 * tl];
      const ep = hm(...p), ec = head.o; if (k.faces(ep.map((v, i) => v - ec[i])) > 0.25) blob('#141414', hm, ...p, q(0.5), q(0.5), q(0.5), 'ox', 0.02, false);   // eyes
      tube(G('#ece4cf'), [H(11.2, -8.4, s * 1.8), H(11, -9.6, s * 5.8), H(10.6, -12.8, s * 6.6)], q(0.75), 'ox');   // horns: out, then up
      blob(coat, hm, ...OB(10.2, -7.2, s * 3.6), q(1.6), q(0.6), q(1), 'ox');                                      // droopy ears
    }
    const sw = pose.tail || 0, rt = OB(-7.6, -8), T = (x, y) => mO(addV(rt, cartRot(cartRot(addV(OB(x, y), rt.map(v => -v)), 'z', 0.15 * Math.abs(sw)), 'x', 0.5 * sw)));   // the tail swishes from its root
    tube(G('#5a3f28'), [T(-7.6, -8), T(-9.2, -4), T(-8.6, -1)], q(0.8), 'ox'); const tp = T(-8.6, -0.6); blob(G('#3a2818'), (x, y, z) => [x, y, z], ...tp, q(1), q(1.3), q(1), 'ox');   // tail and its tuft
    // the yoke: a round rod lying on the neck's crest, forward of the hump, its bows down either side to the shafts
    const YX = 8.4, YY = -11.8;
    tube(G(WOOD.beam), [mO(O(YX, YY + B, -5.6)), mO(O(YX, YY + B, 5.6))], q(0.8), 'ox');
    for (const s of [-1, 1]) tube(G(WOOD.beam), [mO(O(YX, YY + B, s * 5)), mO(O(YX, -6.2 + B, s * 5))], q(0.5), 'ox');
  }
  // the shafts: from the bed's front corners to the foot of each bow, wherever the ox is (walking, falling)
  if (!grey) for (const s of [-1, 1]) tube(G('#6e5138'), [mb(R(L), y0 + R(2.5), s * R(5)), mO(O(8.4, -6.2 + B, s * 5))], R(0.6), 'cart');
  return k.parts;
}
const cart2DState = new Map(), cartCache = new Map();
function drawTradeCartBody(e){
  let a = cart2DState.get(e.id); if (!a) cart2DState.set(e.id, a = { px: e.x, py: e.y, stride: 0 });
  const rolling = isUnitMoving(e);
  if (!window._maskDraw) a.stride += Math.hypot(...walkedSince(a, e));
  // rolling creak — same cadence/counter as the ram
  if (rolling && !window._maskDraw && window.playSound) {
    let ck = Math.floor((animTick + e.id*7)/90);
    if (ramCreakCycles.get(e.id) !== ck) {
      if (ramCreakCycles.has(e.id) && (GAME_SPEED<4 || ck%2===0)) playSound('ram_creak', e.x, e.y);
      ramCreakCycles.set(e.id, ck);
    }
  }
  const t = a.stride / CART_STRIDE, ti = ((animTick * VIL_RATE.idle + (e.id || 0) * 0.37) % 1 + 1) % 1;
  const pose = rolling ? { load: e.carrying > 0, roll: 2 * Math.PI * t / 6, step: ((t % 1) + 1) % 1, tail: 0.35 * Math.sin(4 * Math.PI * t) }
    : { load: e.carrying > 0, roll: 2 * Math.PI * t / 6, tail: 0.7 * Math.sin(2 * Math.PI * ti) * Math.max(0, Math.sin(Math.PI * ti)) + 0.25 * Math.sin(6 * Math.PI * ti) };   // (a lazy swish, now and then a flick)
  // (cached by pose, snapped: the walk to PERSON_STEPS, the wheel to its spokes' repeat — a sixth of a turn — the tail)
  const Q = (v, n) => Math.round(v * n) / n, spoke = Math.PI / 3;
  if (pose.step != null) pose.step = Q(pose.step, PERSON_STEPS) % 1;
  pose.roll = Q((((pose.roll % spoke) + spoke) % spoke) / spoke, 8) * spoke; pose.tail = Q(pose.tail, 20);
  const dir = e.dir !== undefined ? e.dir : 7, key = [dir, pose.load ? 1 : 0, pose.step, pose.roll.toFixed(3), pose.tail, teamColor(e.team)].join('|');
  let parts = cartCache.get(key);
  if (!parts) { parts = cartRig2D(dir * Math.PI / 4, pose, teamColor(e.team)); if (cartCache.size > 2000) cartCache.clear(); cartCache.set(key, parts); }
  X.save(); if (e.facing === -1) X.scale(-1, 1); paintParts(parts); X.restore();   // (it draws its own heading: undo drawUnit's mirror)
}
// The cart's wreck: the rig's own (cartRig2D's wreck), with chips and dust as it breaks and the ox's blood under it
function drawTradeCartCorpse(c, sx, sy, age, alpha){
  if (!corpseImpactFxDone.has(c.id)) {
    corpseImpactFxDone.add(c.id);
    spawnParticles(c.x, c.y, '#c9a15e', 8, 0.04, 1.8);              // wood chips
    spawnParticles(c.x, c.y, 'rgba(140,120,90,0.7)', 5, 0.02, 1.8); // dust
  }
  if (age >= 580 && !corpseImpactFxDone.has(c.id+':thud')) {
    corpseImpactFxDone.add(c.id+':thud');
    spawnParticles(c.x, c.y, 'rgba(140,120,90,0.7)', 6, 0.03, 2.0); // bed hits the ground
  }
  const h = (c.dir !== undefined ? c.dir : 7) * Math.PI / 4, k = projKit(h);
  X.save(); X.globalAlpha = alpha;
  // the ox's blood, under its rolled body (a body-height to its side), spreading after it lands and drying brown
  const obp = Math.max(0, Math.min(1, (age - 840) / 2000));
  if (obp > 0) { const spread = 1 - (1 - obp) * (1 - obp), dry = Math.max(0, Math.min(1, (age - 8000) / 8000)), poolA = 0.6 * Math.min(1, obp * 3) * (1 - dry * 0.55);
    const at = k.P(1.32 * 22 - CART_RECENTER, 0, -13.8).map(v => v * UNIT_SCALE);
    X.fillStyle = 'rgba(' + Math.round(120 - 40 * dry) + ', ' + Math.round(25 * dry) + ', ' + Math.round(10 * dry) + ', ' + poolA.toFixed(3) + ')';
    X.beginPath(); X.ellipse(sx + at[0], sy + 3 + at[1], 8 * UNIT_SCALE * spread, 4 * UNIT_SCALE * spread, 0, 0, Math.PI * 2); X.fill(); }
  X.translate(sx, sy); X.scale(UNIT_SCALE, UNIT_SCALE);
  paintParts(cartRig2D(h, { load: (c.carrying || 0) > 0, wreck: { age, weathered: age >= CORPSE_SKEL } }, teamColor(c.team)));
  X.restore();
}

// Ground-shadow footprint per unit type, in TILE units: half-length along
// the body's facing and half-width across it. Radially-symmetric units set
// len==wid (facing then doesn't matter); elongated ones (mounts, bear) are
// longer along the body so their shadow stretches in profile and shortens
// head-on. Tuned so the humanoid footprint matches a 6×3-ish ellipse.
const UNIT_SHADOW = {
  villager:{len:0.17,wid:0.17}, militia:{len:0.18,wid:0.18},
  spearman:{len:0.18,wid:0.18}, archer:{len:0.18,wid:0.18},
  scout:{len:0.42,wid:0.19},    knight:{len:0.44,wid:0.21},
  bear:{len:0.34,wid:0.26},     sheep:{len:0.17,wid:0.17},     dragon:{len:1.2,wid:0.8},
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
  let ta = e.faceAng !== undefined ? e.faceAng : (e.dir || 0) * Math.PI / 4; // facing angle in TILE space (the dragon: its own smooth heading)
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
    const faceOnView = e.dir === 1 || e.dir === 5; // S/N — forward is the view axis
    let ulen = faceOnView ? 0.55 : 1;
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

// Walking THIS frame: a queued path, or the press-to-contact ring re-armed
// on this exact tick (js/logic.js).
function isUnitMoving(e){ return e.path.length>0 || e.pressWalk===tick; }
// For the drawing: a press-slide onto a target already in reach (the sim's cosmetic packing round a carcass) isn't a
// walk — the drawn work spot walks it in (villagerWorkSpot); counted, the two disagreed and the villager lurched in and
// out, its heading swinging, as the sheep fell. Viewer-only.
function isDrawnMoving(e){ return e.path.length>0 || (e.pressWalk===tick && !(e.target && !e.task && inActionRange(e))); }

// The ground a drawn animal covered since its last frame (a: its render state, px/py the spot last seen) → [mx, my];
// a jump of a tile or more — out of a garrison, a snap, a gallery treadmill stepping back — isn't walking: [0, 0].
function walkedSince(a, e){
  const mx = e.x - a.px, my = e.y - a.py; a.px = e.x; a.py = e.y;
  return mx * mx + my * my >= 1 ? [0, 0] : [mx, my];
}
// ---- The horse: one model and one gait for both views ----
// pov3d's horseKit shape (art px ×1.35: x forward, y down to the ground at 5, z across), posed by horseGait and
// projected at the unit's facing: heights 1:1 as the 2D art draws them (the rider sprite sits on it), the ground plane
// as the iso map. Each leg plants and keeps pace with the ground (a stride per 1.3 tiles walked, as the 3D view).
// Gaits in horseKit's leg order [hind −z, hind +z, fore −z, fore +z]: each leg plants (its hoof sliding back under the
// moving body) then lifts and swings forward. walk: four-beat, three feet down; gallop: the hinds then the fores in
// quick pairs, a long reach, the body rocking and the head pumping.
const HORSE_GAITS = {
  walk:   { ph: [0, 0.5, 0.25, 0.75], stance: 0.72, S: 2.4, lift: 2.3, bob: 0.35, nod: 0.05 },
  gallop: { ph: [0, 0.1, 0.48, 0.58], stance: 0.42, S: 4.6, lift: 4.2, bob: 1.3, nod: 0.16 },
};
function horseGait(kind, t){
  const G = HORSE_GAITS[kind], legs = G.ph.map(ph => { const u = ((t + ph) % 1 + 1) % 1;
    return u < G.stance ? [G.S * (1 - 2 * u / G.stance), 0] : [G.S * (-1 + 2 * (u - G.stance) / (1 - G.stance)), G.lift * Math.sin(Math.PI * (u - G.stance) / (1 - G.stance))]; });
  const c = Math.cos(2 * Math.PI * t * (kind === 'walk' ? 2 : 1));
  return { legs, bob: G.bob * (0.5 + 0.5 * c), nod: G.nod * c, tail: kind === 'gallop' ? 0.8 + 0.3 * c : 0.2 * c };
}
const HORSE_STRIDE = { walk: 0.62, gallop: 1.3 };                                     // ground per cycle, tiles (pov3d's MIL_STRIDE)
// [x, z, knee bend]: hocks back, knees forward. (2D stands them and the barrel a little wider than horseKit: head-on,
// the 3D's width read as a stick under the rider)
const HORSE_LEGS = [[-5.4, -3.1, -1.2], [-4.6, 3.1, -1.2], [4.6, -3.1, 1], [5.4, 3.1, 1]];
// coats as pov3d's HORSE_COAT (scout bay, knight white charger); legFar: the far pair, in the body's shade
const HORSE_PAL = { scout: { coat: '#8b5a2b', mane: '#3f2810', leg: '#6e4520', legFar: '#583718', muzzle: '#6e4520', hoof: '#241408', hoofFar: '#1a0e05', eye: '#141414' },
  knight: { coat: '#e9e6de', mane: '#9a948a', leg: '#b3ada1', legFar: '#948e83', muzzle: '#b8b2a6', hoof: '#241408', hoofFar: '#1a0e05', eye: '#141414' } };
const horse2DState = new Map();                                                    // (by id, as bear2D: a rollback's restored copy keeps its stride)
// The rider's seat in art px (x forward, up): where the 2D rider sprite's origin sits on the horse.
const HORSE_SEAT = [-2, 16];
// A grazing horse's ~11s cycle (both views' barracks yard): head up with a slow bob, then down to graze a few seconds,
// nibbling. neck/head: rotations about the withers and the poll (− lowers the nose); tail: its swing.
function horseGrazePose(sec, seed){
  const ph = ((sec + seed * 11) / 11) % 1, t = sec + seed * 11, ss = (a, b, x) => { const u = Math.min(1, Math.max(0, (x - a) / (b - a))); return u * u * (3 - 2 * u); };
  // (mostly eating: down ~70% of the cycle, a short look up now and then; a slow tug at the hay, not a fast nod)
  const graze = ss(0.12, 0.2, ph) - ss(0.86, 0.94, ph);
  return { neck: -1.05 * graze + 0.04 * graze * Math.sin(t * 3.6) + 0.04 * (1 - graze) * Math.sin(t * 0.9), head: -0.8 * graze, tail: 0.35 * Math.sin(t * 2.3 + seed * 6) };
}
// The 2D animals' light from above (the bear's, the villager's): a band of a group's MERGED outline (so overlapping
// parts leave no seams) — the shape less itself moved up by lift (+: the underside in shade; −: a lit band along the
// top) — masked on a scratch canvas and laid on at alpha. paths: the parts' path fns (drawing on X); bb: their local box.
// Scratch canvases for the shade-band masks, handed out round-robin: rewriting ONE canvas right after drawing it onto
// the screen made the GPU finish that draw first — a stall per band, most of an awake dragon's frame
const _bandRing = []; let _bandNext = 0;
function bandCanvas(w, h){
  let c = _bandRing[_bandNext]; if (!c) c = _bandRing[_bandNext] = document.createElement('canvas');
  _bandNext = (_bandNext + 1) % 24;
  if (c.width < w || c.height < h) { c.width = Math.max(c.width, w); c.height = Math.max(c.height, h); }
  return c;
}
function silhouetteBand(paths, bb, lift, col, alpha){
  if (window._maskDraw) return;
  const m = X.getTransform(); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [u, v] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]]) {
    const dx = m.a * u + m.c * v + m.e, dy = m.b * u + m.d * v + m.f; x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy); }
  x0 = Math.floor(x0) - 2; y0 = Math.floor(y0) - 2; const w = Math.ceil(x1) + 2 - x0, h = Math.ceil(y1) + 2 - y0;
  if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return;
  const bandC = bandCanvas(w, h), O = bandC.getContext('2d'), X0 = X; O.setTransform(1, 0, 0, 1, 0, 0); O.clearRect(0, 0, w, h);
  O.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0); X = O;                           // (the path helpers draw on X)
  try { O.fillStyle = col; O.beginPath(); for (const p of paths) p(); O.fill();
    O.globalCompositeOperation = 'destination-out'; O.translate(0, -lift); O.beginPath(); for (const p of paths) p(); O.fill();
    O.globalCompositeOperation = 'source-over'; } finally { X = X0; }
  X.save(); X.setTransform(1, 0, 0, 1, 0, 0); X.globalAlpha *= alpha; X.drawImage(bandC, 0, 0, w, h, x0, y0, w, h); X.restore();
}
// Paint a kit's parts (projKit): outlines far to near, then fills — see projKit's paint notes
// A parts list's paths, built once as Path2Ds (a cached pose's — personCache, horseCache, cartCache — is painted every
// frame; rebuilding its tubes' arcs was most of the cost): the outline, the silhouette, and each outlined part's fill
// (each its own: two parts' windings can oppose — the blade's tube and its flat face — and a shared nonzero fill
// cancels where they overlap); a part that paints itself, or lines its edge, stays live. null if a part's path can't
// be captured (it draws, not just traces).
function partsPaths(list){
  const cap = fn => { const P = new Path2D(), sv = X; X = P; try { fn(); return P; } catch (err) { return null; } finally { X = sv; } };
  const out = new Path2D(), all = [], runs = [];
  for (const pt of list) {
    if (!pt.outline) { runs.push({ pt }); continue; }
    const q = cap(pt.path); if (!q) return null; all.push(q);
    if (!pt.merge) { const o = pt.strokePath ? cap(pt.strokePath) : q; if (!o) return null; out.addPath(o); }
    runs.push(pt.line ? { pt } : { col: pt.col, path: q });
  }
  return { out, all, runs };
}
function paintParts(list, lw = 1){ if (!list.length) return; const TAU = Math.PI * 2;
  // (sorted, and its paths built on its second paint: a one-off list — a body falling — never pays for them)
  if (list.__pp === undefined) { list.sort((p, q) => p.d - q.d); if ((list.__n = (list.__n || 0) + 1) >= 2) list.__pp = partsPaths(list); }
  const pp = list.__pp;
  X.save(); X.lineJoin = 'round'; X.strokeStyle = '#000'; X.lineWidth = 2.2 * lw / UNIT_SCALE;
  // a silhouette pass (outlines, occluder masks, picking — not the 3D's billboards, which keep the colours) reads only
  // coverage: the outline, then every part (each its own fill: a shared one cancels where windings oppose)
  if (window._maskDraw && !window._povDraw) { X.fillStyle = '#000';
    if (pp) { X.stroke(pp.out); for (const q of pp.all) X.fill(q); X.restore(); return; }
    X.beginPath(); for (const pt of list) if (pt.outline) (pt.strokePath || pt.path)(); X.stroke();
    for (const pt of list) if (pt.outline) { X.beginPath(); pt.path(); X.fill(); } X.restore(); return; }
  // the plain outlines in one stroke; a merged part clips its own
  if (pp) X.stroke(pp.out); else { X.beginPath(); for (const pt of list) if (pt.outline && !pt.merge) (pt.strokePath || pt.path)(); X.stroke(); }
  for (const pt of list) if (pt.outline && pt.merge) { X.save(); const m = pt.merge; X.beginPath(); X.rect(m.c[0] - 200, m.c[1] - 200, 400, 400); X.ellipse(m.c[0], m.c[1], m.r1, m.r2, m.rot, 0, TAU); X.clip('evenodd');
    X.beginPath(); (pt.strokePath || pt.path)(); X.stroke(); X.restore(); }
  X.lineWidth = 1.2 * lw / UNIT_SCALE;
  if (pp) { for (const r of pp.runs) { if (r.pt) { X.fillStyle = r.pt.col; X.beginPath(); r.pt.path(); X.fill(); if (r.pt.line) X.stroke(); } else { X.fillStyle = r.col; X.fill(r.path); } } }
  else for (const pt of list) { X.fillStyle = pt.col; X.beginPath(); pt.path(); X.fill(); if (pt.line) X.stroke(); }
  X.restore(); }
// A posed model projected into the 2D view at map heading h (rad) — the horse's and the sheep's shared kit. Parts are
// ellipsoids and tapered tubes in art px (forward, up, across; heights 1:1 as the 2D art draws them, the ground plane
// as the iso map), depth-sorted and painted as one silhouette: outlines far to near, then fills.
// xf (optional): a transform of the model's points before they're projected (a body rolling over as it falls)
// the 2D sheen of pov3d's SHINY colours: soft on steel, a brighter glint on gold
const SHINE_2D = { '#a8adb3': 'rgba(255,255,255,0.28)', '#c6cdd8': 'rgba(255,255,255,0.32)', '#b9bec6': 'rgba(255,255,255,0.3)', '#b8bfc6': 'rgba(255,255,255,0.3)',
  '#e8b90f': 'rgba(255,248,210,0.55)', '#d1a017': 'rgba(255,248,210,0.5)', '#c99815': 'rgba(255,248,210,0.5)', '#daa520': 'rgba(255,248,210,0.5)' };
function projKit(h, xf = null){
  const fx = Math.cos(h), fy = Math.sin(h), sx = -fy, sy = fx, R2 = Math.SQRT2, TAU = Math.PI * 2;
  // art px → screen px; depth: larger is nearer the viewer
  const P0 = (x, u, z) => [(x * (fx - fy) + z * (sx - sy)) / R2, (x * (fx + fy) + z * (sx + sy)) / (2 * R2) - u];
  const P = xf ? (x, u, z) => P0(...xf([x, u, z])) : P0;
  const depth = (x, z) => x * (fx + fy) + z * (sx + sy), dq = xf ? q => { const t = xf(q); return depth(t[0], t[2]); } : q => depth(q[0], q[2]);
  // how squarely a surface with normal n faces the viewer: the cosine to the screen axes' normal (> 0: seen at all)
  const ax_ = (fx - fy) / R2, az_ = (sx - sy) / R2, bx_ = (fx + fy) / (2 * R2), bz_ = (sx + sy) / (2 * R2), V = [-az_, ax_ * bz_ - az_ * bx_, ax_], VL = Math.hypot(...V);
  const faces = n => (V[0] * n[0] + V[1] * n[1] + V[2] * n[2]) / (VL * (Math.hypot(...n) || 1));
  const parts = [], add = (col, d, path, grp, outline = true) => { const pt = { col, d, path, grp, outline }; parts.push(pt); return pt; };
  // an ellipsoid: m(x,y,z) maps its local frame to art (fwd, up, across); radii in that frame
  const blob = (col, m, x, y, z, rx, ry, rz, grp, bias = 0, outline = true) => {
    const o = m(x, y, z), c = P(...o), ax = [m(x + rx, y, z), m(x, y + ry, z), m(x, y, z + rz)].map(q => { const v = P(...q); return [v[0] - c[0], v[1] - c[1]]; });
    let a = 0, b = 0, d = 0; for (const [u, v] of ax) { a += u * u; b += u * v; d += v * v; }
    const tr = (a + d) / 2, dd = Math.sqrt(((a - d) / 2) ** 2 + b * b), rot = 0.5 * Math.atan2(2 * b, a - d);
    const r1 = Math.sqrt(tr + dd), r2 = Math.sqrt(Math.max(0, tr - dd)), e = { c, r1, r2, rot, o };
    e.pt = add(col, dq(o) + bias, () => { X.moveTo(c[0] + r1 * Math.cos(rot), c[1] + r1 * Math.sin(rot)); X.ellipse(c[0], c[1], Math.max(0.4, r1), Math.max(0.4, r2), rot, 0, TAU); }, grp, outline);
    // steel and gold catch the light (pov3d's SHINY): a soft dab toward the upper-left, riding its part's depth
    const sh = SHINE_2D[col];
    if (sh && r2 > 0.6) { const pt = e.pt, hr = 0.34 * Math.min(r1, r2), hx = c[0] - 0.3 * r1, hy = c[1] - 0.38 * r2;
      parts.push({ col: sh, get d(){ return pt.d + 0.0005; }, grp, outline: false, path: () => { X.moveTo(hx + hr, hy); X.ellipse(hx, hy, hr * 1.15, hr, -0.5, 0, TAU); } }); }
    return e; };
  // a tube through 2..3 art points: radius r (art px, one per point to taper), round caps, straight segments
  const tube = (col, pts, r, grp, bias = 0) => { const sp = pts.map(q => P(...q)), rs = pts.map((_, i) => Array.isArray(r) ? r[i] : r);
    const dAvg = pts.reduce((t, q) => t + dq(q), 0) / pts.length;
    return add(col, dAvg + bias, () => { for (let i = 0; i < sp.length; i++) { X.moveTo(sp[i][0] + rs[i], sp[i][1]); X.arc(sp[i][0], sp[i][1], rs[i], 0, TAU); }
      for (let i = 0; i + 1 < sp.length; i++) { const [x0, y0] = sp[i], [x1, y1] = sp[i + 1], l = Math.hypot(x1 - x0, y1 - y0) || 1e-6, nx = -(y1 - y0) / l, ny = (x1 - x0) / l, r0 = rs[i], r1 = rs[i + 1];
        // (wound as the caps are, so the overlaps fill solid)
        const q = [[x0 + nx * r0, y0 + ny * r0], [x1 + nx * r1, y1 + ny * r1], [x1 - nx * r1, y1 - ny * r1], [x0 - nx * r0, y0 - ny * r0]]; let ar = 0; for (let j = 0; j < 4; j++) ar += q[j][0] * q[(j + 1) % 4][1] - q[(j + 1) % 4][0] * q[j][1];
        const qq = ar < 0 ? q.reverse() : q; X.moveTo(...qq[0]); for (let j = 1; j < 4; j++) X.lineTo(...qq[j]); X.closePath(); } }, grp); };
  // paint: pt.merge (an ellipse from blob) — no outline inside it, the part grows out of it; pt.line — its own thin
  // line over what's behind; pt.strokePath — its outline's shape when its fill is cut (a hole); lw: outline weight (×, for contexts not under UNIT_SCALE)
  const paint = paintParts;
  return { P, depth, faces, view: V.map(v => v / VL), parts, add, blob, tube, paint, ID: (x, y, z) => [x, y, z] };
}
// The horse, posed and projected at map heading h (rad). gait: horseGait's { legs, bob, nod, tail }; C: a HORSE_PAL
// palette; graze: { neck, head } (horseGrazePose); lw: outline weight (×, for contexts not under UNIT_SCALE). Returns
// { back, front, seat }: painters in a frame with the ground under the horse at (0,0) — back the whole horse when nothing
// is nearer than its saddle, else the neck and head go in front (over a rider) — and seat, the saddle point in that frame.
function horseRig2D(h, gait, C, tc, graze, lw = 1, xf = null){
  const coat = C.coat, mane = C.mane, legC = C.leg, muzzle = C.muzzle, k = 1.35, TAU = Math.PI * 2;
  const { P, depth, faces, parts, add, blob, tube, paint, ID } = projKit(h, xf);
  const B = gait.bob;
  // horseKit's frames, ×k: H rides the bob (body, neck, head), G is the ground (feet)
  const H = (x, y, z = 0) => [x * k, (5 - y + B) * k, z * k], G = (x, y, z = 0) => [x * k, (5 - y) * k, z * k];
  // the neck lowered about the withers (grazing)
  const W = H(4.5, -7.5), gn = graze ? graze.neck : 0, gc = Math.cos(gn), gs = Math.sin(gn);
  const NK = q => { const dx = q[0] - W[0], du = q[1] - W[1]; return [W[0] + dx * gc - du * gs, W[1] + dx * gs + du * gc, q[2]]; };
  // barrel, and the team saddle cloth over its back (clipped to the barrel: one silhouette)
  const bc = H(-0.4, -6.2), barrel = blob(coat, ID, ...bc, 8.2 * k, 4.4 * k, 5.4 * k, 'body');
  const bodyD = depth(bc[0], bc[2]);
  // (the team tell: draped down both flanks to a hem under the barrel's middle — the band of the barrel within
  // the cloth's length, above the hem)
  { const cc = H(-0.6, -6.2), cl = blob(tc, ID, ...cc, 3.5 * k, 6 * k, 6 * k, 'body', 0.001, false); parts.pop();
    const hemY = barrel.c[1] + barrel.r2 * 0.35;
    add(tc, bodyD + 0.001, () => { X.save(); X.beginPath(); X.ellipse(barrel.c[0], barrel.c[1], barrel.r1 - 0.4, barrel.r2 - 0.4, barrel.rot, 0, TAU); X.clip();
      X.beginPath(); X.ellipse(cl.c[0], hemY - 30, cl.r1 * 1.25, 31.2, 0, 0, TAU); X.clip();       // (the hem dips at the middle)
      X.beginPath(); X.ellipse(cl.c[0], cl.c[1], cl.r1, cl.r2, cl.rot, 0, TAU); X.fill(); X.restore(); X.beginPath(); }, 'body', false); }
  // legs: hip in the body → knee/hock → hoof (planted or lifted), a dark hoof; the far pair a shade darker
  HORSE_LEGS.forEach(([x, z, bend], i) => { const [dx, lift] = gait.legs[i], hy = 3.9 - lift;
    const hip = H(x, -5, z), knee = G(x + bend * (0.25 + lift * 0.45) + dx * 0.5, (-5 - B + hy) / 2, z), hoof = G(x + dx, hy, z);
    const far = depth(hoof[0], hoof[2]) < bodyD;
    const lg = tube(far ? C.legFar : legC, [hip, knee, hoof], [1.3 * k, 0.95 * k, 0.75 * k], 'legs', 0); lg.d = bodyD - 0.5 + (depth(hoof[0], hoof[2]) - bodyD) * 0.01;
    blob(far ? C.hoofFar : C.hoof, ID, ...G(x + dx + 0.3, hy + 0.4, z), 1.3 * k, 0.75 * k, 1.1 * k, 'legs').pt.d = lg.d + 1e-4; });
  // tail (from the rump), neck + mane, and the long head nose-down off the poll (nodding with the gait)
  // the tail as horseKit's: hanging, streaming at a gallop (gait.tail)
  const tl = gait.tail; tube(mane, [H(-8.2, -7.6), H(-10.4 - 2 * tl, -4.5 - 2 * tl), H(-9.6 - 4 * tl, -0.8 - 4.5 * tl)], 1.05 * k, 'tail');
  // (the neck and mane grow out of the body: no outline inside its silhouette, even drawn over a rider)
  tube(coat, [H(4.5, -7.5), H(8.5, -10.5), H(9.6, -14.2)].map(NK), [2.8 * k, 2.3 * k, 1.9 * k], 'head').merge = barrel;
  tube(mane, [H(3.6, -9.5), H(7.6, -13.6), H(9.4, -15.8)].map(NK), 0.95 * k, 'head', 0.01).merge = barrel;
  const poll = NK(H(10, -14)), a = -0.55 - gait.nod + gn + (graze ? graze.head : 0), ca = Math.cos(a), sa = Math.sin(a);
  const hd = (x, y, z) => [poll[0] + (x * ca - y * sa) * k, poll[1] + (x * sa + y * ca) * k, poll[2] + z * k];   // head frame (y up), rotated about z
  blob(coat, hd, 2.8, 0, 0, 4, 2.3, 2.2, 'head', 0.02);
  blob(muzzle, hd, 5.9, -0.2, 0, 1.8, 1.9, 1.9, 'head', 0.03);
  // ears: pricked leaves on the poll, the 2D art's size (the 3D's read as nubs here), each lined against the head
  for (const zz of [-1, 1]) blob(coat, (x, y, z) => hd(x - 0.35 * y, y, z), -0.2, 2.6, zz * 1.05, 0.8, 1.9, 0.55, 'head', 0.025).pt.line = true;
  // eyes: only the ones clearly facing us (one just round the silhouette's edge read as a stray dot)
  { const hc = hd(2.8, 0, 0); for (const zz of [-1, 1]) { const ex = 1.9, ey = 0.7, fxe = 0.2, fye = 0.4, fze = 0.9 * zz, t = 1 / Math.hypot(fxe / 1.6, fye / 1.6, fze / 2.2), m = hd(ex + fxe * t, ey + fye * t, fze * t);
      if (faces([m[0] - hc[0], m[1] - hc[1], m[2] - hc[2]]) > 0.3) blob(C.eye, ID, ...m, 0.55, 0.55, 0.55, 'head', 0.05, false); } }
  // the neck and head go over a rider when nearer than the saddle
  const seatP = H(HORSE_SEAT[0] / k, 5 - HORSE_SEAT[1] / k), seatD = depth(seatP[0], seatP[2]);
  const headD = depth(...(q => [q[0], q[2]])(hd(2.8, 0, 0))), frontHead = headD > seatD + 2;
  const back = parts.filter(p => !(frontHead && p.grp === 'head')), front = frontHead ? parts.filter(p => p.grp === 'head') : [];
  const body = parts.filter(p => p.grp !== 'head'), head = parts.filter(p => p.grp === 'head');
  return { back: () => paint(back, lw), front: front.length ? () => paint(front, lw) : null, body: () => paint(body, lw), head: () => paint(head, lw), frontHead, seat: P(...seatP) };
}
// A cavalry unit's mount: its gallop (a stride per 1.3 tiles walked), or standing with a slow nod and tail swish.
// Returns { back, front, seat } in drawUnit's (possibly mirrored) frame, the ground at y 5; a corpse keeps its pose.
const horseCache = new Map();
function horse2D(e, tc){
  let S = horse2DState.get(e.id); if (!S) horse2DState.set(e.id, S = { px: e.x, py: e.y, stride: 0 });
  if (!window._maskDraw) S.stride += Math.hypot(...walkedSince(S, e));
  // (the gallop's phase snaps to PERSON_STEPS, the idle sway to 16 steps: each pose built once, cached by its key)
  const q = (v, n) => Math.round(v * n) / n, moving = isUnitMoving(e);
  const ph = moving ? (Math.round(((S.stride / HORSE_STRIDE.gallop) % 1 + 1) % 1 * PERSON_STEPS) % PERSON_STEPS) / PERSON_STEPS : 0;
  const nod = moving ? 0 : q(Math.sin(animTick * 0.05 + e.id), 8) * 0.06, tail = moving ? 0 : q(Math.sin(animTick * 0.08 + e.id), 8) * 0.25;
  const key = [e.utype, e.dir || 0, tc, moving ? 'g' + ph : nod + ',' + tail].join('|');
  let rig = horseCache.get(key);
  if (!rig) { const gait = moving ? horseGait('gallop', ph) : { legs: [[0, 0], [0, 0], [0, 0], [0, 0]], bob: 0, nod, tail };
    rig = horseRig2D((e.dir || 0) * Math.PI / 4, gait, HORSE_PAL[e.utype] || HORSE_PAL.scout, tc, null); rig.gait = gait;
    if (horseCache.size > 2000) horseCache.clear(); horseCache.set(key, rig); }
  const gait = rig.gait, m = e.facing === -1 ? -1 : 1;
  const at = f => f && (() => { X.save(); X.scale(m, 1); X.translate(0, 5); f(); X.restore(); });   // (it draws its own heading: undo drawUnit's mirror)
  return { back: at(rig.back), front: at(rig.front), body: at(rig.body), head: at(rig.head), frontHead: rig.frontHead, seat: [rig.seat[0] * m, rig.seat[1] + 5], gait };
}
// A dropped weapon or shield (pov3d's droppedItem): built upright on its base, it leaves the hand at `from` (art px),
// tips over sideways toward `fall` (world-style: x fwd, y up, z across) as it falls — accelerating — spins a little in
// the air, clatters with a bounce and lies flat, `travel` tiles out. Returns a point mapping: the item's own frame
// (art px, y down from its base) → art px in the unit's frame.
function dropXf(age, from, fall = [0.3, 0, 0.95], travel = 0.24){
  const u = Math.max(0, Math.min(1, (age - 120) / 560)), bounce = age > 680 && age < 920 ? 1 - 0.07 * Math.sin((age - 680) / 240 * Math.PI) : 1;
  const ax = [fall[2], 0, -fall[0]], al = Math.hypot(...ax), n = ax.map(v => v / al), a = (Math.PI / 2) * u ** 1.5 * bounce, sp = 0.9 * u;
  const rot = (v, k, t) => { const c = Math.cos(t), s = Math.sin(t), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], cr = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
    return v.map((vi, i) => vi * c + cr[i] * s + k[i] * d * (1 - c)); };
  const T = HORSE_TILE, base = [from[0] + fall[0] * travel * T * u, from[1] + (4.1 - from[1]) * u * u - 0.1 * T * 4 * u * (1 - u), from[2] + fall[2] * travel * T * u];
  return q => { const w = rot(rot([q[0], -q[1], q[2]], n, a), [0, 1, 0], sp); return [base[0] + w[0], base[1] - w[1], base[2] + w[2]]; };
}
// A dead rider's horse (pov3d's cavalryFrame die): it stumbles — nose down, the fore legs buckling — then rolls onto
// its −z flank, accelerating, with a bounce as it lands and a last kick. age: ms since the death. A painter in
// drawUnit's frame (the ground at y 5), as horse2D's.
const HORSE_TILE = HALF_TW * Math.SQRT2 / UNIT_SCALE;                           // art px per tile (pov3d's ax: tiles ↔ art px)
function horseDeath2D(e, age, tc){
  const cl = v => Math.max(0, Math.min(1, v)), st = easeC(age / 300), u = cl((age - 250) / 550);
  let rot = (Math.PI / 2.1) * u * u; if (age > 800 && age < 1100) rot *= 1 + 0.07 * Math.sin((age - 800) / 300 * Math.PI);
  const kick = age > 900 && age < 1700 ? Math.max(0, Math.sin((age - 900) / 110 * Math.PI)) * (1 - (age - 900) / 800) : 0;
  const gait = { legs: [0, 1, 2, 3].map(i => i < 2 ? [-2.2 * u, 1.4 * kick * (i ? 0.6 : 1)] : [-1.8 * st * (1 - u) + 2.2 * u, 1.8 * st * (1 - u)]), bob: -1.4 * st * (1 - u) - 0.8 * u, nod: 0.5 * st, tail: 0.4 * kick };
  // (three's rotation.set(−rot, 0, pitch): the pitch nose-down first, then the roll about the long axis; lifted onto its flank)
  const pa = -0.2 * st * (1 - u), cp = Math.cos(pa), sp = Math.sin(pa), cr = Math.cos(-rot), sr = Math.sin(-rot), lift = 0.12 * HORSE_TILE * Math.sin(Math.min(rot, Math.PI / 2));
  const xf = ([x, y, z]) => { const x1 = x * cp - y * sp, y1 = x * sp + y * cp; return [x1, y1 * cr - z * sr + lift, y1 * sr + z * cr]; };
  const rig = horseRig2D((e.dir || 0) * Math.PI / 4, gait, HORSE_PAL[e.utype] || HORSE_PAL.scout, tc, null, 1, xf), m = e.facing === -1 ? -1 : 1;
  return () => { X.save(); X.scale(m, 1); X.translate(0, 5); rig.back(); if (rig.front) rig.front(); X.restore(); };
}
// ---- The sheep: one model and one animation for both views ----
// pov3d's sheepModel (tiles: x forward, y up, z across), posed by sheepAnim — set on the model by the 3D view, projected
// at the sheep's heading by the 2D view (projKit). A trot that keeps pace with the ground (half the cycle a foot is
// planted), breathing and a slow look round at rest; grazing, the head goes down and chews.
// (the legs hang from high inside the fleece — hipY/leg — so the stride's swing reads under it; L, the stride's
// reach, matches the leg so a planted foot keeps pace with the ground)
const SHEEP = { A: 0.55, L: 0.2, lift: 0.03, bob: 0.01, cy: 0.27, wool: '#f2eddd', face: '#3f3b34', ear: '#4d4940', legCol: '#3d3a35', hoof: '#1e1b16',
  hips: [[-0.11, -0.075], [-0.11, 0.075], [0.1, -0.07], [0.1, 0.07]], hipY: 0.21, leg: 0.2, legPhase: [0, 0.5, 0.25, 0.75].map(f => f * 2 * Math.PI) };
// a: per-sheep state (gait, phase, graze); moved: tiles walked since the last frame; clk: the authored-tick clock.
// Returns { bob, breath, neck (nod, − lowers), look (turn), legs: [{ ang, up }] (hind −z, hind +z, fore −z, fore +z) }.
function sheepAnim(e, a, dt, moved, clk){
  const C = SHEEP, idp = e.id || 0;
  a.gait = (a.gait || 0) + ((moved > 1e-4 ? 1 : 0) - (a.gait || 0)) * Math.min(1, dt * 8);
  a.phase = (a.phase || 0) + moved / (4 * C.L * Math.sin(C.A)) * 2 * Math.PI;
  a.graze = (a.graze || 0) + ((e.eatingGrass ? 1 : 0) - (a.graze || 0)) * Math.min(1, dt * 4);
  const look = 0.35 * Math.sin(clk * 0.013 + idp) ** 3 * (1 - a.gait);                 // now and then a slow look round
  // each leg: half the cycle planted, its foot sweeping back at an even pace, half swinging forward through the air
  const legs = C.legPhase.map(lp => { const q = (((a.phase + lp - Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let x, up = 0; if (q < Math.PI) x = 1 - 2 * q / Math.PI; else { const u = q / Math.PI - 1; x = -Math.cos(u * Math.PI); up = Math.sin(u * Math.PI); }
    return { ang: Math.asin(Math.sin(C.A) * x) * a.gait, up: C.lift * up * a.gait }; });
  return { bob: C.bob * Math.abs(Math.sin(2 * a.phase)) * a.gait, breath: Math.sin(clk * 0.06 + idp) * 0.015 * (1 - a.gait),
    neck: -0.95 * a.graze + Math.sin(clk * 0.12) * 0.04 * a.graze, look: look * (1 - a.graze),   // (grazing: a slow tug at the grass, every ~1.7 s — a faster nod read as the head shaking)
    legs };
}
const sheep2DState = new Map();
// The 2D sheep: sheepModel projected at its smoothed course (as the bear: the tile path's turns averaged over ~1.5 tiles
// walked, so it doesn't swing at each corner), turning at a sheep's pace; standing, it keeps its heading.
// Dead (sheep_carcass, the same entity): it rolls onto its side and lies with the heading it died with (pov3d's
// deathPose), then is eaten down as it's harvested (harvestPose): the legs go first, then the wool, the side facing up
// first, until only the bones are left (sheepBones).
const SHEEP_DEAD_HALF = 0.19;                                                          // (pov3d's DEAD_HALF: tiles it lifts as it rolls onto its side)
function drawSheep2D(e){
  let a = sheep2DState.get(e.id); if (!a) sheep2DState.set(e.id, a = { px: e.x, py: e.y, hd: (e.dir || 0) * Math.PI / 4 });
  const dead = e.utype === 'sheep_carcass';
  if (dead) { const now = performance.now(); a.deadAt = a.deadAt || (a.P ? now : now - 2000);   // (seen already dead: lying)
    const age = now - a.deadAt, p = Math.min(1, age / 600);
    a.rot = (Math.PI / 2.1) * p * p * (age > 600 && age < 900 ? 1 + 0.07 * Math.sin((age - 600) / 300 * Math.PI) : 1);   // accelerating, an impact recoil
    a.P = { bob: 0, breath: 0, neck: -0.35 * p, look: 0, legs: [0, 1, 2, 3].map(i => ({ ang: (i < 2 ? -0.45 : 0.45) * p, up: 0 })) }; }
  else if (!window._maskDraw || !a.P) {
    const now = performance.now(), dt = a.last ? Math.min(0.1, (now - a.last) / 1000) : 1 / 60; a.last = now;
    const [mx, my] = walkedSince(a, e), moved = Math.hypot(mx, my);
    if (moved > 1e-4) { const c = Math.min(1, moved / 1.5), ux = mx / moved, uy = my / moved; a.cx = (a.cx ?? ux) + (ux - (a.cx ?? ux)) * c; a.cy = (a.cy ?? uy) + (uy - (a.cy ?? uy)) * c; }
    if (isUnitMoving(e)) a.walkT = now;
    if (now - (a.walkT || -1e9) < 400 && a.cx !== undefined) { const want = Math.atan2(a.cy, a.cx); a.hd += Math.atan2(Math.sin(want - a.hd), Math.cos(want - a.hd)) * Math.min(1, dt * 6); }
    a.P = sheepAnim(e, a, dt, moved, animTick);
  }
  const P = a.P, C = SHEEP, S = 0.75 * HALF_TW * Math.SQRT2 / UNIT_SCALE;                // art px per tile (×0.75: the 2D sheep's size beside the 2D villagers)
  // dead: rolled about its long axis onto its −z flank (three's rotation.x = −rot), lifted by its half-width
  const cr = Math.cos(dead ? a.rot : 0), sr = Math.sin(dead ? a.rot : 0), lift = dead ? SHEEP_DEAD_HALF * S * Math.sin(Math.min(a.rot, Math.PI / 2)) : 0;
  const { P: pj, depth, faces, parts, blob, tube, paint } = projKit(a.hd, dead ? ([x, y, z]) => [x, y * cr + z * sr + lift, z * cr - y * sr] : null), TAU = Math.PI * 2;
  // harvested (the food left, 1 → 0): the legs go at the first bite, the fleece puff by puff (the side up first), the bones at the end
  const left = dead ? Math.max(0, Math.min(1, e.hp / (e.maxHp || 100))) : 1, wool = Math.max(0, Math.min(1, (left - 0.12) / 0.88)), bare = left < 0.12;
  // frames (tiles in, art px out): the body rides the bob and breathes; the legs and neck hang from it
  const bd = (x, y, z) => [x * S, (y * (1 + P.breath) + P.bob) * S, z * S];
  const nz = Math.cos(P.neck), ns = Math.sin(P.neck), ly = Math.cos(P.look), ls = Math.sin(P.look);
  const nk = (x, y, z) => { const x1 = x * nz - y * ns, y1 = x * ns + y * nz, x2 = x1 * ly + z * ls, z2 = -x1 * ls + z * ly; return bd(0.2 + x2, C.cy + 0.03 + y1, z2); };
  const tc = e.team === GAIA_TEAM ? C.wool : teamColor(e.team);                        // the fringe: its owner's colour (white: nobody's yet)
  // the fleece: a fat core, eight puffs over the upper body (golden-angle spiral) and a ring of twelve standing out of
  // its edge — a scalloped fleece, not a smooth ball (as the 3D)
  const core = blob(C.wool, bd, 0, C.cy, 0, 0.24, 0.17, 0.2, 'body'), bodyD = core.pt.d;
  if (bare) parts.pop();
  const puffs = Array.from({ length: 8 }, (_, i) => { const v = 1 - (i + 0.5) / 8 * 1.45, r = Math.sqrt(Math.max(0, 1 - v * v)), an = i * 2.39996;
    return [Math.cos(an) * r * 0.21, C.cy + v * 0.13, Math.sin(an) * r * 0.16, 0.1 + (i % 3) * 0.012]; });
  for (let i = 0; i < 12; i++) { const an = i / 12 * TAU + 0.26; puffs.push([Math.cos(an) * 0.235, C.cy + (i % 2 ? 0.05 : -0.01), Math.sin(an) * 0.19, 0.07 + (i % 3) * 0.008]); }
  const kept = dead ? puffs.slice().sort((p, q) => q[2] - p[2] || q[1] - p[1]).slice(Math.round(puffs.length * (1 - wool))) : puffs;   // (pulled off the up-facing, +z, side first)
  for (const [x, y, z, pr] of kept) blob(C.wool, bd, x, y, z, pr, pr, pr, 'body');
  if (bare) sheepBones2D({ blob, tube }, bd, nk);
  // the belly's shade (as the 2D art had it): a soft band along the bottom of the fleece, clipped to its outline
  if (!bare) { const fleece = parts.filter(p => p.grp === 'body'), dTop = Math.max(...fleece.map(p => p.d)), b0 = core.c;
    parts.push({ col: 'rgba(110,95,70,0.24)', d: dTop + 1e-4, grp: 'body', outline: false, path: () => { X.save(); X.beginPath(); for (const p of fleece) p.path(); X.clip();
      X.beginPath(); X.ellipse(b0[0], b0[1] + core.r2 * 1.05, core.r1 * 1.15, core.r2 * 0.75, core.rot, 0, TAU); X.fill(); X.restore(); X.beginPath(); } }); }
  // legs from the belly (lifted on the swing), a dark hoof; drawn behind the fleece so only what hangs below shows
  if (left > 0.9) C.hips.forEach(([hx, hz], i) => { const L = P.legs[i], sa = Math.sin(L.ang), ca = Math.cos(L.ang), hy = C.hipY + L.up;
    // (a size up on the 3D's: at 2D size its thin legs vanished under the fleece)
    const lg = tube(C.legCol, [bd(hx, hy, hz), bd(hx + C.leg * sa, hy - C.leg * ca, hz)], 0.03 * S, 'legs'), fd = depth(...(m => [m[0], m[2]])(bd(hx, 0, hz)));
    lg.d = bodyD - 1 + (fd - bodyD) * 0.01; blob(C.hoof, bd, hx + (C.leg + 0.01) * sa, hy - (C.leg + 0.01) * ca, hz, 0.036, 0.026, 0.032, 'legs').pt.d = lg.d + 1e-4; });
  // the head: big and dark, pale eyes, ears out to the sides, the fringe on top — its pieces sorted against the head
  // itself, not by their own depths (as it nods and turns, those crossed the fleece's at other moments: the fringe
  // popped in front of the fleece and back while the head didn't)
  const hx = 0.12, hy = 0.035;
  if (!bare) { const head = blob(C.face, nk, hx, hy, 0, 0.1, 0.115, 0.09, 'head', 0.01), hd = head.pt.d;
  // ears out to the sides, drooping (the 3D's: tipped 0.35 down about the head's long axis), one piece with the head
  // (no line of their own: end-on, in profile, an outlined ear read as a second eye)
  for (const z of [-1, 1]) { const ec = [hx - 0.025, hy + 0.04 - 0.012, z * 0.105], ca = Math.cos(z * -0.35), sa = Math.sin(z * -0.35);
    const ef = (x, y, zz) => { const dy = y - ec[1], dz = zz - ec[2]; return nk(x, ec[1] + dy * ca - dz * sa, ec[2] + dy * sa + dz * ca); };
    const ear = blob(C.ear, ef, ...ec, 0.033, 0.017, 0.06, 'head'); ear.pt.d = hd + (depth(ear.o[0], ear.o[2]) > depth(head.o[0], head.o[2]) ? 0.0015 : -0.0015); }   // (the near ear over the head, the far one under)
  if (!dead) { const hc = head.o; for (const z of [-1, 1]) { const fx = 0.55, fy = 0.35, fz = 0.55 * z, t = 1 / Math.hypot(fx / 0.1, fy / 0.115, fz / 0.09), sz = 0.027;
      const m = nk(hx + fx * t, hy + fy * t, fz * t); if (faces([m[0] - hc[0], m[1] - hc[1], m[2] - hc[2]]) <= 0.3) continue;   // (only the eyes clearly facing us: one round the edge read as a stray dot)
      // the 3D's eyes: pale, a dark pupil set forward on each along the head's surface normal
      const ex = hx + fx * t, ey = hy + fy * t, ez = fz * t, nl = Math.hypot(fx / 0.01, fy / 0.013225, fz / 0.0081), n3 = [fx / 0.01 / nl, fy / 0.013225 / nl, fz / 0.0081 / nl];
      blob('#f4efe2', nk, ex, ey, ez, sz, sz, sz, 'head', 0, false).pt.d = hd + 0.003;
      blob('#141414', nk, ex + n3[0] * sz * 0.55, ey + n3[1] * sz * 0.55, ez + n3[2] * sz * 0.55, sz * 0.6, sz * 0.6, sz * 0.6, 'head', 0, false).pt.d = hd + 0.004; } }
  // (the fringe a size up on the 3D's: it's the owned-sheep tell, and read small at 2D size)
  if (wool > 0.5) { const f = blob(tc, nk, hx - 0.01, hy + 0.115, 0, 0.075, 0.07, 0.075, 'head'); f.pt.d = hd + 0.002; f.pt.line = e.team !== GAIA_TEAM; } }
  X.save(); if (e.facing === -1) X.scale(-1, 1);                                      // (it draws its own heading: undo drawUnit's mirror)
  X.translate(0, 5); paint(parts);
  // grazing: a few blades at the mouth
  const mo = nk(hx + 0.09, hy - 0.06, 0);
  if (!dead && e.eatingGrass && depth(mo[0], mo[2]) > bodyD) { const m = pj(...mo);   // (not when the mouth is behind the fleece)
    X.strokeStyle = '#4e8c2d'; X.lineWidth = 1.2 / UNIT_SCALE; X.beginPath(); X.moveTo(m[0], m[1]); X.lineTo(m[0] + 2.5, m[1] + 2); X.moveTo(m[0] - 0.4, m[1] + 0.3); X.lineTo(m[0] + 1.6, m[1] + 2.8); X.stroke(); }
  X.restore();
}
// The harvested sheep's bones (pov3d's sheepBones), in the body frame bd and the neck frame nk (tiles): the fewest that
// read — a spine, two fat ribs arching up over it once it lies on its side (+z up), a big skull with big sockets
function sheepBones2D(k, bd, nk){
  const S = (bd(1, 0, 0)[0] - bd(0, 0, 0)[0]);
  k.tube(BONE, [bd(-0.16, 0.3, 0), bd(0.15, 0.31, 0)], 0.026 * S, 'body');
  for (const x of [-0.07, 0.06]) k.tube(BONE, Array.from({ length: 9 }, (_, i) => { const a = i / 8 * Math.PI; return bd(x, 0.3 + 0.1 * Math.cos(a), 0.1 * Math.sin(a)); }), 0.026 * S, 'body');
  const sk = k.blob(BONE, nk, 0.12, 0.04, 0, 0.095, 0.1, 0.08, 'head'); k.blob(BONE, nk, 0.21, 0.01, 0, 0.05, 0.045, 0.045, 'head');
  for (const z of [-1, 1]) k.blob(BONE_HOLE, nk, 0.17, 0.07, z * 0.045, 0.03, 0.03, 0.03, 'head', 0, false).pt.d = sk.pt.d + 0.001;
}
// ---- The villager: pov3d's human() projected at its heading ----
// (one piece, as the 3D: a single outer outline, no lines inside it — inner lines carved it into a muscled look)
// The same build (art px: x forward, y down to the ground at 5, z across) and the same poses as the 3D view: two-bone
// legs knee-forward, the torso (or the dress, a lathe) turning at the hips, the head at the neck, two-bone arms with a
// puffed sleeve, hair. Walk and idle are shared (villagerWalkPose / villagerIdlePose).
const HUMAN_COL = { skin: '#edc9a0', hair: '#b58e3d', leg: '#5b3a1e', boot: '#3a2412' };
const VIL_STRIDE = 2.6;                                                                // art px of foot travel
// walk: each foot half the cycle planted, sweeping back, half swinging forward with a lift; the arms swing opposite the
// legs; the body bobs twice a stride. Returns { feet: [[x, lift] ×2], hands, bob } (sides −z, +z).
function villagerWalkPose(t){
  const leg = ph => { const u = ((ph % 1) + 1) % 1;
    return u < 0.5 ? [VIL_STRIDE * (1 - 4 * u), 0] : [VIL_STRIDE * (-1 + 4 * (u - 0.5)), 1.6 * Math.sin((u - 0.5) * 2 * Math.PI)]; };
  const L = leg(t), R = leg(t + 0.5), bob = 0.55 * Math.abs(Math.cos(2 * Math.PI * t));
  const arm = (fx, s) => [1 - fx * 0.9, -2.6 + Math.abs(fx) * 0.25, s * 5.6];
  return { feet: [L, R], hands: [arm(L[0], -1), arm(R[0], 1)], bob };
}
// idle: the weight rolling, a breath, a slow look round
function villagerIdlePose(t){
  const b = Math.sin(2 * Math.PI * t), br = 0.5 + 0.5 * Math.sin(8 * Math.PI * t);
  return { hands: [[1 + 0.3 * b, -2.4 - 0.2 * br, -5.6], [1 - 0.3 * b, -2.4 - 0.2 * br, 5.6]], torso: { yaw: 0.06 * b, lean: 0.02, dip: 0.25 * br }, headYaw: 0.5 * Math.sin(2 * Math.PI * t + 0.6), feet: [[0.4, 0], [-0.3, 0]] };
}
// ---- The villager's work: actions and poses, both views (pov3d builds them in the round, the 2D projects them) ----
// Poses: art px (x forward, y down, z across, +z the tool side), from a phase t in [0,1): { hands: [−z, +z], torso
// { yaw, lean, dip }, headYaw, feet, and the tool's grip / dir (world-style, y up) / edge }.
const easeC = u => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, u)))) / 2;
const lerpV = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
// Swings hold near the handle's end (the lower hand at the butt): the head rides a wider, faster arc, a real power swing.
const GRIP_OUT = 3.6;
// Work cycles in cycles per authored tick (aTick, 30/s): the 3D swings
// run slower and fuller than the 2D jab.
const VIL_RATE = { split: 0.021, chop: 0.022, saw: 0.034, mine: 0.021, build: 0.03, repair: 0.034, farm: 0.019, plow: 0.03, forage: 0.019, butcher: 0.036, fight: 0.042, idle: 0.0085 };
// a work cycle's phase on the clock clk (authored ticks: pov3d's aTick, the 2D's animTick), each villager offset
const villagerWorkPhase = (e, k, clk) => { const r = clk * VIL_RATE[k] + e.id * 0.37; return ((r % 1) + 1) % 1; };
const WALK_TILES = { walk: 0.62, carry: 0.62, barrow: 0.66, plow: 0.5, flee: 1.0 }; // ground covered per stride cycle

// chop: a horizontal sweep (how a real axe fells a trunk) — wound back and a
// little up behind the tool-side shoulder, then whipped round through the
// front to strike at waist height, slightly downhill; the torso twists with
// it. yaw φ: 0 = straight ahead, + = round to the tool side (+z), behind at ~115°.
const CHOP_R = 8.6;
// The lower fist sits ON the handle, a fist's width below the upper one toward
// the butt (dir: world-style, y up; art y runs down).
const onHandle = (grip, dir, d = 2.2) => { const L = Math.hypot(...dir); return [grip[0] - dir[0] / L * d, grip[1] + dir[1] / L * d, grip[2] - dir[2] / L * d]; };
function chopYaw(t){ // 70% slow wind-up to 140°, 30% fast strike round to −20°
  return t < 0.7 ? -20 + 160 * (1 - Math.cos(Math.PI * t / 0.7)) / 2 : 140 - 160 * Math.pow((t - 0.7) / 0.3, 1.6);
}
// The whole body chops: feet planted apart, lead foot forward; the torso
// winds back toward the tool side (weight on the back foot, leaning back),
// then unwinds hard through the front (weight onto the lead foot, leaning
// into the cut, a small dip at impact); the head counter-turns to keep the
// eyes on the trunk.
function chopPose(t){
  const f = chopYaw(t) * Math.PI / 180, c = Math.cos(f), s = Math.sin(f);
  const wind = Math.max(0, s), strike = t >= 0.7 ? (t - 0.7) / 0.3 : 0;
  const y = -8 - 2.2 * wind;                                                              // raised a little in the wind-up
  const grip = [CHOP_R * c, y, CHOP_R * s], dir = [c, -0.18 + 0.7 * wind, s], low = onHandle(grip, dir);
  const yaw = -0.85 * Math.max(-0.35, Math.min(2.45, f));                                // a big twist with the swing (+z side = back)
  const lean = -0.16 * wind + 0.26 * Math.sin(Math.PI * Math.min(1, strike * 1.2));
  const dip = 1.1 * Math.max(0, Math.sin(Math.PI * (strike - 0.55) / 0.45));
  return { hands: [low, grip], dir, edge: [s, 0, -c], grip,
    torso: { yaw, lean, dip }, headYaw: -yaw * 0.85, feet: [[1.6 + 0.4 * strike, 0], [-1.4, 0.25 * wind]] };
}
// Overhead strike (mine / build): the hands ride an arc in a plane out on the
// tool side (clear of the head) — raised back over the shoulder with the body
// arching back, then driven down to the ground ahead, bending over into it
// with a knee dip. θ: degrees above horizontal.
// Overhead power swing, straight down the middle (mine, build): both fists on
// the handle on the body's centre line (so neither arm crosses the body), the
// hands riding an arc in front of the face from overhead — the tool cocked
// back over the head — down to the blow ahead; the body arches back as it's
// raised and bends into the blow with a knee dip. θ: the hands' arc angle,
// φ: the handle's (it leads the arc by `cock` at the top, `lead` at the blow).
function overheadPose(t, { top, low, R, cock, lead, split = 0.6 }){
  const raise = t < split ? easeC(t / split) : 1 - Math.pow((t - split) / (1 - split), 1.7), strike = t >= split ? (t - split) / (1 - split) : 0;
  const th = (low + (top - low) * raise) * Math.PI / 180, ph = th + (lead + (cock - lead) * raise) * Math.PI / 180;
  const d = [Math.cos(ph), Math.sin(ph), 0], grip = [1.5 + R * Math.cos(th), -9.5 - R * Math.sin(th), 0];
  const butt = [grip[0] - d[0] * 2.2, grip[1] + d[1] * 2.2, 0];
  const lean = -0.18 * raise + 0.4 * Math.sin(Math.PI * Math.min(1, strike * 1.15) / 2) * (1 - Math.max(0, strike - 0.85) * 3);
  return { hands: [butt, grip], grip, dir: d, edge: [Math.sin(ph), -Math.cos(ph), 0],
    torso: { yaw: 0, lean, dip: 1.4 * Math.max(0, Math.sin(Math.PI * (strike - 0.5) / 0.5)) }, headYaw: 0, feet: [[1.8, 0], [-1.4, 0]] };
}
const minePose = t => overheadPose(t, { top: 74, low: -26, R: 10, cock: 40, lead: -12 });   // the point driven down into the rock
const splitPose = t => overheadPose(t, { top: 70, low: -30, R: 10, cock: 40, lead: -14 });  // a felled trunk: the axe brought straight down onto it
const buildPose = t => overheadPose(t, { top: 62, low: -8, R: 7.4, cock: 34, lead: 8, split: 0.55 }); // the handle level at the blow: the face lands flat on the post
// Scythe: the blade always points the same way — toward the cutting side,
// square to the snath (it never flips). It mows on one stroke only, swept
// from the tool side across the front with the blade skimming the ground
// (45% of the cycle), then carried back empty and a little lifted.
function mowPose(t){
  const cut = t < 0.45, u = cut ? t / 0.45 : (t - 0.45) / 0.55, ease = (1 - Math.cos(Math.PI * u)) / 2;
  const f = (cut ? 62 - 124 * ease : -62 + 124 * ease) * Math.PI / 180, c = Math.cos(f), sn = Math.sin(f);
  const lift = cut ? 0 : 1.6 * Math.sin(Math.PI * u);
  const grip = [7.6 * c, -5.2 - lift, 7.6 * sn], dir = [c, -0.9 + lift * 0.12, sn], low = onHandle(grip, dir);
  return { hands: [low, grip], dir, edge: [sn, 0, -c], grip, torso: { yaw: -0.85 * f, lean: 0.12, dip: cut ? 0.4 : 0.2 }, headYaw: 0.6 * f, feet: [[1, 0], [-1, 0]] };
}
// Bow saw, felling: laid on its side against the trunk — the blade level at
// the waist SAW_X ahead, teeth into the bark, the frame tipped back toward
// the villager (SAW_TIP from flat, so the arch clears his body) — stroked side
// to side along the blade, both hands on the middle of the bow.
const SAW_X = 14.5, SAW_Z = 12.2, SAW_Y = -6, SAW_TIP = 1.35; // the saw's near end at z = SAW_Z − 4 (art px)
function sawPose(t){ const off = 3 * Math.sin(2 * Math.PI * t);
  // both fists round the frame's top bar (bowSaw: 6.5px above the blade), either side of its middle
  const bow = 6.4, bx = SAW_X - Math.sin(SAW_TIP) * bow, by = SAW_Y - Math.cos(SAW_TIP) * bow;
  return { off, hands: [[bx, by, SAW_Z - 12.7 - off], [bx, by, SAW_Z - 10.3 - off]], torso: { yaw: 0.1 * off - 0.15, lean: 0.2, dip: 0.5 }, feet: [[1.6, 0], [-1.2, 0]] }; }
// forage: one hand at a time reaches into the bush, plucks (a small tug) and
// drops the berry into the other, cupped at the belly; the hands trade each pick.
const FORAGE_REACH = [[9.4, -4.6, -2.4], [9.8, -6.8, 2.6]];
function foragePose(t){
  const s = t < 0.5 ? 1 : -1, u = (t % 0.5) / 0.5, i = s > 0 ? 1 : 0;
  const e = u < 0.45 ? easeC(u / 0.45) : u < 0.6 ? 1 - 0.1 * (u - 0.45) / 0.15 : 0.9 * (1 - easeC((u - 0.6) / 0.4));
  const hands = [];
  hands[i] = lerpV([6.3, -7.6, s * 1.2], FORAGE_REACH[i], e);
  hands[1 - i] = [6.6, -6.2, -s * 1];                                                       // cupped, catching
  return { hands, berry: u > 0.5 && u < 0.95 ? hands[i] : null, torso: { yaw: -0.14 * s * e, lean: 0.16 + 0.14 * e, dip: 0.3 }, headYaw: 0.1 * s * e, feet: [[1, 0], [-0.6, 0]] };
}
// butcher: bent right over the carcass, one hand pinning it, the knife
// hand stabbing down in quick jabs and drawing back slowly (the 2D jab clock).
function butcherPose(t){
  const jb = t < 0.25 ? easeC(t / 0.25) : 1 - easeC((t - 0.25) / 0.75);
  const kh = lerpV([7, -9, 2.4], [9.4, -5.6, 1.4], jb);
  return { hands: [[10, -4.6, -2.8], kh], knife: kh, kdir: [0.45 - 0.1 * jb, -1, -0.1], jab: jb,
    torso: { yaw: -0.1, lean: 0.5 + 0.08 * jb, dip: 1.6 + 0.4 * jb }, headYaw: 0, feet: [[2.4, 0], [-1.8, 0]] };
}
// repair: hammering a wall, the mallet choked up in one fist: the arm lifts
// it up and back over the shoulder (out on the tool side, clear of the head),
// then brings it down and forward so the face meets the planks square at
// shoulder height (handle near upright); the free hand braces on the wall.
const WALL_X = 10.5, REP_HIT = [5.6, -4.5, 6.2], REP_UP = [1.6, -14, 9.5];
// Where each job's target sits from the villager at the blow (tiles: [ahead, across]) — its tool's head at impact on
// the shared poses (as toolHead lays a tool along its dir from the grip): both views step a worker in by it so the
// tool meets the trunk, the rock, the post. A tree's target is its trunk's centre: the axe's edge meets its bark.
let WORK_REACH = null;
function villagerWorkReach(){
  if (WORK_REACH) return WORK_REACH;
  const U = UNIT_SCALE / (HALF_TW * Math.SQRT2), TRUNK = 2.2 / (HALF_TW * Math.SQRT2) * 1.35;   // art px → tiles; the 3D tree's trunk radius
  const head = (pose, lx, ly) => { const P = pose(0.9999), dl = Math.hypot(...P.dir), d = P.dir.map(v => v / dl), ed = P.edge[0] * d[0] + P.edge[1] * d[1] + P.edge[2] * d[2];
    let e = P.edge.map((v, i) => v - d[i] * ed); const el = Math.hypot(...e) || 1; e = e.map(v => v / el);
    const k = GRIP_OUT + 13 * 0.55 + ly; return [(P.grip[0] + d[0] * k + e[0] * lx) * U, (P.grip[2] + d[2] * k + e[2] * lx) * U]; };
  const n = Math.hypot(-0.34, -0.94), chop = head(chopPose, 5, -1.5), mine = head(minePose, 4.6, -1.4);
  return WORK_REACH = { chop: [chop[0] - 0.34 / n * TRUNK * 1.05, chop[1] - 0.94 / n * TRUNK * 1.05], saw: [(SAW_X + 0.6) * U + TRUNK * 0.9, (SAW_Z - 11.5) * U],
    mine: [mine[0] + 0.17, mine[1]], split: head(splitPose, 5, -1.5), forage: [FORAGE_REACH[1][0] * U + 0.16, 0], butcher: [10 * U + 0.44, 0],
    build: head(buildPose, 3.75, 0), repair: [WALL_X * U, 0] };
}
function repairPose(t){
  const w = t < 0.6 ? easeC(t / 0.6) : 1 - Math.pow((t - 0.6) / 0.4, 1.6);        // 1 = wound up over the shoulder
  const phi = (10 - 65 * w) * Math.PI / 180, grip = lerpV(REP_HIT, REP_UP, w);
  return { hands: [[WALL_X - 0.6, -9.5, -3], grip], grip, dir: [Math.sin(phi), Math.cos(phi), 0], edge: [Math.cos(phi), -Math.sin(phi), 0],
    torso: { yaw: 0.12 * w - 0.08, lean: 0.14 - 0.12 * w, dip: 0.2 }, headYaw: 0.1, feet: [[1.4, 0], [-1, 0]] };
}
// fight: a lunging knife jab from a guard, the shoulder turning into it.
const FIGHT_X = 18.5;
function fightPose(t){
  const jb = t < 0.25 ? easeC(t / 0.25) : 1 - easeC((t - 0.25) / 0.75);
  const kh = [6.2 + 4.6 * jb, -8.4 - 0.4 * jb, 2.6 - 1.4 * jb];
  return { hands: [[4.2, -11.5, -3.2], kh], knife: kh, kdir: [1, 0.12, -0.08], jab: jb,
    torso: { yaw: -0.25 + 0.5 * jb, lean: 0.08 + 0.22 * jb, dip: 0.4 + 0.4 * jb }, headYaw: 0.2 - 0.3 * jb, feet: [[1.8 + 1.4 * jb, 0], [-1.6, 0]] };
}

const VIL_TOOL = { chop: 'axe', mine_gold: 'pick', mine_stone: 'pick', build: 'mallet', farm: 'scythe' };
function villagerLoad(e){
  if (e.carryType !== 'food') return e.carryType;
  return e.foodSrc === 'wheat' ? 'food' : e.foodSrc === 'meat' ? 'wool' : 'berries';
}
// What a villager is doing, as a lab action ({ kind, t, opt }) — both views' reading of the same sim state. stride: tiles
// walked (the walk's phase), clk: the work clock (authored ticks). Viewer-only: reads sim state, never writes it.
function villagerAction(e, stride, clk){
  const moving = isDrawnMoving(e), up = hasUpgrade.bind(null, e.team), opt = {};
  if (moving) {
    const farmWalk = e.task === 'farm' && e.gatherX >= 0 && Math.max(Math.abs(e.x - e.gatherX), Math.abs(e.y - e.gatherY)) < 1.8;
    let kind = 'walk';
    // the load shows only while HAULING along a path (as 2D's carryShow) — not in the last press into contact, where
    // the first bite already lands
    // (a hauler on its way to drop it — task 'return' — keeps it in hand right up to the throw, the last step too)
    if (e.carrying > 0 && !farmWalk && (e.path.length > 0 || e.task === 'return')) { kind = up('wheelbarrow') ? 'barrow' : 'carry'; opt.load = villagerLoad(e); }
    else if (farmWalk && up('heavy_plow')) kind = 'plow';
    else if (isRetreatingUnit(e)) kind = 'flee';
    else if (VIL_TOOL[e.task]) opt.tool = VIL_TOOL[e.task];
    if (kind === 'barrow' && !(e.carrying > 0)) opt.load = null;
    return { kind, t: ((stride / WALK_TILES[kind]) % 1 + 1) % 1, opt };
  }
  let atSite = true, bt = null;
  if (e.task === 'chop' || e.task === 'mine_gold' || e.task === 'mine_stone') atSite = e.gatherX >= 0 && atGatherTile(e, e.gatherX, e.gatherY);
  else if (e.task === 'build' && e.buildTarget) { bt = entitiesById.get(e.buildTarget); atSite = !!bt && atBuildSite(e, bt); }
  else if (e.target) atSite = inActionRange(e);
  let kind = 'idle';
  if (e.task === 'return' && e.carrying > 0) { opt.load = villagerLoad(e); return { kind: 'carry', t: 0.25, opt }; } // at the drop, the load still in hand till the throw
  if ((e.task || e.target) && atSite) {
    if (e.task === 'chop') { const felled = e.gatherX >= 0 && map[e.gatherY] && map[e.gatherY][e.gatherX].res <= 60; // a cut tree lies felled: split the trunk on the ground
      kind = felled ? 'split' : up('bow_saw') ? 'saw' : 'chop'; opt.up = { double: up('double_bit_axe') }; }
    else if (e.task === 'mine_gold' || e.task === 'mine_stone') { kind = 'mine'; opt.up = { bright: e.task === 'mine_gold' && up('gold_mining') }; }
    else if (e.task === 'build') kind = bt && bt.complete ? 'repair' : 'build';
    else if (e.task === 'farm') { kind = up('heavy_plow') ? 'plow' : 'farm'; opt.up = { bright: up('horse_collar') }; }
    else if (e.task === 'forage') kind = 'forage';
    else if (!e.task && e.target) { const tg = entitiesById.get(e.target); kind = tg && tg.utype === 'sheep_carcass' ? 'butcher' : 'fight'; }
  } else if (e.carrying > 0) { opt.load = villagerLoad(e); return { kind: 'carry', t: 0.25, opt }; } // waiting with a load
  return { kind, t: villagerWorkPhase(e, kind, clk), opt };
}
// death (drawCorpse's staged sequence, in the round), by age in ms: struck —
// the head and shoulders snap back, arms flung out; the knees buckle and the
// hips drop; he goes over backward off the heels, accelerating, the legs
// straightening as he lays out; a small bounce on impact, the arms flopping
// out to the sides and the head rolling over. Blood seeps out from under
// him and dries brown; at `skel` the body gives way to cartoon bones (the
// bear's), which shrink away by `life`.
const DIE = { hit: 260, buckle: 700, land: 1200 };
// (ms) from here every death pose is still — the body's last bounce (villagerDeathPose), a thrown rider, the fallen
// horse's last kick (horseDeath2D) — so a corpse at rest is built once (_stillCorpse) instead of every frame
const DEATH_STILL = Math.max(DIE.land + 440, 1700);
// corpse pose object (drawCorpse's c.pose) -> { parts, fallen }: viewer-only, never on the corpse itself (corpses are
// saved and structuredClone'd into the lockstep snapshots — closures and Path2Ds would break both)
const _stillCorpse = new WeakMap();
function villagerDeathPose(age){
  const cl = v => Math.max(0, Math.min(1, v));
  const hit = easeC(age / DIE.hit), buck = easeC((age - 150) / (DIE.buckle - 150)), u = cl((age - 480) / (DIE.land - 480)), flop = easeC((age - DIE.land + 60) / 380);
  let fall = (Math.PI / 2) * u * u;                                                           // accelerating, as a body falls
  if (age > DIE.land && age < DIE.land + 280) fall *= 1 - 0.06 * Math.sin((age - DIE.land) / 280 * Math.PI); // the bounce
  else if (age >= DIE.land + 280 && age < DIE.land + 440) fall *= 1 - 0.022 * Math.sin((age - DIE.land - 280) / 160 * Math.PI); // and a smaller one
  const rest = s => [1, -2.4, s * 5.6], fling = s => [-1.5, -15.5, s * 8.6], limp = s => [2.2, -5, s * 6.4], trail = s => [-1.2, -17.5, s * 7.5], splay = s => [-1, -11.5, s * 10.5];
  const hand = s => lerpV(lerpV(lerpV(lerpV(rest(s), fling(s), hit), limp(s), buck), trail(s), u), splay(s), flop);
  return { fall, hands: [hand(-1), hand(1)], headYaw: 0.7 * flop - 0.25 * Math.sin(Math.PI * u),
    torso: { yaw: 0.12 * hit * (1 - u) + 0.35 * Math.sin(Math.PI * u), lean: -0.35 * hit * (1 - buck) + 0.3 * buck * (1 - u), dip: 3 * buck * (1 - u * u) + 0.3 * u }, // twisting as he goes over
    feet: [[1.4 * buck * (1 - u) + 0.3, 0], [-0.6, 0.8 * hit * (1 - buck)]] };
}
// flee: a run — long strides with high knees, leaning into it; the elbows stay
// bent and each fist pumps opposite its leg: up and in to the chest in front,
// down past the hip behind.
function runPose(t){
  const S = 3.8, leg = ph => { const u = ((ph % 1) + 1) % 1;
    return u < 0.5 ? [S * (1 - 4 * u), 0] : [S * (-1 + 4 * (u - 0.5)), 3.4 * Math.sin((u - 0.5) * 2 * Math.PI)]; };
  const L = leg(t), R = leg(t + 0.5), bob = 1.1 * Math.abs(Math.cos(2 * Math.PI * t));
  // Each upper arm swings from the shoulder (a: + forward), the elbow held at ~90°.
  const arm = s => { const sw = s * Math.cos(2 * Math.PI * t), a = sw > 0 ? 0.85 * sw : 0.95 * sw;
    const el = [4.5 * Math.sin(a), -8 + 4.5 * Math.cos(a), s * 5.3];
    return { el, hand: [el[0] + 4.2 * Math.cos(a), el[1] - 4.2 * Math.sin(a), s * (4.6 - 0.8 * Math.max(0, sw))] }; };
  const A = [arm(-1), arm(1)];
  return { feet: [L, R], hands: A.map(x => x.hand), elbows: A.map(x => x.el), bob, torso: { yaw: 0.05 * Math.sin(2 * Math.PI * t), lean: 0.26, dip: 0 }, headYaw: 0 };
}
// ---- Soldiers: gear, swings and poses, both views (pov3d builds them in the round, the 2D projects them) ----
const MIL_IMPACT = { militia: SWORD_HIT, spearman: 0.5, archer: 0.75, scout: SWORD_HIT, knight: SWORD_HIT, ram: 0.63 }; // where in each attack cycle the blow lands (swords: the shared swing's hit)
// The 3D flight is flat — a low arc, ARROW_ARC px of rise per tile of run (the 2D map's 7 px/tile reads well
// top-down; seen in the round it lobbed the arrows) — so the bow draws nearly level. The angle an arrow leaves the
// bow at: the flight below climbs (eH − sH + π·A)/HPX over its D-tile run, A = ARROW_ARC·D px — the same for every
// shot but for the small launch-to-impact drop (taken at the archer's range, 4 tiles).
const ARROW_ARC = 2.4, ARROW_LAUNCH = Math.atan2((8 - 12 + Math.PI * ARROW_ARC * 4) / (HALF_TW * Math.SQRT2 * Math.sqrt(3) / 2), 4);
const FORGE_STEEL = ['#8f8a7d', '#a8adb3', '#c6cdd8'];   // a soldier's steel by forge tier
function soldierEquip(ut, age, atk, arm, fletch){
  const v = { metal: FORGE_STEEL[atk], weapon: atk, torso: arm >= 2 ? 'chain' : arm >= 1 ? 'scale' : null, helmet: 'hood', shield: null, feather: false, quiver: false };
  if (ut === 'militia') { v.helmet = age >= 2 ? 'norman' : age === 1 ? 'kettle' : 'hood'; v.shield = age >= 2 ? 'kite' : age === 1 ? 'round' : null; }
  if (ut === 'spearman') v.helmet = age >= 2 ? 'norman' : 'kettle';
  if (ut === 'archer') { v.feather = fletch; v.quiver = age >= 2; }
  if (ut === 'scout' || ut === 'knight') { v.helmet = ut === 'knight' ? 'great' : age >= 2 ? 'spiked' : 'hood'; v.shield = ut === 'knight' ? 'kite' : age >= 2 ? 'round' : null; }
  return v;
}
// The sword swing both views share: render-units' swordSwingCurve/swordSwingArc (the 2D art's overhead chop — a slow
// windup over the shoulder, a whip-fast strike, a settle, the recovery) in the unit's own side plane: the grip orbits
// from its guard hand0 (art px), the blade turns as the 2D one does (horizontal at the strike, never into the ground).
// zOut: how far the raised hand swings out to the sword side (in the round the blade would pass through the head).
// t: the phase, the hit at SWORD_HIT. Returns the hand, blade dir and edge, and w / c: windup / strike 0..1.
function swordArc(t, hand0, base, zOut){
  const ssa = swordSwingCurve(((t % 1) + 1) % 1), A = swordSwingArc(ssa, base);
  const th = A.rot, w = Math.max(0, Math.min(1, (ssa - 0.5) / 0.65)), c = Math.max(0, Math.min(1, (0.5 - ssa) / 1.85));
  return { hand: [hand0[0] + A.ox, hand0[1] + A.oy, hand0[2] + zOut * w], dir: [Math.sin(th), Math.cos(th), 0], edge: [Math.cos(th), -Math.sin(th), 0], w, c };
}
const along = (p, d, k) => { const L = Math.hypot(...d); return [p[0] + d[0] / L * k, p[1] - d[1] / L * k, p[2] + d[2] / L * k]; }; // art pt + k px along a world-style dir
// Poses by unit and action: { hands, torso, headYaw, feet, weapon: {...} }.
function militiaPose(kind, t, eq){
  const two = !eq.shield, shieldHand = [5.6, -6.6, -6.4]; // out from the body and below the chin, so a turning head clears the shield's top
  if (kind === 'attack') { // the 2D art's overhead chop (swordArc: render-units' swordSwingArc), from its guard
    const { hand, dir, edge, w, c } = swordArc(t, two ? [7.6, -6.2, 0.4] : [5.8, -6.4, 4.6], 4.2, 4.5);
    return { hands: two ? [along(hand, dir, -2), hand] : [shieldHand, hand], weapon: { hand, dir, edge },
      // weight back on the windup, into the strike (with a shield up: tighter, or the head swings into its top edge)
      torso: { yaw: (two ? -0.12 : 0) - (two ? 0.5 : 0.3) * w + (two ? 0.35 : 0.15) * c, lean: -0.12 * w + (two ? 0.3 : 0.16) * c, dip: (two ? 1.2 : 0.7) * c },
      headYaw: 0.3 * w - 0.15 * c, feet: [[1.2 + 2.4 * c, 0], [-1.5, 0.4 * w]], shieldHand };
  }
  const walk = kind === 'walk' ? villagerWalkPose(t) : null, L = carryLife(kind, t);
  const hand = addP(two ? [7.6, -6.2, 0.4] : [5.8, -6.4, 4.6], L.d), dir = two ? [0.72, 0.68 + L.tilt, 0] : [0.45 + L.tilt, 0.88, 0.1];
  const hands = two ? [along(hand, dir, -2), hand] : [walk ? walk.hands[0] : shieldHand, hand];
  if (eq.shield) hands[0] = addP(shieldHand, [0, L.d[1] * 0.8, 0]);
  const it = villagerIdlePose(t).torso; // two-handed: the body turned a little toward the sword side, so the far arm reaches round the chest
  return { hands, weapon: { hand, dir }, torso: two ? { ...it, yaw: it.yaw - 0.12 } : it, headYaw: kind === 'idle' ? villagerIdlePose(t).headYaw * 0.5 : 0, feet: walk ? walk.feet : L.feet, bob: walk ? walk.bob : 0, shieldHand: hands[0] };
}
function spearmanPose(kind, t, eq){
  if (kind === 'attack') { // spear levelled, driven forward in a lunge and drawn back
    const th = t < 0.3 ? easeC(t / 0.3) * 0.25 : t < 0.5 ? 0.25 - 1.25 * easeC((t - 0.3) / 0.2) : -1 + easeC((t - 0.5) / 0.5);
    const d = -th * 6, dir = [1, 0.06, -0.24];                                               // + forward: a deep thrust
    const rear = [2 + d, -7.2, 5], front = [6.4 + d, -8.2, 3.6];            // the shaft held out past the hip, angled in toward the target
    const lunge = Math.max(0, -th);
    return { hands: [front, rear], weapon: { hand: rear, dir }, torso: { yaw: -0.5 + 0.2 * lunge - 0.15 * Math.max(0, th) * 4, lean: 0.08 + 0.5 * lunge, dip: 1.8 * lunge }, headYaw: 0.2, feet: [[2 + 3.2 * lunge, 0.6 * Math.max(0, Math.sin(Math.PI * lunge))], [-1.8 - 0.6 * lunge, 0]] };
  }
  const walk = kind === 'walk' ? villagerWalkPose(t) : null, L = carryLife(kind, t), hand = addP([5, -6.5, 3.6], L.d), dir = [0.3 + L.tilt, 0.95, 0]; // the spear tip sways with the step
  return { hands: [walk ? walk.hands[0] : [1, -2.4, -5.6], hand], weapon: { hand, dir }, torso: villagerIdlePose(t).torso, headYaw: kind === 'idle' ? villagerIdlePose(t).headYaw * 0.5 : 0, feet: walk ? walk.feet : L.feet, bob: walk ? walk.bob : 0 };
}
function archerPose(kind, t, eq){
  if (kind === 'attack') { // side-on: the bow arm out, nock, draw to the cheek, hold, loose (the string hand flicks back), recover
    // anchored at the outside of the cheek (the head's a sphere), and the bow straight out AHEAD of that anchor: the arrow
    // between them lies along the facing — the way the loosed one flies (bow off to the side, it pointed ~40° astray)
    const bowH = [9.6, -12, 3.6], nock = [5.8, -12.6, 3.9], cheek = [2.6, -12.2, 4.2], after = [0.4, -11.6, 6];
    const draw = t < 0.15 ? 0 : t < 0.55 ? easeC((t - 0.15) / 0.4) : t < 0.75 ? 1 : 0;
    const loose = t >= 0.75 ? Math.max(0, 1 - (t - 0.75) / 0.12) : 0;                    // the snap after the release
    // after the loose the string hand fetches the next arrow — over the shoulder from the Castle quiver, else from the hip — and nocks it
    const src = eq.quiver ? [-2.2, -16.8, 3.2] : [0.6, -2.8, 6.4];
    let hand = t < 0.75 ? lerpV(nock, cheek, draw) : t < 0.85 ? lerpV(after, cheek, loose) : t < 0.92 ? lerpV(after, src, easeC((t - 0.85) / 0.07)) : lerpV(src, nock, easeC((t - 0.92) / 0.08));
    bowH[1] -= 0.8 * Math.sin(Math.PI * Math.min(1, (t - 0.75) / 0.12)) * (t >= 0.75 && t < 0.87 ? 1 : 0); bowH[0] += 0.6 * loose * (t >= 0.75 ? 1 : 0); // the bow arm kicks
    // aimed up along the flight the arrow takes (ARROW_LAUNCH): the draw pitched about the shoulder, so the nocked
    // arrow points the way the loosed one flies
    const aimed = q => { const dx = q[0] - 2.2, u = -(q[1] + 13), c = Math.cos(ARROW_LAUNCH), sn = Math.sin(ARROW_LAUNCH);
      return [2.2 + dx * c - u * sn, -13 - (dx * sn + u * c), q[2]]; };
    const bh = aimed(bowH); hand = aimed(hand);
    bowH[0] = bh[0]; bowH[1] = bh[1];
    return { hands: [bowH, hand], bow: { grip: bowH, pull: hand, draw, arrow: t < 0.75, fetched: t >= 0.92 }, torso: { yaw: -0.75 - 0.1 * draw, lean: 0.05 - 0.08 * draw, dip: 0.3 + 0.3 * draw }, headYaw: 0.75 + 0.1 * draw, feet: [[1.8, 0], [-1.8, 0]] };
  }
  const walk = kind === 'walk' ? villagerWalkPose(t) : null, L = carryLife(kind, t), bowH = addP([3.2, -4.8, -5.8], L.d);
  return { hands: [bowH, walk ? walk.hands[1] : [1, -2.4, 5.6]], bow: { grip: bowH, pull: bowH, draw: 0, arrow: false }, torso: villagerIdlePose(t).torso, headYaw: kind === 'idle' ? villagerIdlePose(t).headYaw * 0.5 : 0, feet: walk ? walk.feet : L.feet, bob: walk ? walk.bob : 0 };
}
// Life at rest and on the march, shared: at rest the weight rolls from foot to
// foot and the weapon hand drifts; marching, the carried hands bounce with each
// step and swing a little with the stride.
function carryLife(kind, t){
  const s = Math.sin(2 * Math.PI * t), c = Math.cos(2 * Math.PI * t);
  if (kind === 'walk') return { d: [0.35 * s, -0.55 * Math.abs(c), 0], tilt: 0.06 * s };
  return { d: [0.25 * s, 0.3 * Math.sin(4 * Math.PI * t), 0.15 * c], tilt: 0.04 * c, feet: [[0.4 + 0.45 * s, 0], [-0.3 + 0.45 * s, 0.15 * Math.max(0, -s)]] };
}
const addP = (a, d) => a.map((v, i) => v + d[i]);
const SOLDIER_POSE = { militia: militiaPose, spearman: spearmanPose, archer: archerPose };
// The rider's sword arm, by action: at rest the blade up by the neck; the attack the 2D rider's overhead chop
// (swordArc), out on the sword side, clear of the horse's neck.
// A rider's leg (s: ±1 side), astride by `k`: 1 bowed out round the barrel to the stirrup; 0 hanging straight and
// together, as a thrown rider's legs drop by gravity. Art px: hip, the curve's control point, the foot, the boot.
function riderLeg(s, k){
  const L = (a, b) => a.map((v, i) => b[i] + (v - b[i]) * k);
  return { hip: [0, -3, s * 2], ctrl: L([3.6, 0.5, s * 9.2], [1.2, 0.4, s * 2.3]), foot: L([2, 5.6, s * 7.6], [0.6, 3.7, s * 2.2]), boot: L([2.8, 6, s * 7.6], [0.8, 3.9, s * 2.2]) };
}
function riderArm(kind, t){
  const rest = [[6.5, -7, 6], [0.5, 0.84, 0.2]];
  if (kind === 'die') return [[3.2, -6.5, 6.2], [-0.9, -0.25, 0.3]];   // limp: the sword trailing back from a slack hand
  if (kind !== 'attack') return rest;
  const p = swordArc(t, rest[0], 3.4, 0);                                // the 2D rider's overhead chop, from the saddle
  return [p.hand, [p.dir[0], p.dir[1], rest[1][2]], p.edge];
}
// A soldier's gear by its team's age and forge lines (soldierEquip's rules)
const soldierGear = e => soldierEquip(e.utype, ageBonus(e.team), e.utype === 'archer' ? archerAtkBonus(e.team) : upgradeAtkBonus(e.team), upgradeArmorBonus(e.team), hasUpgrade(e.team, 'fletching')); // (each its own attack line)
// What a soldier is doing ({ kind, t, legs, opt: { unit, eq } }) — both views' reading. The swing follows the HITS: one
// struck this reload cycle plays its cut (landing on the hit) — on the move too, the legs (or the horse) running on
// underneath; gated on range alone, a hit on the run showed no blow, and a chase flipping in and out of range restarted
// the swing over and over. stride: tiles walked, clk: the idle clock (authored ticks). Viewer-only.
const SOLDIER_STRIDE = { walk: 0.62, gallop: 1.3 };
function soldierAction(e, stride, clk){
  const ut = e.utype, opt = { unit: ut, eq: soldierGear(e) }, cav = ut === 'scout' || ut === 'knight';
  const rof = (UNITS[ut] && UNITS[ut].rof) || T30(60), cd = e.atkCooldown || 0;
  // (__animAttack: the gallery / lab preview swings on its own clock, no target)
  const swing = (e.__animAttack || e.target) && MIL_IMPACT[ut] != null && (e.__animAttack || cd > 0 || inActionRange(e)) ? ((1 - cd / rof + MIL_IMPACT[ut]) % 1 + 1) % 1 : null;
  if (isUnitMoving(e)) { const kind = cav ? 'gallop' : 'walk', lt = ((stride / SOLDIER_STRIDE[kind]) % 1 + 1) % 1;
    return swing != null && cd > 0 ? { kind: 'attack', t: swing, opt, legs: { kind, t: lt } } : { kind, t: lt, opt }; }
  if (swing != null) return { kind: 'attack', t: swing, opt };
  return { kind: 'idle', t: villagerWorkPhase(e, 'idle', clk), opt };
}
// Carrying: the load overhead, both hands under its edges either side of the head; LOAD_SIT: how far each load's middle
// sits above its bottom (art px, before its ×1.5 cartoon size), so it rests on the head.
const LOAD_SIT = { wood: 2.85, stone: 2.4, gold: 2.85, food: 2.85, wool: 3.4, berries: 1.8 };
const CARRY_HANDS = [[0.4, -17.1, -5.6], [0.4, -17.1, 5.6]];
// The female villager's dress [radius, art y] from the hem up (pov3d's DRESS_SHAPES.tunic)
const VIL_DRESS = [[0, -0.4], [4.2, -0.45], [4.95, -0.65], [5.3, -1.1], [5.1, -2.8], [4.8, -6], [4, -9.2], [2.3, -11.1], [1.4, -12], [0, -12.2]];
// A solid ellipsoid for line-of-sight tests in a projKit frame: centre c and its three half-axis vectors (kit coords).
// M maps a point's offset from c into the unit sphere's (inside: |M v| < 1).
function solidOf(c, a1, a2, a3){
  const det = a1[0] * (a2[1] * a3[2] - a2[2] * a3[1]) - a2[0] * (a1[1] * a3[2] - a1[2] * a3[1]) + a3[0] * (a1[1] * a2[2] - a1[2] * a2[1]);
  const cof = [[a2[1] * a3[2] - a2[2] * a3[1], a2[2] * a3[0] - a2[0] * a3[2], a2[0] * a3[1] - a2[1] * a3[0]],
               [a3[1] * a1[2] - a3[2] * a1[1], a3[2] * a1[0] - a3[0] * a1[2], a3[0] * a1[1] - a3[1] * a1[0]],
               [a1[1] * a2[2] - a1[2] * a2[1], a1[2] * a2[0] - a1[0] * a2[2], a1[0] * a2[1] - a1[1] * a2[0]]];
  return { c, cof, det, M: v => cof.map(r => (r[0] * v[0] + r[1] * v[1] + r[2] * v[2]) / det) };
}
// The face: where the head (a sphere, radius 4 art px at hc) shows in front of what caps it — his hair (pov3d's hair
// ellipsoid at head-frame (−0.6, −15.6), radii 3.9 × 3.2 × 4.1) or a helmet (cap: [x, y, z, rx, ry, rz], head-frame art;
// mH maps head-frame art to kit coords), seen along
// the projection's line of sight V. Returns the outline's points on the sphere's mid-plane (kit coords: project with P),
// or null when no face shows (from behind).
function headFaceOutline(hc, mH, V, cap = [-0.6, -15.6, 0, 3.9, 3.2, 4.1]){
  const [cx, cy, cz, rx, ry, rz] = cap, R = 4, ch = mH(cx, cy, cz), a = [mH(cx + rx, cy, cz), mH(cx, cy - ry, cz), mH(cx, cy, cz + rz)].map(q => q.map((v, i) => v - ch[i])), sol = solidOf(ch, ...a), Mv = sol.M;
  // the mid-plane through the head's centre, square to the line of sight: e1, e2
  const t0 = Math.abs(V[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  let e1 = cr(V, t0), l = Math.hypot(...e1); e1 = e1.map(v => v / l); const e2 = cr(V, e1);
  const mv = Mv(V), mvv = mv[0] * mv[0] + mv[1] * mv[1] + mv[2] * mv[2];
  // how far the face's surface stands in front of the hair's at (α, β) (< 0: covered, null: off the head)
  // (~470 calls a face, so written out without arrays: the same arithmetic, in the same order, as Mv(p))
  const [c0, c1, c2] = sol.cof, det = sol.det;
  const margin = (al, be) => { const r2 = al * al + be * be; if (r2 >= R * R) return null;
    const th = Math.sqrt(R * R - r2), p0 = hc[0] + al * e1[0] + be * e2[0] - ch[0], p1 = hc[1] + al * e1[1] + be * e2[1] - ch[1], p2 = hc[2] + al * e1[2] + be * e2[2] - ch[2];
    const m0 = (c0[0] * p0 + c0[1] * p1 + c0[2] * p2) / det, m1 = (c1[0] * p0 + c1[1] * p1 + c1[2] * p2) / det, m2 = (c2[0] * p0 + c2[1] * p1 + c2[2] * p2) / det;
    const b = 2 * (m0 * mv[0] + m1 * mv[1] + m2 * mv[2]), c = m0 * m0 + m1 * m1 + m2 * m2 - 1, D = b * b - 4 * mvv * c;
    return D < 0 ? th + 9 : th - (-b + Math.sqrt(D)) / (2 * mvv); };
  let best = null, bm = 0.05;
  for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) { const m = margin(i * 0.85, j * 0.85); if (m != null && m > bm) { bm = m; best = [i * 0.85, j * 0.85]; } }
  if (!best) return null;
  const out = [];
  for (let k = 0; k < 28; k++) { const an = k / 28 * 2 * Math.PI, dx = Math.cos(an), dy = Math.sin(an); let lo = 0, hi = 2 * R;
    for (let it = 0; it < 14; it++) { const mid = (lo + hi) / 2, m = margin(best[0] + dx * mid, best[1] + dy * mid); if (m != null && m > 0) lo = mid; else hi = mid; }
    const al = best[0] + dx * lo, be = best[1] + dy * lo; out.push([0, 1, 2].map(i => hc[i] + al * e1[i] + be * e2[i])); }
  return out;
}
const vil2DState = new Map();
// The actions the 2D rig draws (pov3d's animFrame poses), and the tool each holds; the rest keep the old art for now.
const VIL2D_POSE = { idle: villagerIdlePose, walk: villagerWalkPose, chop: chopPose, split: splitPose, mine: minePose, build: buildPose,
  farm: mowPose, forage: foragePose, butcher: butcherPose, fight: fightPose, repair: repairPose,
  carry: t => ({ ...villagerWalkPose(t), hands: CARRY_HANDS }),
  flee: runPose, saw: sawPose,
  barrow: t => ({ ...villagerWalkPose(t), hands: BARROW_GRIPS }), plow: t => ({ ...villagerWalkPose(t), hands: BARROW_GRIPS, torso: { lean: 0.14 } }) };
// Pushing the wheelbarrow / the Heavy Plow (pov3d's barrowRig): both fists on the grips out in front of the belly
const BARROW_GRIPS = [[6.5, -6.5, -3.9], [6.5, -6.5, 3.9]];
const VIL2D_TOOL = { chop: 'axe', split: 'axe', mine: 'pick', build: 'mallet', farm: 'scythe', repair: 'mallet', butcher: 'knife', fight: 'knife' };
const VIL_SHOULDER = [2.4, -9.2, 5.3], VIL_TOOL_COL = { handle: '#8B4513', steel: '#b8bfc6', bright: '#f2f6fb', wood: '#b08850' };
// pov3d's tube: one smooth quadratic from a to c through the joint (its control ctl = 2·joint − (a+c)/2), sampled
const quadPts = (a, ctl, c, n = 6) => Array.from({ length: n + 1 }, (_, i) => { const u = i / n, k0 = (1 - u) * (1 - u), k1 = 2 * u * (1 - u), k2 = u * u;
  return a.map((v, j) => k0 * v + k1 * ctl[j] + k2 * c[j]); });
// a person's draw layers (drawPerson2D's DRAW ORDER; FAR_SIDE: beyond a horse's far flank, painted before the horse),
// and its pose cache: the parts built for a pose key
const FAR_SIDE = -40, BACK_TOOL = -30, FAR_ARM = -20, LEGS = -10, BODY = 0, NEAR_ARM = 50, HEAD = 100, HAIR_FRONT = 150, RAISED_ARM = 200, FRONT_TOOL = 210;
const PERSON_STEPS = 24, personCache = new Map();
// New poses a game frame may build (render() sets it, then lifts it): a battle's opening shows thousands of never-seen
// poses at once (~0.3 ms each) — past the budget a unit keeps last frame's pose and catches up a frame or two later.
// Unlimited outside render() (gallery, labs, the 3D view's billboards).
let poseBuildBudget = Infinity;
// The point a villager works on (pov3d's workTarget, in sim coords — a tile's centre at its integer): a resource
// tile's centre, the nearest point along a felled trunk, a carcass, the nearest point of a building's footprint
function villagerWorkTarget(e, kind){
  if ((kind === 'chop' || kind === 'saw' || kind === 'mine' || kind === 'forage') && e.gatherX >= 0) return [e.gatherX, e.gatherY];
  if (kind === 'split' && e.gatherX >= 0) { // along the fallen trunk (it falls toward +x −y: screen right)
    const L = TREE_TRUNK_H * 0.7, dx = Math.SQRT1_2, dy = -Math.SQRT1_2, u = Math.max(0.15, Math.min(1, ((e.x - e.gatherX) * dx + (e.y - e.gatherY) * dy) / L));
    return [e.gatherX + dx * L * u, e.gatherY + dy * L * u]; }
  const foot = b => [Math.max(b.x - 0.5, Math.min(b.x + (b.w || 1) - 0.5, e.x)), Math.max(b.y - 0.5, Math.min(b.y + (b.h || 1) - 0.5, e.y))];
  if (kind === 'butcher') { const t = entitiesById.get(e.target); if (t) return t.type === 'building' ? foot(t) : [t.x, t.y]; }
  if ((kind === 'build' || kind === 'repair') && e.buildTarget) { const b = entitiesById.get(e.buildTarget); if (b) return foot(b); }
  return null;
}
// Where a villager is drawn (pov3d's, the shared reach): at work, turned to its target and stepped in so the tool meets
// it — as far as the sim lets it stand off, ≤ 1.6 tiles from its sim spot; off its spot, it walks there (legs and
// all, at WALK_IN), else it rides its sim spot. Viewer-only state on S. Returns { act, hd } or null (its own dir).
const WALK_IN = 0.9;   // tiles per game-second a villager steps to its work spot at (a walk)
function villagerWorkSpot(e, act, S){
  const now = performance.now(), dt = S.wt ? Math.min(0.1, (now - S.wt) / 1000) : 0; if (!window._maskDraw) S.wt = now;
  const W = villagerWorkReach()[act.kind], T = W && villagerWorkTarget(e, act.kind), mv = isDrawnMoving(e);
  let tx = e.x, ty = e.y, hd = null;
  const prx = S.prx ?? e.x, pry = S.pry ?? e.y; if (!window._maskDraw) { S.prx = e.x; S.pry = e.y; } // (its true spot last frame)
  if (T) { const ph = Math.atan2(T[1] - e.y, T[0] - e.x), c = Math.cos(ph), sn = Math.sin(ph), px = T[0] - (W[0] * c - W[1] * sn), py = T[1] - (W[0] * sn + W[1] * c);
    if ((px - e.x) ** 2 + (py - e.y) ** 2 < 1.6 * 1.6) { tx = px; ty = py; }
    if (!mv || !e.path.length) hd = ph; } // (a step into its place, path-less — a press — is a sidestep: it keeps facing its work)
  if (S.wx == null || (S.wx - tx) ** 2 + (S.wy - ty) ** 2 > 4) { S.wx = tx; S.wy = ty; return hd == null ? null : { act, hd }; }
  if (mv && !T) { // leaving a work spot on the move: the step-in offset walks off (game-speed scaled), never pops — the
    // offset from where it stood last frame, so its own walk isn't counted as offset (else it lagged and snapped)
    const ox = S.wx - prx, oy = S.wy - pry, od = Math.hypot(ox, oy), k = od > 0.01 ? Math.max(0, od - WALK_IN * GAME_SPEED * dt) / od : 0;
    if (!window._maskDraw) { S.wx = tx + ox * k; S.wy = ty + oy * k; } return hd == null ? null : { act, hd }; }
  if (window._maskDraw) return hd == null ? null : { act, hd };
  const dx = tx - S.wx, dy = ty - S.wy, d = Math.hypot(dx, dy);
  if (!mv && d > 0.03) { // walking into its work spot (or back out of it): a walk, a load in hand stays in hand
    const step = Math.min(d, WALK_IN * GAME_SPEED * dt), wk = act.opt && act.opt.load ? 'carry' : 'walk';
    S.wx += dx / d * step; S.wy += dy / d * step; S.inStride = (S.inStride || 0) + step;
    return { act: { kind: wk, t: ((S.inStride / WALK_TILES[wk]) % 1 + 1) % 1, opt: act.opt }, hd: Math.atan2(dy, dx) }; }
  const f = Math.min(1, dt * 10); S.wx += dx * f; S.wy += dy * f;
  return hd == null ? null : { act, hd };
}
function drawPerson2D(e){
  let S = vil2DState.get(e.id); if (!S) vil2DState.set(e.id, S = { px: e.x, py: e.y, stride: 0 });
  if (!window._maskDraw) S.stride += Math.hypot(...walkedSince(S, e));
  // a corpse (drawCorpse sets __deathAge): the staged death, the whole body going over backward about a pivot behind the
  // heels (fall, as the 3D's)
  // a soldier (soldierAction, SOLDIER_POSE) or a villager (villagerAction, VIL2D_POSE): one body, its gear by unit
  const soldier = e.utype !== 'villager', eq = soldier ? soldierGear(e) : null, dying = e.__deathAge != null;
  let act = dying ? { kind: 'die', t: 0, opt: {} } : soldier ? soldierAction(e, S.stride, animTick) : villagerAction(e, S.stride, animTick);
  // a villager at work (pov3d's): turned to what it works on and stepped in so its tool meets it (villagerWorkReach) —
  // walking there, and back out after, rather than popping; drawn there (S.wx/S.wy, its drawn spot), facing it
  let hd = (e.dir || 0) * Math.PI / 4;
  if (!soldier && !dying) { const spot = villagerWorkSpot(e, act, S); if (spot) { act = spot.act; hd = spot.hd; } }
  // (phases snap to PERSON_STEPS a cycle: each pose is built once and cached — the 3D's pose cache, in 2D)
  if (!dying) { act.t = (Math.round(act.t * PERSON_STEPS) % PERSON_STEPS) / PERSON_STEPS; if (act.legs) act.legs.t = (Math.round(act.legs.t * PERSON_STEPS) % PERSON_STEPS) / PERSON_STEPS; }
  // a rider sits on the horse rig (horse2D): his seat 14 px up (pov3d's riderFig), riding the gait's rise
  const horse = soldier && isMountedUnit(e.utype) && !dying ? horse2D(e, teamColor(e.team)) : null;
  // a dead rider: his horse goes down (horseDeath2D) and he's thrown clear — off its falling side in an arc, landing on
  // his back (pov3d's cavalryFrame: from the saddle, 0.25 tile on and 0.72 tile across)
  const still = dying && e.__deathAge >= DEATH_STILL ? _stillCorpse.get(e) : null;
  const fallen = dying && isMountedUnit(e.utype) ? (still ? still.fallen : horseDeath2D(e, e.__deathAge, teamColor(e.team))) : null;
  const thrown = fallen ? Math.max(0, Math.min(1, (e.__deathAge - 150) / 650)) : 0;
  const hq = Math.round(hd / (2 * Math.PI) * 64);   // (the heading in 64 steps: the cache key)
  const key = dying ? null : [e.utype, e.female ? 1 : 0, teamColor(e.team), hq, act.kind, act.t, act.legs ? act.legs.t : '',
    JSON.stringify(act.opt), horse ? [Math.round(horse.gait.bob * 40), Math.round((horse.gait.nod || 0) * 100), isUnitMoving(e) ? 1 : 0, horse.frontHead ? 1 : 0].join(',') : ''].join('|');
  let parts = still ? still.parts : key && personCache.get(key);
  // (least-recently-used out, one at a time: clearing it whole when full rebuilt every pose on screen at once — a
  // battle's opening seconds filled it twice)
  if (parts && key) { personCache.delete(key); personCache.set(key, parts); }
  if (!parts && poseBuildBudget <= 0 && S.parts && !dying) parts = S.parts;   // (the outline pass too: it must match the sprite)
  if (!parts) { poseBuildBudget--; parts = buildPerson(); if (key) { if (personCache.size >= 4000) personCache.delete(personCache.keys().next().value); personCache.set(key, parts); }
    else if (dying && e.__deathAge >= DEATH_STILL) _stillCorpse.set(e, { parts, fallen }); }
  if (!dying) S.parts = parts;
  function buildPerson(){
  const pose = fallen ? () => riderPose('die', thrown, eq) : dying ? () => villagerDeathPose(e.__deathAge) : horse ? () => riderPose(act.kind, act.t, eq, horse.gait) : soldier ? () => soldierPose2D(e.utype, act, eq) : VIL2D_POSE[act.kind];
  const o = pose(act.t), tool = !soldier && (VIL2D_TOOL[act.kind] || (act.kind === 'walk' && act.opt.tool)), up = act.opt.up || {};
  if (act.kind === 'walk' && tool) o.hands = [o.hands[0], VIL_SHOULDER];              // a work tool on the shoulder, the other arm swinging
  const C = HUMAN_COL, dress = !soldier && !!e.female, tc = teamColor(e.team), bob = o.bob || 0, TAU = Math.PI * 2;
  const { P, depth, faces, view, parts, add, blob, tube } = projKit(hq * Math.PI / 32);
  const fall = o.fall || 0, cf = Math.cos(fall), sf = Math.sin(fall);
  const rX = horse ? -0.8 : fallen ? -0.8 + 0.25 * HORSE_TILE * thrown : 0, rZ = fallen ? -0.72 * HORSE_TILE * thrown : 0;
  const rU = horse ? 14 + horse.gait.bob * (isUnitMoving(e) ? 0.55 : 0.85) * 1.35 : fallen ? 14 * (1 - thrown) + 0.18 * HORSE_TILE * Math.sin(Math.PI * thrown) : 0;
  // a thrown rider keeps his seat and rolls over sideways, about his seat, onto the −z side he lands on (pov3d's rotation.x = −lie)
  let lie = fallen ? (Math.PI / 2) * thrown ** 1.3 : 0; if (fallen && e.__deathAge > 800 && e.__deathAge < 1050) lie *= 1 - 0.06 * Math.sin((e.__deathAge - 800) / 250 * Math.PI);
  const cLie = Math.cos(lie), sLie = Math.sin(lie);
  const K = q => { const dx = q[0] + 2.4, u = 5 - q[1] + bob, x = -2.4 + dx * cf - u * sf, y = dx * sf + u * cf;   // art (y down) → the kit's (up), fallen
    return [x + rX, y * cLie + q[2] * sLie + rU, q[2] * cLie - y * sLie + rZ]; };
  // the torso turns at the hips [0, −3]: lean tips it forward, yaw turns it, dip sinks it; the head turns at the neck
  const tor = o.torso || {}, ty = tor.yaw || 0, tl = -(tor.lean || 0), dip = tor.dip || 0, hy = o.headYaw || 0;
  const U = q => { const dx = q[0], du = -(q[1] + 3), dz = q[2], x1 = dx * Math.cos(tl) - du * Math.sin(tl), u1 = dx * Math.sin(tl) + du * Math.cos(tl);
    return [x1 * Math.cos(ty) + dz * Math.sin(ty), -3 - u1 + dip, -x1 * Math.sin(ty) + dz * Math.cos(ty)]; };
  const Uinv = q => { const x2 = q[0], z2 = q[2], u1 = -(q[1] - dip + 3), x1 = x2 * Math.cos(ty) - z2 * Math.sin(ty), dz = x2 * Math.sin(ty) + z2 * Math.cos(ty);
    return [x1 * Math.cos(tl) + u1 * Math.sin(tl), -3 - (-x1 * Math.sin(tl) + u1 * Math.cos(tl)), dz]; };
  const Hd = q => { const dx = q[0], dz = q[2]; return U([dx * Math.cos(hy) + dz * Math.sin(hy), q[1], -dx * Math.sin(hy) + dz * Math.cos(hy)]); };
  const mU = (x, y, z) => K(U([x, y, z])), mH = (x, y, z) => K(Hd([x, y, z])), mG = (x, y, z) => K([x, y, z]);
  // DRAW ORDER, fixed layers (as the 2D art): a tool held behind, the far arms, the legs, the body, the near arms (under
  // the head: the shoulders tuck in below the chin and her hair), the head (hair, face, eyes), arms raised in front,
  // a tool held in front (the fists over its handle). Each arm splits at the elbow: the upper arm goes by its shoulder's
  // side; the forearm comes over the head when raised above the shoulders in front, and a far arm gripping a tool held
  // in front brings its forearm round to it; a hand swung back behind the body goes behind it. A tool is in front when
  // its head, or the fists on it, are nearer than the body's middle.
  const bodyD = (q => depth(q[0], q[2]))(mU(0, -6, 0)), nearer = q => depth(q[0], q[2]) > bodyD;
  const grips = ({ chop: [0, 1], split: [0, 1], mine: [0, 1], build: [0, 1], farm: [0, 1], repair: [1], butcher: [1], fight: [1], walk: [1] }[act.kind] || []).slice();
  let toolFront = false, toolHead = null, bodyOutline = null;
  // a screen point inside the body's outline (the hand behind it is hidden there)
  const overBody = q => { const [x, y] = q; let inside = false;
    for (let i = 0, j = bodyOutline.length - 1; i < bodyOutline.length; j = i++) { const [xi, yi] = bodyOutline[i], [xj, yj] = bodyOutline[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
  // torso / dress

  if (dress) { const rings = []; for (let i = 0; i + 1 < VIL_DRESS.length; i++) { const [r0, y0] = VIL_DRESS[i], [r1, y1] = VIL_DRESS[i + 1], n = Math.max(1, Math.ceil(Math.abs(y1 - y0) / 0.5));
      for (let j = 0; j < n; j++) { const u = j / n; rings.push([r0 + (r1 - r0) * u, y0 + (y1 - y0) * u]); } }
    // (a lathe seen from above at an angle: its outline is the hull of its rings — the profile narrows from the hem up —
    // one crisp polygon, not a pile of overlapping ellipses whose soft edges stack up)
    const pts = []; for (const [r, y] of rings) for (let k = 0; k < 24; k++) { const th = k / 24 * TAU; pts.push(P(...mU(r * Math.cos(th), y, r * Math.sin(th)))); }
    const hl = loadHull(pts); bodyOutline = hl; add(tc, BODY, () => { X.moveTo(...hl[0]); for (const q of hl.slice(1)) X.lineTo(...q); X.closePath(); }, 'body');
  } else { const t = blob(tc, mU, 0, -6, 0, 4.6, 5, 4.2, 'body'); t.pt.d = BODY;
    // armor over the tunic (pov3d's armorMat, the 2D read): SCALE — forge-steel scallop rows over the lower torso, the
    // chest left team colour; CHAIN — steel over the whole torso, finer rows, a faint team wash
    if (soldier && eq.torso) { const tp = t.pt.path, chain = eq.torso === 'chain', top = t.c[1] - t.r2 + (chain ? 0 : t.r2 * 0.95), M = eq.metal;
      let rows = null;   // (the rows of scales as one path, built once: the pose is cached)
      add(M, BODY + 0.0001, () => { X.save(); X.beginPath(); tp(); X.clip(); X.fillStyle = M; X.fillRect(t.c[0] - 12, top, 24, 30);
        if (chain) { X.globalAlpha = 0.18; X.fillStyle = tc; X.fillRect(t.c[0] - 12, top, 24, 30); X.globalAlpha = 1; }
        X.strokeStyle = 'rgba(0,0,0,0.28)'; X.lineWidth = 0.6 / UNIT_SCALE; const r = chain ? 0.9 : 1.4;
        if (!rows) { rows = new Path2D(); for (let y = top + r, i = 0; y < t.c[1] + t.r2 + 2; y += r * 1.3, i++) for (let x = t.c[0] - 12 + (i % 2) * r; x < t.c[0] + 12; x += r * 2) { rows.moveTo(x + r, y); rows.arc(x, y, r, 0, Math.PI); } }
        X.stroke(rows); X.restore(); X.beginPath(); }, 'body', false); }
    bodyOutline = Array.from({ length: 24 }, (_, i) => { const a = i / 24 * TAU, x = t.r1 * Math.cos(a), y = t.r2 * Math.sin(a); return [t.c[0] + x * Math.cos(t.rot) - y * Math.sin(t.rot), t.c[1] + x * Math.sin(t.rot) + y * Math.cos(t.rot)]; }); }
  // a rider's legs astride: the thigh curving out round the barrel, the shin down the flank to the stirrup (pov3d's
  // human() riding); the far one goes behind the horse
  if (o.riding) for (const s of [-1, 1]) { const lg = riderLeg(s, o.riding), far = depth(...(q => [q[0], q[2]])(mG(...lg.foot))) < bodyD, g = far ? 'farleg' : 'legs';
    tube(C.leg, quadPts(lg.hip, lg.ctrl, lg.foot).map(K), 1.15, g).d = LEGS;
    blob(C.boot, mG, ...lg.boot, 1.8, 1, 1.3, g).pt.d = LEGS + 0.005; }
  // legs (behind the tunic: only what shows below it), knee forward, a boot
  if (!o.riding) for (const s of [-1, 1]) { const [fx, lift] = (o.feet && o.feet[s > 0 ? 1 : 0]) || [0, 0], z = s * (dress ? 1.9 : 2.2), hipY = (dress ? -2 : -3) + dip;
    const foot = [fx + 0.5, 3.7 - lift, z], hip = [0, hipY, z], seg = (3.7 - (dress ? -2 : -3)) / 2 * 1.02;
    const dx = foot[0] - hip[0], dy = foot[1] - hip[1], d = Math.hypot(dx, dy) || 1e-6, h = Math.sqrt(Math.max(0, seg * seg - d * d / 4));
    const kn = [(hip[0] + foot[0]) / 2 + dy / d * h, (hip[1] + foot[1]) / 2 - dx / d * h, z];
    tube(C.leg, quadPts(hip, kn.map((v, i) => 2 * v - (hip[i] + foot[i]) / 2), foot).map(K), dress ? 0.85 : 0.95, 'legs').d = LEGS + 0.01 * depth(foot[0], z);
    blob(C.boot, mG, fx + 0.6, 3.9 - lift, z, dress ? 1.3 : 1.5, 0.9, dress ? 1 : 1.2, 'legs').pt.d = LEGS + 0.005 + 0.01 * depth(foot[0], z); }
  // head; the hair over it; the face — a patch of the head on its front, clipped to the head — over the hair where the
  // front faces us (so hair frames a face head-on, shows behind it in profile, and covers the head from behind); eyes
  const head = blob(C.skin, mH, 0, -14, 0, 4, 4, 4, 'head'); head.pt.d = HEAD;
  const hc = head.o, H0 = HEAD, fw = mH(4, -14, 0), front = faces([fw[0] - hc[0], fw[1] - hc[1], fw[2] - hc[2]]);
  if (soldier && eq.helmet === 'great') {
    // the knight's great helm (pov3d's): a flat-topped steel pail over the whole head, a T of cuts to see and breathe,
    // eyes peering out, a team plume on top
    const rings = []; for (const y of [-19, -10.2]) for (let k = 0; k < 24; k++) { const a = k / 24 * TAU, r = y < -15 ? 4.3 : 4.5; rings.push(P(...mH(r * Math.cos(a), y, r * Math.sin(a)))); }
    const hl = loadHull(rings); add('#c6cdd8', H0 + 0.1, () => { X.moveTo(...hl[0]); for (const q of hl.slice(1)) X.lineTo(...q); X.closePath(); }, 'head');
    const topRing = Array.from({ length: 24 }, (_, k) => { const a = k / 24 * TAU; return P(...mH(4.3 * Math.cos(a), -19, 4.3 * Math.sin(a))); });
    if (faces([0, 1, 0]) > 0) add('#d6dce5', H0 + 0.11, () => { X.moveTo(...topRing[0]); for (const q of topRing.slice(1)) X.lineTo(...q); X.closePath(); }, 'head', false); // the flat top
    if (front > 0.15) { const slit = (z0, z1, y0, y1) => { const ps = [[z0, y0], [z1, y0], [z1, y1], [z0, y1]].map(([z, y]) => P(...mH(4.4, y, z))); add('#1c1c1c', H0 + 0.2, () => { X.moveTo(...ps[0]); for (const q of ps.slice(1)) X.lineTo(...q); X.closePath(); }, 'head', false); };
      slit(-3.2, 3.2, -14.6, -16); slit(-0.55, 0.55, -11.5, -15);                                                         // the eye slit and the breathing slit
      for (const z of [-1.5, 1.5]) blob('#ffffff', mH, 4.55, -15.3, z, 0.5, 0.45, 0.6, 'head', 0, false).pt.d = H0 + 0.21; }   // eyes peering out
    blob(tc, mH, 0, -20.5, 0, 1.8, 2.6, 1.2, 'head').pt.d = H0 + 0.3;                                                     // the team plume
  } else if (soldier) {
    // the helmet (pov3d's human() hats: hood, kettle, Norman, spiked) over the head, the face traced in front of it
    const hm = SOLDIER_HELM[eq.helmet] || SOLDIER_HELM.hood, hcol = eq.helmet === 'hood' ? tc : hm[6];
    blob(hcol, mH, ...hm.slice(0, 6), 'head').pt.d = H0 + 0.1;
    const face = headFaceOutline(hc, mH, view, hm);
    if (face) { const hp = head.pt.path, fp = face.map(q => P(...q));
      add(C.skin, H0 + 0.2, () => { X.save(); X.beginPath(); hp(); X.clip(); X.beginPath(); X.moveTo(...fp[0]); for (const q of fp.slice(1)) X.lineTo(...q); X.closePath(); X.fill(); X.restore(); X.beginPath(); }, 'head', false); }
    // a ring round the helmet at height y, radius r: its points, and which face us (the near arc)
    const ringPts = (cx, y, r) => Array.from({ length: 33 }, (_, i) => { const a = i / 32 * TAU, q = mH(cx + r * Math.cos(a), y, r * Math.sin(a)), c = mH(cx, y, 0);
      return { q, near: depth(q[0], q[2]) > depth(c[0], c[2]) }; });
    if (eq.helmet === 'kettle') {  // the wide brim; the dome rises out of it — over its far half, under its near half
      const br = blob(hm[6], mH, 0, -15.2, 0, 5.6, 0.7, 5.6, 'head'); br.pt.d = H0 + 0.4; br.pt.line = true;
      const ring = ringPts(0, -15.2, 5.6).filter(o => o.near).map(o => P(...o.q)), dome = blob(hm[6], mH, ...hm.slice(0, 6), 'head'), dp = dome.pt.path;
      dome.pt.d = H0 + 0.45; dome.pt.line = true; dome.pt.outline = false;
      dome.pt.path = () => { X.save(); X.beginPath(); X.rect(-200, -200, 400, 400); X.moveTo(...ring[0]); for (const q of ring.slice(1)) X.lineTo(...q); X.closePath(); X.clip('evenodd'); X.beginPath(); dp(); X.fill(); X.stroke(); X.restore(); X.beginPath(); }; }
    if (eq.helmet === 'norman') {  // the gold band: a thin rim round the helm, the arc that faces us
      const arc = ringPts(-0.3, -15.2, 4.55), runs = []; let cur = [];
      for (const o of arc) { if (o.near) cur.push(o.q); else if (cur.length) { runs.push(cur); cur = []; } } if (cur.length) runs.push(cur);
      for (const r of runs) if (r.length > 1) tube('#daa520', r, 0.5, 'head').d = H0 + 0.4;
      if (front > 0) tube(hm[6], [mH(4.2, -16, 0), mH(4.3, -12.5, 0)], 0.7, 'head').d = H0 + 0.5; }           // the nasal, down the face
    if (eq.helmet === 'spiked') tube(hm[6], [mH(-0.3, -18.9, 0), mH(-0.3, -22.3, 0)], [0.9, 0.1], 'head').d = H0 + 0.4;
    if (eq.feather) tube(teamColorLight(e.team), quadPts([-1.2, -18.2, 0], [-1.6, -22, 0], [-3.2, -25.4, 0], 5).map(q => mH(...q)), [0.7, 1.1, 1.3, 1.1, 0.7, 0.2], 'head').d = H0 + 0.35; // Fletching's plume
  } else if (dress) {
    // straight long hair (as the 3D): a cap over the crown to a flat fringe at the brow, and a curtain falling straight
    // from it to the shoulders all round, open at the front — the face shows through the opening
    const R = 4.35, yTop = -14 - R * Math.cos(1.2), yBot = -9.4, rTop = R * Math.sin(1.2), rBot = 4.4, GAP = 0.95;
    const ring = (y, r, th) => mH(-0.2 + r * Math.sin(th), y, r * Math.cos(th));
    // the convex hull of screen points (the cap's outline)
    const hullOf = ps => { ps = ps.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]); const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]), lo = [], up = [];
      for (const p of ps) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (const p of ps.slice().reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
      return lo.slice(0, -1).concat(up.slice(0, -1)); };
    const poly = ps => () => { X.moveTo(...ps[0]); for (const p of ps.slice(1)) X.lineTo(...p); X.closePath(); };
    const Hf = HAIR_FRONT;                                                              // over the head (the back strips: behind the body)
    // the curtain, in strips round its open front: the ones facing us go over the head (the
    // face), the ones facing away (its inside seen through the opening) behind it — split where it turns edge-on
    const N = 40, ths = Array.from({ length: N + 1 }, (_, i) => Math.PI / 2 + GAP + i / N * (TAU - 2 * GAP));
    const facing = th => { const q = ring(-12, 4.3, th), c = mH(-0.2, -12, 0); return faces([q[0] - c[0], q[1] - c[1], q[2] - c[2]]) > 0; };
    let run = [ths[0]];
    const flush = () => { if (run.length < 2) return; const ps = run.map(th => P(...ring(yTop, rTop, th))).concat(run.slice().reverse().map(th => P(...ring(yBot, rBot, th))));
      const front = facing(run[run.length >> 1]), mid = ring((yTop + yBot) / 2, 4.2, run[run.length >> 1]);
      add(C.hair, front ? Hf : -50, poly(ps), 'head'); };
    for (let i = 1; i <= N; i++) { if (facing(ths[i]) !== facing(ths[i - 1])) { flush(); run = [ths[i - 1]]; } run.push(ths[i]); }
    flush();
    // the cap: the crown of a sphere down to the flat fringe at the brow (all round), over the curtain
    const capPts = []; for (let la = 0; la <= 1.2001; la += 0.2) for (let k = 0; k < 24; k++) { const th = k / 24 * TAU;
      capPts.push(P(...mH(-0.2 + R * Math.sin(la) * Math.sin(th), -14 - R * Math.cos(la), R * Math.sin(la) * Math.cos(th)))); }
    const ch = hullOf(capPts), cap = add(C.hair, Hf + 0.1, poly(ch), 'head');
    // (no line: the crown flows into the curtain)
  } else {
    blob(C.hair, mH, -0.6, -15.6, 0, 3.9, 3.2, 4.1, 'head').pt.d = H0 + 0.1;
    // the face over it: the part of the head sphere in FRONT of the hair ellipsoid along the line of sight (the 3D's
    // hairline is where the two surfaces cross) — found by tracing, an outline marched out from the face's middle
    const face = headFaceOutline(hc, mH, view);
    if (face) { const hp = head.pt.path, fp = face.map(q => P(...q));
      add(C.skin, H0 + 0.2, () => { X.save(); X.beginPath(); hp(); X.clip(); X.beginPath(); X.moveTo(...fp[0]); for (const q of fp.slice(1)) X.lineTo(...q); X.closePath(); X.fill(); X.restore(); X.beginPath(); }, 'head', false); }
  }
  if (!(soldier && eq.helmet === 'great')) for (const zz of [-1, 1]) { const m = mH(3.75, -14.45, zz * 1.31); if (faces([m[0] - hc[0], m[1] - hc[1], m[2] - hc[2]]) > 0.15) blob('#141414', (x, y, z) => [x, y, z], ...m, 0.68, 0.68, 0.68, 'head', 0, false).pt.d = H0 + 0.3; }   // (the 3D's eye reads a size up at its camera)
  let toolK = null;
  if (tool) { const T = TOOLS2D[tool], wk = act.kind === 'walk';
    const dir = wk ? [-0.62, 0.76, 0.14] : tool === 'knife' ? o.kdir : o.dir, grip = wk ? VIL_SHOULDER : tool === 'knife' ? o.knife : o.grip;
    const dl = Math.hypot(...dir), Y = [dir[0] / dl, -dir[1] / dl, dir[2] / dl];      // along the handle, art (y down)
    const ed = wk ? [0, 0.3, 1] : o.edge || [Y[2], 0, -Y[0]], e0 = [ed[0], -ed[1], ed[2]], ey = e0[0] * Y[0] + e0[1] * Y[1] + e0[2] * Y[2];
    let Xs = e0.map((v, i) => v - ey * Y[i]); const xl = Math.hypot(...Xs) || 1; Xs = Xs.map(v => v / xl);
    const base = grip.map((v, i) => v + Y[i] * (tool === 'knife' ? 0 : wk ? 4.4 : GRIP_OUT));
    const at = (u, v) => mG(...base.map((b, i) => b + Y[i] * u + Xs[i] * v));         // u along the handle, v to the blade side
    toolFront = nearer(at(T.top, 0)) || nearer(mG(...grip));                       // (its head, or the fists on it, out in front)
    toolHead = { q: at(T.top, 0), r: T.headR };
    toolK = { at, tube, add, P, up, quadPts, mow: act.kind === 'farm' }; }
  // the wheelbarrow / plow rig ahead of him (pov3d's barrowRig, in rig px: x forward from the grips' foot, h up, z
  // across; ×1.25, carried at half the step's bob): drawn in front of him, or behind facing away — the fists on its grips
  let rigK = null;
  if (act.kind === 'barrow' || act.kind === 'plow') {
    const R = (x, h, z) => mG(4.7 + x * 1.25, 5 - h * 1.25 + bob * 0.5, z * 1.25);
    toolFront = nearer(R(12, 5, 0)); rigK = { R }; }
  if (rigK) grips.push(0, 1);
  // the bow saw (pov3d's bowSaw, laid on its side against the trunk, the frame tipped back toward him, stroked along its
  // blade): a point (x along it, u up its frame) → his frame; both fists on the bow
  let sawK = null;
  // (pov3d's transforms in order: tipped back SAW_TIP about the blade line, turned across his front; y: the saw's own art y)
  if (act.kind === 'saw') { const ct = Math.cos(SAW_TIP), st = Math.sin(SAW_TIP), off = o.off;
    const Sw = (x, y) => { const v = SAW_Y - y; return mG(SAW_X - v * st, SAW_Y - v * ct, SAW_Z - off - x); };
    toolFront = nearer(Sw(11.5, -8)); sawK = Sw; grips.push(0, 1); }
  // a soldier's weapon (pov3d's sword / spearAt / drawnBow): placed before the arms (the fists grip it), drawn after
  let wK = null;
  let wL = null;
  // dying: the weapon (and shield) drop beside the body
  if (soldier && dying) soldierDrops2D(e, eq, e.__deathAge, { tube, add, blob, P, faces, tc, nearer });
  if (soldier && !dying) { wK = soldierWeapon2D(e.utype, o, eq, mG);
    toolFront = nearer(wK.tip) || nearer(mG(...wK.hand)); grips.push(...wK.grips);
    // a rider's sword in a fist out past the horse's far flank — by its side, not how far forward it reaches: behind the whole horse
    const hdD = (q => depth(q[0], q[2]))(mH(0, -14, 0)), tq = wK.tip;
    if (horse && (q => depth(0, q[2]))(mG(...wK.hand)) < -3) wL = FAR_SIDE;
    // a blade raised behind his head (the windup, seen from the front): under the head, over the body
    else if (toolFront && depth(tq[0], tq[2]) < hdD && P(...tq)[1] < P(...mH(0, -10, 0))[1]) wL = NEAR_ARM + 2; }
  // the shield, strapped on the left forearm: in front of the body or behind it by its own depth; its face toward us,
  // it covers that forearm and fist — its back toward us, the arm is in front of it
  let shieldL = null, shieldFace = false;
  const shield = soldier && !dying && eq.shield ? shieldOf(o, eq.shield, !!horse) : null, shieldArm = -1;
  if (shield) { const S = shield, q0 = mG(...S.c), q1 = mG(...S.c.map((v, i) => v + S.n[i]));
    shieldFace = faces(q1.map((v, i) => v - q0[i])) > 0;
    shieldL = nearer(q0) ? (shieldFace ? NEAR_ARM + 5 : NEAR_ARM + 1) : (shieldFace ? BODY - 0.5 : FAR_ARM - 0.5); }
  // arms: shoulder → elbow (two-bone, bent back and out; across the body it wraps forward) → hand, a puffed sleeve
  for (const s of [-1, 1]) { const shA = [0, -8, s * (dress ? 3.4 : 3.9)], hand = Uinv((o.hands && o.hands[s > 0 ? 1 : 0]) || [1, -2.4, s * 5.6]);
    if (dress && hand[0] < 3.5 && hand[1] > -9 && s * hand[2] > 0) hand[2] = s * Math.max(s * hand[2], 6.7);
    const D = hand.map((v, i) => v - shA[i]), d = Math.hypot(...D) || 1e-6, n = D.map(v => v / d);
    const cross = Math.max(0, Math.min(1, (1.5 - s * hand[2]) / 5)), pole = [-0.55 + 1.75 * cross, 0.25, s * (1 - 0.6 * cross)], pd = pole[0] * n[0] + pole[1] * n[1] + pole[2] * n[2];
    const q = pole.map((v, i) => v - pd * n[i]), qL = Math.hypot(...q) || 1, Lu = Math.min(5.2, Math.max(3.2, d * 0.56)), a = d / 2, h = Math.sqrt(Math.max(0, Lu * Lu - a * a));
    const E = o.elbows ? Uinv(o.elbows[s > 0 ? 1 : 0]) : shA.map((v, i) => v + n[i] * a + q[i] / qL * h), arm = quadPts(shA, E.map((v, i) => 2 * v - (shA[i] + hand[i]) / 2), hand, 8);
    const sq = mU(...shA), hq = mU(...hand), gripFront = toolFront && grips.includes(s > 0 ? 1 : 0);
    const farGrip = wL === FAR_SIDE && wK.grips.includes(s > 0 ? 1 : 0);   // (a sword behind the horse takes its whole arm along: the torso covers the shoulder)
    const upperL = farGrip ? FAR_SIDE : depth(sq[0], sq[2]) >= bodyD - 0.5 ? NEAR_ARM : FAR_ARM;
    // (a hand swung back behind the body — further than its middle, and over its outline on screen — goes behind it)
    const handBehind = !nearer(hq) && overBody(P(...hq));
    const foreL = (upperL === NEAR_ARM || gripFront) && !handBehind ? (hand[1] < -9 && nearer(hq) ? RAISED_ARM : NEAR_ARM) : FAR_ARM;
    tube(C.skin, arm.slice(0, 5).map(q => mU(...q)), 1.05, 'arm').d = upperL;           // shoulder → elbow
    tube(tc, arm.slice(0, 3).map(q => mU(...q)), 1.45, 'arm').d = upperL + 0.001;      // the puffed sleeve: the arm's first stretch (as the 3D's 0.22)
    const shArm = shieldL != null && s === shieldArm, foreD = shArm ? shieldL + (shieldFace ? -0.01 : 0.01) : farGrip ? FAR_SIDE + 0.001 : foreL;   // (the shield arm: inside the shield)
    tube(C.skin, arm.slice(4).map(q => mU(...q)), 1.05, 'arm').d = foreD;               // elbow → wrist
    // a fist over the handle it grips — but under the tool's head where that head covers it on screen, nearer us (a
    // blow coming down at us hides the fists behind it)
    const hp = P(...hq), th = toolHead && P(...toolHead.q), hidden = gripFront && th && Math.hypot(hp[0] - th[0], hp[1] - th[1]) < toolHead.r && depth(toolHead.q[0], toolHead.q[2]) > depth(hq[0], hq[2]) + 0.5;
    const wFront = wL != null && wK && wK.grips.includes(s > 0 ? 1 : 0) ? wL : FRONT_TOOL;   // (a fist rides its weapon's layer)
    if (gripFront && wFront !== FRONT_TOOL) { tube(C.skin, arm.slice(4).map(q => mU(...q)), 1.05, 'arm').d = wFront + 0.001; }
    blob(C.skin, mU, ...hand, 1.3, 1.3, 1.3, 'arm').pt.d = shArm || farGrip ? foreD + 0.002 : gripFront ? wFront + (hidden ? -0.002 : 0.002) : foreL + 0.002; }
  // the tool (pov3d's tool()/knife(), in the character's frame): its handle along dir from the hands, the head on top, the
  // blade side toward edge; in front of the body or behind it by where its head is
  if (toolK) TOOLS2D[tool].draw({ ...toolK, d: toolFront ? FRONT_TOOL : BACK_TOOL });
  if (wK) wK.draw({ tube, add, blob, P, faces, quadPts, mG, tc, eq, d: wL != null ? wL : toolFront ? FRONT_TOOL : BACK_TOOL, nearer, layers: { BACK_TOOL, BODY, NEAR_ARM, FRONT_TOOL } });
  if (shield) drawShield2D({ add, blob, P, faces, mG, tc, shieldL }, shield, eq.shield);
  if (sawK) { const L = toolFront ? FRONT_TOOL : BACK_TOOL;
    tube(VIL_TOOL_COL.handle, quadPts([4, -4.5], [4.6, -11], [11.5, -11], 6).concat(quadPts([11.5, -11], [18.4, -11], [19, -4.5], 6).slice(1)).map(([x, y]) => sawK(x, y)), 0.8, 'tool').d = L;  // the bowed frame
    const pts = [[3.4, 0]]; for (let x = 3.4; x < 19.6; x += 1.35) pts.push([x + 0.45, -1.1], [x + 1.35, -0.55]);
    pts.push([19.6, -0.55], [19.6, 0.9], [3.4, 0.9]);                                    // the blade: a bright strip, toothed along its lower edge
    const bp = pts.map(([x, y]) => P(...sawK(x, -4.5 - y)));
    add('#f2f6fb', L + 0.001, () => { X.moveTo(...bp[0]); for (const q of bp.slice(1)) X.lineTo(...q); X.closePath(); }, 'tool'); }
  if (rigK) barrowRig2D({ ...rigK, tube, blob, add, P, depth, faces, quadPts, d: toolFront ? FRONT_TOOL : BACK_TOOL, kind: act.kind, load: act.opt.load });
  // the load overhead (pov3d's load(): its own frame — x forward, y up, z across — ×1.5, rocking a little with the step)
  if (act.kind === 'carry' && act.opt.load) { const k = 1.5, ld = act.opt.load, tilt = 0.08 * Math.sin(4 * Math.PI * act.t), ct = Math.cos(tilt), st = Math.sin(tilt);
    const L = (x, y, z) => { const y1 = y * ct - z * st, z1 = y * st + z * ct; return mG(0.3 + x * k, -18.1 - LOAD_SIT[ld] - y1 * k, z1 * k); };
    const LOAD = 205, ld3 = q => LOAD + 0.01 * depth(q[0], q[2]);
    VIL_LOADS[ld]({ L, k, tube, blob, add, P, faces, ld3 }); }
  if (act.kind === 'forage' && o.berry) blob('#cc3344', mG, o.berry[0] + 0.8, o.berry[1] - 0.6, o.berry[2], 1.1, 1.1, 1.1, 'tool').pt.d = RAISED_ARM + 0.003;
  parts.sort((p, q) => p.d - q.d);
  return parts;
  }
  // (it draws its own heading: undo drawUnit's mirror; its ground: drawUnit's art y 5; a villager at its drawn spot)
  const ddx = S.wx != null ? S.wx - e.x : 0, ddy = S.wy != null ? S.wy - e.y : 0;
  const paintSet = list => { X.save(); if (e.facing === -1) X.scale(-1, 1); X.translate((ddx - ddy) * HALF_TW / UNIT_SCALE, (ddx + ddy) * HALF_TH / UNIT_SCALE + 5); paintParts(list); X.restore(); };
  // a rider: what's past the horse's far flank (his far leg, a sword on that side), the horse, the rest of him, the
  // horse's head (when nearer than the saddle), a weapon held in front
  if (horse) { // (its subsets kept on the cached pose: their paths are built once, as the pose's)
    const sub = parts.__sub || (parts.__sub = (() => { const far = p => p.grp === 'farleg' || p.d < FAR_SIDE + 1, rest = parts.filter(p => !far(p));
      return { far: parts.filter(far), rest, under: rest.filter(p => p.d < FRONT_TOOL), over: rest.filter(p => p.d >= FRONT_TOOL) }; })());
    paintSet(sub.far); horse.body();
    if (horse.frontHead) { paintSet(sub.under); horse.head(); paintSet(sub.over); }
    else { horse.head(); paintSet(sub.rest); } }
  else if (fallen) { const h = (e.dir || 0) * Math.PI / 4, nearer0 = (Math.cos(h) + Math.sin(h)) * (-0.8 + 0.25 * HORSE_TILE * thrown) + (Math.cos(h) - Math.sin(h)) * (-0.72 * HORSE_TILE * thrown) > 0;   // (thrown clear: in front of the horse or behind it, by where he lands)
    if (nearer0) { fallen(); paintSet(parts); } else { paintSet(parts); fallen(); } }
  else paintSet(parts);
  return true;
}
// The loads in 2D (pov3d's load(), in its frame L: x forward, y up, z across, before the ×k cartoon size).
const loadHull = ps => { ps = ps.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]); const cr = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]), lo = [], up = [];
  for (const p of ps) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (const p of ps.slice().reverse()) { while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1)); };
const loadPoly = ps => () => { X.moveTo(...ps[0]); for (const q of ps.slice(1)) X.lineTo(...q); X.closePath(); };
const VIL_LOADS = {
  wood: g => { for (const z of [-1.7, 1.7]) {                                          // two logs along the head, a light cut end toward us
    const end = x => Array.from({ length: 16 }, (_, i) => g.L(x, 1.9 * Math.cos(i / 16 * 2 * Math.PI), z + 1.9 * Math.sin(i / 16 * 2 * Math.PI)));
    const a = end(-6.5), b = end(6.5), mid = g.L(0, 0, z); g.add(TREE_BARK, g.ld3(mid), loadPoly(loadHull(a.concat(b).map(q => g.P(...q)))), 'load');
    const ax = g.L(1, 0, z).map((v, i) => v - mid[i]), cap = g.faces(ax) > 0 ? b : a;
    if (Math.abs(g.faces(ax)) > 0.05) g.add(TREE_CUT, g.ld3(mid) + 0.001, loadPoly(cap.map(q => g.P(...q))), 'load').line = true; } },
  stone: g => { for (const [x, y, z] of [[-2, 0, 0], [2, 0.2, 0.6], [0, 3, 0.2]]) {      // three blocks, the top face lit
    const c = [], top = []; for (const dx of [-2.1, 2.1]) for (const dz of [-2.1, 2.1]) { for (const dy of [-1.6, 1.6]) c.push(g.L(x + dx, y + dy, z + dz)); top.push(g.L(x + dx, y + 1.6, z + dz)); }
    const d = g.ld3(g.L(x, y, z)); g.add('#9d9d9d', d, loadPoly(loadHull(c.map(q => g.P(...q)))), 'load');
    g.add('#b8b8b8', d + 0.0001, loadPoly(loadHull(top.map(q => g.P(...q)))), 'load', false); } },
  gold: g => { for (const [x, y, z] of [[-2, 0, 0], [2, 0, 0.6], [0, 0, -2], [0, 2.1, 0.2], [1.1, 1.6, 1.8]]) { const b = g.blob('#e8b90f', g.L, x, y, z, 1.9, 1.9, 1.9, 'load'); b.pt.d = g.ld3(b.o); } },
  food: g => { for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {             // a wheat sheaf: stalks pinched at the tie, grain heads at one end
    const pin = g.L(0, a * 0.35, b * 0.35);
    g.tube('#d4ab2c', [g.L(-4, a * 0.9, b * 0.9), pin, g.L(5.2, a * 1.9, b * 1.9)], 0.5 * g.k, 'load').d = g.ld3(pin);
    const h = g.blob('#e8c84a', g.L, 6.4, a * 2.1, b * 2.1, 1.7, 0.85, 0.85, 'load'); h.pt.d = g.ld3(h.o) + 0.001; }
    const t = g.blob('#8b5a2b', g.L, 0, 0, 0, 0.4, 1.3, 1.3, 'load'); t.pt.d = g.ld3(t.o) + 0.002; },                 // the cord round the middle
  wool: g => { for (const [x, y, z, r] of [[0, 0, 0, 2.6], [-2.2, -0.3, 0.8, 2], [2.2, -0.2, -0.6, 2.1], [0.4, 1.8, 0.2, 1.9], [-0.8, 0.2, -1.8, 1.8], [1, 0.3, 1.9, 1.8]]) {
    const b = g.blob('#f2eddd', g.L, x, y, z, r, r, r, 'load'); b.pt.d = g.ld3(b.o); } },                           // a fluffy bundle of fleece
  berries: g => { for (let n = 0; n < 11; n++) { const a = n * 2.39996, rr = n < 7 ? 1.9 : 0.9;                                  // a heap of red berries
    const b = g.blob('#cc3344', g.L, Math.cos(a) * rr, (n < 7 ? 0 : 1.3) + (n % 2) * 0.3, Math.sin(a) * rr, 1.05, 1.05, 1.05, 'load'); b.pt.d = g.ld3(b.o); } },
};
// ---- Soldiers in 2D: the same body as the villager (drawPerson2D), their gear from pov3d's models ----
// helmets: [x, y, z, rx, ry, rz] (head-frame art px) and steel
const SOLDIER_HELM = { great: [0, -14.6, 0, 4.5, 4.4, 4.5, '#c6cdd8'], hood: [-0.8, -16, 0, 4.4, 3, 4.4, null], kettle: [0, -16, 0, 3.9, 2.8, 3.9, '#8f8a7d'], norman: [-0.3, -15.6, 0, 4.5, 3.8, 4.5, '#a8adb3'], spiked: [-0.3, -15.8, 0, 4.4, 3.6, 4.4, '#b9bec6'] };
const FOOT_SOLDIERS = new Set(['militia', 'spearman', 'archer']);
// a soldier's pose this frame; attacking on the move, the legs keep walking underneath
function soldierPose2D(ut, act, eq){
  const p = SOLDIER_POSE[ut](act.kind, act.t, eq);
  if (act.legs) { const w = villagerWalkPose(act.legs.t); p.feet = w.feet; p.bob = w.bob; }
  return p;
}
// the edge a sword rests with, unkeyed (pov3d's sword(): +y stood along dir, its local +x turned the same way)
function restEdge2D(d){ const L = Math.hypot(...d), y = d.map(v => v / L), ax = [y[2], 0, -y[0]], s = Math.hypot(...ax);
  if (s < 1e-6) return [1, 0, 0]; const n = ax.map(v => v / s), c = y[1], k = n[0];   // rotate (1,0,0) about n by acos(y): Rodrigues
  const v = [1, 0, 0], cr = [n[1] * v[2] - n[2] * v[1], n[2] * v[0] - n[0] * v[2], n[0] * v[1] - n[1] * v[0]];
  return v.map((vi, i) => vi * c + cr[i] * s + n[i] * k * (1 - c)); }
// A soldier's weapon in his frame: { hand, tip, grips, draw(k) } — the hand it rides, its far end (front or behind), the
// fists on it, and its parts (all at layer k.d). Art px: x forward, y down, z across; dirs world-style (y up).
function soldierWeapon2D(ut, o, eq, mG){
  const frame = (hand, dir, edge) => { const dl = Math.hypot(...dir), Y = [dir[0] / dl, -dir[1] / dl, dir[2] / dl], e0 = edge || restEdge2D(dir), E = [e0[0], -e0[1], e0[2]], ey = E[0] * Y[0] + E[1] * Y[1] + E[2] * Y[2];
    let Xs = E.map((v, i) => v - ey * Y[i]); const xl = Math.hypot(...Xs) || 1; Xs = Xs.map(v => v / xl);
    return (u, v) => mG(...hand.map((b, i) => b + Y[i] * u + Xs[i] * v)); };
  const poly = (k, pts, col, d) => { const ps = pts.map(q => k.P(...q)); k.add(col, d, () => { X.moveTo(...ps[0]); for (const q of ps.slice(1)) X.lineTo(...q); X.closePath(); }, 'tool'); };
  if (ut === 'militia' || isMountedUnit(ut)) { const { hand, dir, edge } = o.weapon, at = frame(hand, dir, edge), ext = eq.weapon >= 2 ? 3 : eq.weapon >= 1 ? 1.5 : 0;
    // gripped in the right hand (a rider's too), both hands without a shield
    return { hand, tip: at(20, 0), grips: ut === 'militia' && !eq.shield ? [0, 1] : [1], draw: k => {
      k.tube('#5c3d24', [at(-2.7, 0), at(2.7, 0)], 0.8, 'tool').d = k.d;                                                     // the grip
      poly(k, [[-3.8, 2.7], [3.8, 2.7], [3.8, 4.5], [-3.8, 4.5]].map(([v, u]) => at(u, v)), '#daa520', k.d + 0.001);          // the crossguard
      const steel = ['#a7abb0', '#dde3ea', '#f2f6fb'][eq.weapon] || '#a7abb0';
      k.tube(steel, [at(4.5, 0), at(21 + ext, 0)], [0.6, 0.35], 'tool').d = k.d + 0.0004;                                     // (the blade's thickness: edge-on it stays a steel sliver)
      poly(k, [[-2.2, 4.5], [2.2, 4.5], [1.9, 19.5 + ext], [0, 24.5 + ext], [-1.9, 19.5 + ext]].map(([v, u]) => at(u, v)), steel, k.d + 0.0005); } }; }
  if (ut === 'spearman') { const { hand, dir } = o.weapon, at = frame(hand, dir);
    return { hand, tip: at(18, 0), grips: [0, 1], draw: k => {
      k.tube('#8B4513', [at(-9, 0), at(16, 0)], 0.8, 'tool').d = k.d;                                                        // the shaft
      k.tube(eq.metal, [at(16, 0), at(21, 0)], [1.5, 0.15], 'tool').d = k.d + 0.001; } }; }                                // the steel point (a cone: round from any side)
  // archer: the bow at its grip, the string drawn back to the pull hand, an arrow on the string
  // (the stave runs along `up` — upright unless dropped — and bends toward the pull hand, square to it)
  const b = o.bow, G = b.grip, pull = b.pull, up = b.up || [0, -1, 0], d0 = pull.map((v, i) => v - G[i]), du = d0[0] * up[0] + d0[1] * up[1] + d0[2] * up[2];
  let back = d0.map((v, i) => v - du * up[i]), bl = Math.hypot(...back);
  back = bl < 1e-4 ? [-1, 0, 0] : back.map(v => v / bl);
  const L = 10.6, bend = 2.2 + 1.8 * b.draw, tips = [1, -1].map(s => G.map((v, i) => v + back[i] * bend + s * L * up[i]));
  const mid = [(tips[0][0] + tips[1][0]) / 2, (tips[0][1] + tips[1][1]) / 2, (tips[0][2] + tips[1][2]) / 2], f = Math.min(1, Math.max(0, b.draw) / 0.15), Pq = mid.map((v, i) => v + (pull[i] - v) * f);
  return { hand: G, tip: G, grips: [0], draw: k => {
    for (const tp of tips) { const c = [(G[0] + tp[0]) / 2 - back[0] * 1.2, (G[1] + tp[1]) / 2, (G[2] + tp[2]) / 2 - back[2] * 1.2];
      k.tube('#b3874a', quadPts(G, c, tp, 5).map(q => mG(...q)), 0.75, 'tool').d = k.d; }                                   // the two limbs
    for (const tp of tips) k.tube('#e8e8e8', [mG(...tp), mG(...Pq)], 0.22, 'tool').d = k.d + 0.001;                           // the string
    const nock = b.arrow ? Pq : b.fetched ? pull : null;
    if (nock) { const d = [G[0] - nock[0], G[1] - nock[1], G[2] - nock[2]], dl = Math.hypot(...d) || 1, at = u => nock.map((v, i) => v + d[i] / dl * u);
      k.tube('#8b6a3a', [mG(...at(0)), mG(...at(15))], 0.35, 'tool').d = k.d + 0.002;                                        // the shaft
      k.tube('#dde3ea', [mG(...at(14.2)), mG(...at(16.4))], [0.9, 0.1], 'tool').d = k.d + 0.003;                            // the head
      if (eq.feather) k.tube(lightOfHex(k.tc), [mG(...at(0.4)), mG(...at(3.4))], [1, 0.3], 'tool').d = k.d + 0.0025; }  // Fletching's vanes
    if (eq.quiver) { const c = [-4.2, -9, 1.5], ax = [0.247, -0.91, 0.332], q = u => mG(...c.map((v, i) => v + ax[i] * u)), qd = k.nearer(mG(...c)) ? k.layers.NEAR_ARM + 1 : k.layers.BACK_TOOL - 0.5;   // (facing away it's on top of his back and shoulder, under the head)
      k.tube('#7a5230', [q(-4), q(4)], 1.5, 'tool').d = qd;                                                                   // the quiver on his back, fletchings showing
      for (const z of [-0.8, 0.8]) k.tube(eq.feather ? lightOfHex(k.tc) : '#8b6a3a', [mG(...c.map((v, i) => v + ax[i] * 3.6 + (i === 2 ? z : 0))), mG(...c.map((v, i) => v + ax[i] * 5.8 + (i === 2 ? z : 0)))], 0.5, 'tool').d = qd + 0.001; } } };
}
// a light tint of a team colour (pov3d's lightOf: 45% toward white)
const lightOfHex = hex => { const n = parseInt(hex.slice(1), 16), f = v => Math.round(v + (255 - v) * 0.45);
  return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(v => f(v).toString(16).padStart(2, '0')).join(''); };
// The militia's shield on his left forearm (pov3d's roundShield / kiteShield): the round one faces forward, a white boss;
// the kite turned forward, white with a team cross. In front of him, or behind facing away.
// Where a shield sits (pov3d's roundShield / kiteShield): its centre c and yaw th (three's rotation.y) — the militia's
// on his left forearm, a rider's out to his left (riderFig) — and the way its face looks, n (art: x fwd, y down, z across)
const KITE_TURN = Math.PI / 2 - 0.3, SHIELD_BACK = '#9a6a3a';   // (the kite's back: bare wood, both views)
function shieldOf(o, kind, rider){
  const sh = o.shieldHand, c = rider ? [1, -6.5, -9] : kind === 'round' ? [sh[0] + 1.2, sh[1], sh[2] - 0.5] : [sh[0] + 1.4, sh[1] + 1, sh[2] + 0.4];
  const th = rider ? (kind === 'round' ? Math.PI / 2 - 0.35 : Math.PI - 0.35) : kind === 'round' ? 0 : KITE_TURN;
  return { c, th, n: kind === 'round' ? [Math.cos(th), 0, -Math.sin(th)] : [Math.sin(th), 0, Math.cos(th)] };
}
// A dead soldier's weapon and shield (pov3d's droppedItem): out of the hand (dropXf) to lie beside him, in the ground
// frame — a rider's from the saddle, the sword off his right, the shield off his left, tipped to land face up. k: a
// projKit's { tube, add, blob, P, faces }, the team colour tc, and nearer (in front of the body).
function soldierDrops2D(e, eq, age, k){
  const mGround = (x, y, z) => [x, 5 - y, z], R = isMountedUnit(e.utype);
  const dx = R ? dropXf(age, [6.5, -21, 6.8], [0.2, 0, 0.98], 0.3) : dropXf(age, [3, -6.5, 5.8]), o0 = dx([0, 0, 0]), t1 = dx([0, -1, 0]);
  const axis = [t1[0] - o0[0], -(t1[1] - o0[1]), t1[2] - o0[2]], up = y => ({ hand: dx([0, -y, 0]), dir: axis });
  const od = e.utype === 'archer' ? { bow: { grip: dx([0, -10.6, 0]), pull: dx([0.95, -10.6, -0.3]), up: t1.map((v, i) => v - o0[i]), draw: 0, arrow: false } }
    : e.utype === 'spearman' ? { weapon: up(9) } : { weapon: up(2.7) };
  const w = soldierWeapon2D(R ? 'knight' : e.utype, od, { ...eq, quiver: false, feather: false }, mGround);
  w.draw({ ...k, quadPts, mG: mGround, eq, d: k.nearer(w.hand) ? FRONT_TOOL : BACK_TOOL, layers: { BACK_TOOL, BODY, NEAR_ARM, FRONT_TOOL } });
  if (!eq.shield) return;
  const F = R ? [0.15, 0, -0.99] : [0.25, 0, -0.97], sy = eq.shield === 'kite' ? 8.5 : 4.8;
  const sx = R ? dropXf(age, [1, -20.5, -9], F, 0.35) : dropXf(age, [4, -7, -6], F, 0.2);
  drawShield2D({ ...k, mG: (x, y, z) => mGround(...sx([x, y - sy, z])), shieldL: k.nearer(mGround(...sx([0, -sy, 0]))) ? FRONT_TOOL - 1 : BACK_TOOL - 1 },
    { c: [0, 0, 0], th: eq.shield === 'kite' ? Math.atan2(-F[0], -F[2]) : Math.atan2(F[2], -F[0]), n: [0, 0, 1] }, eq.shield);
}
// The bones (pov3d's humanSkeleton / horseSkeleton), into projKit k through m: the skeleton's frame (art px: x fwd, y up,
// z across) → the kit's. A man lies on his back along −x from his heels: a big skull with big sockets looking up, a
// spine, two fat ribs arching over it, a pelvis, arms flung out, legs — the fewest bones that read.
function bone2D(k, m, a, b, r){   // a cartoon bone: a shaft with a double knob at each end
  k.tube(BONE, [m(...a), m(...b)], r, 'bone'); const dx = b[0] - a[0], dz = b[2] - a[2], L = Math.hypot(dx, dz) || 1, n = [-dz / L * r * 1.05, dx / L * r * 1.05];
  for (const e of [a, b]) for (const s of [-1, 1]) k.blob(BONE, m, e[0] + n[0] * s, e[1], e[2] + n[1] * s, r * 1.55, r * 1.55, r * 1.55, 'bone');
}
const ribArch2D = (k, m, x, y, zc, R, r) => k.tube(BONE, Array.from({ length: 9 }, (_, i) => { const a = i / 8 * Math.PI; return m(x, y + R * Math.sin(a), zc - R * Math.cos(a)); }), r, 'bone');
function humanBones2D(k, m){
  k.tube(BONE, [m(-19, 0.9, 0), m(-9.5, 0.9, 0)], 0.9, 'bone');                                    // spine
  for (const x of [-15.5, -12.6]) ribArch2D(k, m, x, 0.9, 0, 3.2, 0.8);                             // two fat ribs
  k.blob(BONE, m, -9.5, 0.9, 0, 2, 1.1, 3, 'bone');                                                 // pelvis
  const sk = k.blob(BONE, m, -22, 3, -0.6, 3.6, 3.2, 3.4, 'bone');                                  // big skull, rolled a little to one side
  for (const z of [-1, 1]) k.blob(BONE_HOLE, m, -22.4, 5.4, z * 1.4 - 0.6, 1.05, 1.05, 1.05, 'bone', 0, false).pt.d = sk.pt.d + 0.001;   // sockets, looking up
  for (const s of [-1, 1]) { bone2D(k, m, [-17.5, 0.9, s * 3.6], [-19.5, 0.9, s * 10.5], 0.7); bone2D(k, m, [-9.5, 0.9, s * 2], [-1.5, 0.9, s * 2.6], 0.8); }   // arms; legs
}
// lying on its side (the corpse's roll), in tiles (pov3d's world units): legs out to the belly side, ribs over the flank,
// the long skull on its side
function horseBones2D(k, m){
  const T = HORSE_TILE, S = (...q) => q.map(v => v * T), y = 0.06;
  k.tube(BONE, [m(...S(-0.42, y, 0)), m(...S(0.3, y + 0.02, 0))], 0.04 * T, 'bone');                // spine
  for (let i = 0; i < 3; i++) { const R = i === 1 ? 0.19 : 0.16; ribArch2D(k, m, ...S(-0.18 + i * 0.14, y, R * 0.9, R, 0.035)); }
  k.tube(BONE, [m(...S(0.3, y + 0.02, 0)), m(...S(0.55, y + 0.04, 0.08))], 0.035 * T, 'bone');       // neck bones
  const sk = k.blob(BONE, m, ...S(0.68, 0.09, 0.1, 0.16, 0.085, 0.08), 'bone'); k.blob(BONE, m, ...S(0.83, 0.07, 0.12, 0.07, 0.05, 0.05), 'bone');   // the long skull, the muzzle
  k.blob(BONE_HOLE, m, ...S(0.63, 0.165, 0.1, 0.04, 0.04, 0.04), 'bone', 0, false).pt.d = sk.pt.d + 0.001;   // the upturned socket
  for (const [x, dx] of [[-0.4, -0.08], [-0.3, 0.02], [0.14, 0.06], [0.24, 0.14]]) bone2D(k, m, S(x, 0.035, 0.1), S(x + dx, 0.035, 0.55), 0.026 * T);
}
// the bear's (pov3d's bearSkeleton), lying on its side as the corpse did: legs out to the belly side, the ribs arching
// over the upturned flank, a big skull on its side
function bearBones2D(k, m){
  const T = HORSE_TILE, S = (...q) => q.map(v => v * T), y = 0.05;
  k.tube(BONE, [m(...S(-0.34, y, 0)), m(...S(0.24, y + 0.02, 0))], 0.035 * T, 'bone');               // spine
  for (let i = 0; i < 3; i++) { const R = i === 1 ? 0.17 : 0.14; ribArch2D(k, m, ...S(-0.1 + i * 0.12, y, R * 0.9, R, 0.032)); }
  const sk = k.blob(BONE, m, ...S(0.38, 0.09, 0.02, 0.15, 0.1, 0.12), 'bone'); k.blob(BONE, m, ...S(0.52, 0.06, 0.03, 0.08, 0.05, 0.065), 'bone');   // skull, snout
  k.blob(BONE_HOLE, m, ...S(0.43, 0.17, 0.03, 0.045, 0.045, 0.045), 'bone', 0, false).pt.d = sk.pt.d + 0.001;   // the upturned socket
  for (const [x, dx] of [[-0.3, -0.06], [-0.22, 0.02], [0.1, 0.05], [0.18, 0.12]]) bone2D(k, m, S(x, 0.03, 0.08), S(x + dx, 0.03, 0.42), 0.022 * T);
}
// the ox's (pov3d's oxSkeleton), sized from the ox (×1.2), lying on its side as the rolled body did: legs out toward
// +z, ribs over the flank, the horned skull
function oxBones2D(k, m){
  const S = (...q) => q.map(v => v * 1.2), y = 1.4;
  k.tube(BONE, [m(...S(-8.5, y, 0)), m(...S(8, y + 0.3, 0))], 1.2, 'bone');                          // spine
  for (const x of [-4, 0, 4]) { const R = x ? 4.3 : 4.8; ribArch2D(k, m, ...S(x, y, R * 0.9, R, 0.9)); }
  k.tube(BONE, [m(...S(8, y + 0.3, 0)), m(...S(11, y + 0.5, 1))], 0.9 * 1.2, 'bone');               // neck bones
  const sk = k.blob(BONE, m, ...S(12.6, y + 1.2, 1.2, 3, 2.3, 2.4), 'bone'); k.blob(BONE, m, ...S(15, y + 0.8, 1.4, 1.6, 1.4, 1.6), 'bone');   // skull, muzzle
  k.blob(BONE_HOLE, m, ...S(12.8, y + 3.1, 1.2, 0.9, 0.9, 0.9), 'bone', 0, false).pt.d = sk.pt.d + 0.001;   // the upturned socket
  for (const h of [[[11.6, y + 1.8, -0.5], [11, y + 2, -4.5], [10.2, y + 5.5, -5.5]], [[11.6, y + 2.8, 2.5], [11.2, y + 6, 4.5], [10.4, y + 8.5, 3.5]]])
    k.tube('#ece4cf', h.map(q => m(...S(...q))), 0.75 * 1.2, 'bone');                                 // the horns, still on
  for (const [x, dx] of [[-5, -1.5], [-4.4, 0.8], [4.4, 1], [5, 2.6]]) bone2D(k, m, S(x, 1, 2.5), S(x + dx, 1, 11), 0.8 * 1.2);
}
// A rigged corpse's skeleton stage (villager, foot soldier, rider), in drawUnit's frame at the corpse (sx, sy): the bones
// where the body came to rest, facing the way it died — a rider's beside his horse's, where he was thrown — and his
// dropped weapon and shield still lying by them (pov3d's corpse skeleton)
const RIG_BEASTS = new Set(['bear', 'dragon']);
// corpse -> its bones' parts: bones never move (every drop has landed long before CORPSE_SKEL), so built once — a
// WeakMap, not a field: corpses are saved and structuredClone'd (see _stillCorpse)
const _bonesParts = new WeakMap();
function drawBones2D(c, sx, sy, age){
  let parts = _bonesParts.get(c);
  if (!parts) { parts = buildBones2D(c, age); _bonesParts.set(c, parts); }
  X.save(); X.translate(sx, sy); X.scale(UNIT_SCALE, UNIT_SCALE); X.translate(0, 5); paintParts(parts); X.restore();
}
function buildBones2D(c, age){
  const h = (c.dir || 0) * Math.PI / 4, k = projKit(h), soldier = FOOT_SOLDIERS.has(c.utype) || isMountedUnit(c.utype);
  let mid = [-14, 0];
  if (RIG_BEASTS.has(c.utype)) { const sc = c.utype === 'dragon' ? 2.2 : 1, zc = c.utype === 'bear' ? -0.38 * HORSE_TILE : 0;   // (the spine where the body lay: the rolled bear's a body-height to the side; the dragon's, the bear's ×2.2, where it sank)
    bearBones2D(k, (x, y, z) => [x * sc, y * sc, z * sc + zc]); }
  else if (isMountedUnit(c.utype)) { const T = HORSE_TILE, lx = -0.8 + 0.25 * T, lz = -0.72 * T, hz = 11.2 * 1.35;   // (his landing spot; the barrel's height: the rolled horse's offset)
    horseBones2D(k, (x, y, z) => [x, y, z - hz]);
    humanBones2D(k, (x, y, z) => [lx - z, y, lz + x]); mid = [0, -hz]; }                                // (turned so his head lies toward −z, as he rolled)
  else humanBones2D(k, (x, y, z) => [x, y, z]);
  if (soldier) soldierDrops2D(c, soldierGear(c), age, { ...k, tc: teamColor(c.team), nearer: q => k.depth(q[0], q[2]) > k.depth(...mid) });
  return k.parts;
}
// The shield in 2D, in layer k.shieldL: the round one a wooden disc (its axis local x) with a white boss on its face; the
// kite (its face local +z) white with the team cross, the back bare wood, 1 px thick with a brown edge round it
function drawShield2D(k, S, kind){
  const L = k.shieldL, ct = Math.cos(S.th), st = Math.sin(S.th), c = S.c;
  const R = (x, y, z) => k.mG(c[0] + x * ct + z * st, c[1] + y, c[2] - x * st + z * ct), facing = q => { const a = k.mG(...c); return k.faces(q.map((v, i) => v - a[i])) > 0; };
  if (kind === 'round') { k.blob('#a5723a', R, 0, 0, 0, 0.6, 4.8, 4.8, 'tool').pt.d = L;
    if (facing(R(1, 0, 0))) k.blob('#f5f5f0', R, 0.7, 0, 0, 0.5, 1.6, 1.6, 'tool').pt.d = L + 0.001; return; }
  const face = facing(R(0, 0, 1)), zn = face ? 1 : 0, at = (x, y, z = zn) => R(x, -y, z);
  const poly = (pts, col, d) => { const ps = pts.map(([x, y]) => k.P(...at(x, y))); k.add(col, d, () => { X.moveTo(...ps[0]); for (const q of ps.slice(1)) X.lineTo(...q); X.closePath(); }, 'tool', false); };
  const kite = [[-4.2, 5.5], [-5.6, 0], [0, -8.5], [5.6, 0], [4.2, 5.5]], slab = loadHull(kite.flatMap(([x, y]) => [k.P(...at(x, y, 0)), k.P(...at(x, y, 1))]));
  k.add('#7a5230', L, () => { X.moveTo(...slab[0]); for (const q of slab.slice(1)) X.lineTo(...q); X.closePath(); }, 'tool');
  poly(kite, face ? '#f5f5f0' : SHIELD_BACK, L + 0.0005);
  if (face) { poly([[-0.85, -6.5], [0.85, -6.5], [0.85, 5], [-0.85, 5]], k.tc, L + 0.001); poly([[-4.4, 1], [4.4, 1], [4.4, 2.7], [-4.4, 2.7]], k.tc, L + 0.001); }
}
// A rider's pose (2D and pov3d's riderFig): the sword arm (riderArm) on his right, as on foot; the other hand on the
// reins — or the shield out on his left — the hands jogging with the horse, leaning into a gallop and back on the windup.
// Dying (t: how far he's thrown) his legs close (riderLeg).
function riderPose(kind, t, eq, gait = {}){
  const [hand0, dir, edge] = riderArm(kind, t);
  const jog = kind === 'gallop' ? 0.9 * Math.sin(2 * Math.PI * t) : kind === 'walk' ? 0.35 * Math.sin(4 * Math.PI * t) : 0;
  const hand = [hand0[0], hand0[1] + jog, hand0[2]];
  const off = eq.shield ? [1.5, -6.5 + jog * 0.6, -7.8] : [6 + 5 * (gait.nod || 0), -6.8 + jog * 0.6, -3.9];   // shield grip, or the reins (the rein hand follows the head)
  const lean = kind === 'gallop' ? 0.12 : 0, sw = kind === 'attack' ? (q => 0.25 * q.c - 0.2 * q.w)(swordArc(t, [0, 0, 0], 3.4, 0)) : 0;   // (leaning back on the windup, into the cut)
  return { hands: [off, hand], torso: { lean: lean + Math.max(0, sw), yaw: sw }, weapon: { hand, dir, edge: edge || null }, riding: kind === 'die' ? 1 - t : 1 };
}
// The wheelbarrow and the Heavy Plow in 2D (pov3d's barrowRig): k.R maps rig px (x forward, h up, z across) to the kit;
// parts in layer k.d, ordered among themselves by depth — the wheel and handles under the tray, the load in it, the rim.
const RIG_WOOD = { beam: '#6e5138', plank: '#b89868', inside: '#7d6448' };
function barrowRig2D(k){
  const { R, P, d } = k, dd = q => d + 0.001 * k.depth(q[0], q[2]), poly = ps => () => { X.moveTo(...ps[0]); for (const q of ps.slice(1)) X.lineTo(...q); X.closePath(); };
  const pole = (a, b, r, col, bias = 0) => { k.tube(col, [R(...a), R(...b)], r * 1.25, 'rig').d = dd(R((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)) + bias; };
  for (const z of [-1, 1]) pole([1.8, 9.2, z * 3.1], [22, 3.6, z * 1.6], 0.6, RIG_WOOD.beam, -0.02);   // handles running to the axle ends
  const wh = k.blob('#5a4630', R, 22, 3.6, 0, 3.6, 3.6, 0.75, 'rig'); wh.pt.d = dd(wh.o) - 0.03;           // the wheel, a hub cap toward us
  for (const z of [-1, 1]) { const c = R(22, 3.6, z * 0.9), ax = R(22, 3.6, z).map((v, i) => v - R(22, 3.6, 0)[i]);
    if (k.faces(ax) > 0.05) k.blob('#3a2c1c', R, 22, 3.6, z * 0.9, 1.1, 1.1, 0.2, 'rig', 0, false).pt.d = wh.pt.d + 0.0001; }
  pole([22, 3.6, -1.9], [22, 3.6, 1.9], 0.5, RIG_WOOD.beam, -0.031);                                    // the axle
  if (k.kind === 'barrow') {
    // the open tray, flared: a narrow base, a wide rim raked forward over the wheel; seen from above, its inside
    const B = [[9, 2.7, -2.4], [16, 2.7, -2.4], [16, 2.7, 2.4], [9, 2.7, 2.4]], T = [[7.5, 7.2, -4], [20, 7.8, -4], [20, 7.8, 4], [7.5, 7.2, 4]];
    for (const z of [-1, 1]) pole([9.5, 2.7, z * 2.4], [9.5, 0, z * 2.4], 0.5, RIG_WOOD.beam, -0.025);  // two legs to rest on
    const hull = loadHull(B.concat(T).map(q => P(...R(...q)))), mid = R(13.5, 5, 0);
    k.add(RIG_WOOD.plank, dd(mid), poly(hull), 'rig');
    k.add(RIG_WOOD.inside, dd(mid) + 0.0001, poly(T.map(q => P(...R(...q)))), 'rig', false);
    // the load heaped in it (pov3d's FIT: [height, scale, x, tilt] — logs and the sheaf lean front-up on the raked wall)
    const FIT = { wood: [7.6, 0.88, 14, 0.32], stone: [7.2, 0.95], gold: [7.4, 0.95], food: [7.8, 0.9, 12.8, 0.36], wool: [7.4, 0.95], berries: [7.8, 1.35] };
    if (k.load) { const [y, sc, x = 13.5, tilt = 0] = FIT[k.load] || [7, 1.15], c = Math.cos(tilt), sn = Math.sin(tilt);
      const L = (lx, ly, lz) => R(x + (lx * c - ly * sn) * sc, y + (lx * sn + ly * c) * sc, lz * sc);
      VIL_LOADS[k.load]({ L, k: sc * 1.25, tube: k.tube, blob: k.blob, add: k.add, P, faces: k.faces, ld3: q => dd(mid) + 0.001 + 0.00001 * k.depth(q[0], q[2]) }); }
    for (let i = 0; i < 4; i++) k.tube(RIG_WOOD.beam, [R(...T[i]), R(...T[(i + 1) % 4])], 0.55 * 1.25, 'rig').d = dd(mid) + (k.depth(...(q => [q[0], q[2]])(R((T[i][0] + T[(i + 1) % 4][0]) / 2, 7.5, (T[i][2] + T[(i + 1) % 4][2]) / 2))) > k.depth(mid[0], mid[2]) ? 0.002 : -0.00005); // the rim (its near edges over the load)
  } else {
    // a crossbar between the handles (where they pass x 12.5), the standard down to the share: one curved steel blade
    // sweeping down and forward to a point in the soil
    const u = (12.5 - 1.8) / (22 - 1.8), cy = 9.2 - 5.6 * u, cz = 3.1 - 1.5 * u;
    pole([12.5, cy, -cz], [12.5, cy, cz], 0.6, RIG_WOOD.beam);
    pole([12.5, cy, 0], [12.5, 3, 0], 0.6, RIG_WOOD.beam, -0.001);
    const S = (x, h, z) => R(12.5 + x, 3 + h, z);
    k.tube('#b8bfc6', k.quadPts([0, 0, 0], [1.5, -3, 0], [5.5, -2.8, 0], 6).map(q => S(...q)), 1.1 * 1.25, 'rig').d = dd(S(3, -2.5, 0)) - 0.002;
    const pt = k.blob('#b8bfc6', S, 5.9, -2.8, 0, 1.4, 0.7, 1.1, 'rig'); pt.pt.d = dd(pt.o) - 0.0019;
  }
}
// The work tools in 2D (pov3d's tool() and knife(): art px, u up the handle from the grip, v to the blade side). top:
// where the head sits; draw: its parts at layer k.d.
const toolPoly = (k, pts, col) => { const ps = pts.map(([v, u]) => k.P(...k.at(u, v)));
  k.add(col, k.d + 0.001, () => { X.moveTo(...ps[0]); for (const q of ps.slice(1)) X.lineTo(...q); X.closePath(); }, 'tool'); };
const toolHandle = (k, len) => { k.tube(VIL_TOOL_COL.handle, [k.at(-len * 0.45, 0), k.at(len * 0.55, 0)], 0.8, 'tool').d = k.d; };
const TOOLS2D = {
  axe: { top: 7.15, headR: 3.5, draw: k => { toolHandle(k, 13); const t = 7.15 - 1.5, blade = [[0.3, 1.8], [4.6, 3.2], [5, 0], [4.6, -3.2], [0.3, -1.4]];  // a flat wedge off the handle top
    toolPoly(k, blade.map(([v, u]) => [v, t + u]), VIL_TOOL_COL.steel);
    if (k.up.double) toolPoly(k, blade.map(([v, u]) => [-v, t + u]), VIL_TOOL_COL.steel); } },                                           // Double-Bit: a second blade mirrored
  pick: { top: 7.15, headR: 2.5, draw: k => { toolHandle(k, 13); const t = 7.15;                                                                          // a curved double point across the top
    k.tube(k.up.bright ? VIL_TOOL_COL.bright : VIL_TOOL_COL.steel, k.quadPts([-4.2, t - 1.4, 0], [0, t + 1.2, 0], [4.6, t - 1.4, 0], 6).map(([v, u]) => k.at(u, v)), 0.7, 'tool').d = k.d + 0.001; } },
  mallet: { top: 7.15, headR: 3, draw: k => { toolHandle(k, 13); k.tube(VIL_TOOL_COL.wood, [k.at(7.15, -3.75), k.at(7.15, 3.75)], 2.2, 'tool').d = k.d + 0.001; } }, // a fat wooden barrel head
  scythe: { top: 9.35, headR: 2, draw: k => { toolHandle(k, 17); const t = 9.35, m = k.mow;   // a long curved blade off the snath's top (mowing: lying nearly flat)
    k.tube(k.up.bright ? VIL_TOOL_COL.bright : VIL_TOOL_COL.steel, k.quadPts([0, t, 0], [5, t + (m ? 1.2 : 1.5), 0], [10, t + (m ? 0.8 : -3.5), 0], 6).map(([v, u]) => k.at(u, v)), 0.6, 'tool').d = k.d + 0.001; } },
  knife: { top: 4, headR: 1, draw: k => { k.tube(VIL_TOOL_COL.handle, [k.at(-1.6, 0), k.at(1.4, 0)], 0.75, 'tool').d = k.d;                          // a short butcher's knife
    toolPoly(k, [[-0.9, 1.4], [0.8, 1.4], [0.6, 5.2], [-0.1, 6.8], [-0.9, 5]], '#dde3ea'); } },
};
// Bear body — same per-archetype seam as drawRamBody/drawTradeCartBody, which
// drawUnit's dispatch already delegates to.
// ---- The bear: one model and one animation for both views ----
// The 3D bear's shape (bearModel, js/pov3d.js — same numbers, tiles: x forward, y up, z across) posed by bearAnim,
// which the 3D view sets on the model and the 2D view projects at the bear's heading (as the dragon). A heavy lumbering
// walk: each paw planted DUTY of the stride and keeping pace with the ground (the leg reaches it, stretching a hair),
// the shoulders rolling, the head swinging low; idle, it breathes, sniffs and looks round; the maul rides the real bite
// clock — crouch, rear up on the hind paws with the fore paws raised, a pounce landing as the damage fires, a worry.
const BEAR = { fur: '#6b4a2c', belly: '#7c5836', legCol: '#62432a', legFar: '#4e3421', paw: '#3a2a1c', pawFar: '#2c2016', muzzle: '#c9a578', nose: '#141414', ear: '#4a3018', mouth: '#a03030', mouthIn: '#3a1f14',
  hips: [[-0.22, -0.17], [-0.22, 0.17], [0.2, -0.17], [0.2, 0.17]], hipY: 0.22, leg: 0.2, stride: 0.1, lift: 0.06, legR: 0.085, duty: 0.62,
  legPhase: [0, 0.5, 0.25, 0.75].map(f => f * 2 * Math.PI) };                       // 0/1 hind, 2/3 fore
function bearStride(phase, i){
  const q = (((phase + BEAR.legPhase[i] - Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), st = 2 * Math.PI * BEAR.duty;
  if (q < st) return { q, x: 1 - 2 * q / st, up: 0 };
  const u = (q - st) / (2 * Math.PI - st); return { q, x: -1 + 2 * u * u * (3 - 2 * u), up: Math.sin(Math.PI * u ** 0.8) };
}
// a: per-bear state (phase, gait, clock); moved: tiles walked since the last frame.
function bearAnim(e, a, dt, moved){
  a.ck = (a.ck || 0) + dt; const ck = a.ck, idp = e.id || 0;
  // walking, held across the tick or two between a chaser's re-plans (else the walk pose — head low — flickered off
  // and on: the head bobbed) unless it's at its prey
  const moving = isUnitMoving(e); if (moving) a.walkClk = ck;
  const walking = moving || (ck - (a.walkClk ?? -9) < 0.4 && !inActionRange(e));
  a.gait = (a.gait || 0) + ((walking ? 1 : 0) - (a.gait || 0)) * Math.min(1, dt * 4);
  a.phase = (a.phase || 0) + moved * Math.PI * BEAR.duty / BEAR.stride;
  const g = a.gait, ph = a.phase;
  const rof = (UNITS.bear && UNITS.bear.rof) || T30(60), cd = e.atkCooldown || 0, att = inActionRange(e) && !moving;
  const bp = att ? 1 - cd / rof : 0, snap = att ? Math.max(0, (cd - rof * 0.85) / (rof * 0.15)) : 0;   // bp: 0 just bitten → 1 the next bite
  const sm = x => x * x * (3 - 2 * x);
  // The maul, in beats on the bite clock: settle back after the bite → crouch low, weight back, head down → rear up on
  // the hind paws, fore paws raised, jaws opening → slam down and forward onto the prey, the bite landing with the
  // damage → jaws clamped, a worrying shake as it eases back. Lunge in art px (as the 2D art had it).
  let crouch = 0, rear = 0, lunge = 0, jaw = 0, paws = 0, slam = 0;
  if (att) {
    // (it bites every couple of seconds: kept a heavy, readable swing, not a violent one — full-size it read as shaking)
    if (bp < 0.15) { const t = sm(bp / 0.15); lunge = 2.5 - 1 * t; rear = -0.06 * (1 - t); slam = 1 - t; }
    else if (bp < 0.5) { const t = sm((bp - 0.15) / 0.35); lunge = 1.5 * (1 - t); }
    else if (bp < 0.75) { const t = sm((bp - 0.5) / 0.25); crouch = t; lunge = -0.8 * t; }
    else if (bp < 0.9) { const t = sm((bp - 0.75) / 0.15); crouch = 1 - t; rear = 0.38 * t; paws = t; jaw = 0.8 * t; lunge = -0.8 + 0.3 * t; }
    else { const t = sm((bp - 0.9) / 0.1); rear = 0.38 * (1 - t) - 0.06 * t; paws = 1 - t; jaw = 0.85; lunge = -0.5 + 3 * t; }
  }
  // idle: breathing, a slow look round, now and then a sniff (the head lifts, the nose bobs)
  const idle = (1 - g) * (att ? 0 : 1), sniff = Math.max(0, Math.sin(ck * 0.37 + idp)) ** 8 * idle;
  const breath = Math.sin(ck * 1.6 + idp) * 0.018 * idle;
  const look = 0.4 * Math.sin(ck * 0.23 + idp) ** 3 * idle;
  // walk: the body rides the stance (a low bob twice a stride), the shoulders roll, the head swings low and side to side
  const bob = -0.006 * g * (1 - Math.cos(2 * ph)) - 0.035 * crouch - 0.02 * slam, roll = Math.sin(ph) * 0.03 * g;
  const pitch = rear - 0.1 * crouch + Math.sin(2 * ph + 0.5) * 0.012 * g;
  const neckYaw = look + Math.sin(ph) * 0.04 * g;
  const neckPitch = -0.12 * g + 0.18 * sniff + Math.sin(ck * 18) * 0.03 * sniff - 0.25 * crouch + 0.2 * paws - 0.1 * slam;
  const shake = Math.sin(ck * 12) * 0.06 * snap;                                         // worrying the prey (a few slow tugs)
  const lungeT = lunge * 1.4 * UNIT_SCALE / (HALF_TW * Math.SQRT2);                       // (tiles)
  // legs: each paw's spot on the GROUND (in the model's frame: planted paws stay put however the body pitches and
  // lunges over them — the stance sweeping back, the swing lifting), turned into the body's frame for the leg's angle
  // and stretch; rearing, the fore paws come up off the ground, raised and reaching
  const hindX = -0.22, cp = Math.cos(pitch), spp = Math.sin(pitch);
  const legs = BEAR.hips.map(([hx], i) => {
    const s2 = bearStride(ph, i), hind = i < 2, dx0 = hx - hindX;
    const Hx = hindX + dx0 * cp - BEAR.hipY * spp + lungeT, Hy = dx0 * spp + BEAR.hipY * cp + bob;   // the hip, in the model
    let fx = hx + BEAR.stride * s2.x * g + lungeT * (hind ? 0.5 : 1), fy = 0.02 + BEAR.lift * s2.up * g;
    let vx = fx - Hx, vy = fy - Hy, bx = vx * cp + vy * spp, by = -vx * spp + vy * cp;              // → the body's frame
    if (!hind && paws > 0) { bx += (0.17 - bx) * paws; by += (-0.1 - by) * paws; }                    // raised, reaching
    const d = Math.min(BEAR.leg * 1.2, Math.max(BEAR.leg * 0.55, Math.hypot(bx, by)));
    return { ang: Math.atan2(bx, -by), len: d / BEAR.leg };
  });
  const reach = paws;
  return { g, pitch, lunge: lungeT, bob, roll, breath, neckYaw, neckPitch, shake, jaw, reach, legs, att };
}
// dead (pov3d's deathPose): it rolls onto its −z flank, accelerating, with an impact recoil, lifted by its half-width;
// the legs splay, the head drops, the jaw falls slack. age: ms since the death.
const BEAR_DEAD_HALF = 0.27;
function bearDeathPose(age){
  const p = Math.min(1, age / 600); let rot = (Math.PI / 2.1) * p * p;
  if (age > 600 && age < 900) rot *= 1 + 0.07 * Math.sin((age - 600) / 300 * Math.PI);
  return { g: 0, pitch: 0, lunge: 0, bob: BEAR_DEAD_HALF * Math.sin(Math.min(rot, Math.PI / 2)), roll: -rot, breath: 0, neckYaw: 0, neckPitch: -0.35 * p, shake: 0,
    jaw: 0.36 * p, reach: 0, legs: [0, 1, 2, 3].map(i => ({ ang: (i < 2 ? -0.45 : 0.45) * p, len: 1 })), att: false };
}
const bear2D = new Map();
function drawBearBody(e){
  let a = bear2D.get(e.id);
  if (!a) bear2D.set(e.id, a = { px: e.x, py: e.y, last: 0, hd: undefined });
  const target = (e.dir !== undefined ? e.dir : 1) * Math.PI / 4;
  if (e.__deathAge != null) { a.hd = target; a.P = bearDeathPose(e.__deathAge); }   // (dead: lying the way it faced as it died)
  else if (!window._maskDraw || !a.P) {
    const now = performance.now(), dt = a.last ? Math.min(0.1, (now - a.last) / 1000) : 1 / 60; a.last = now;
    const [mx, my] = walkedSince(a, e), moved = Math.hypot(mx, my);
    // walking, it faces its smoothed course (the tile path zigzags in 8 directions: facing each step swung it side to
    // side); standing, its facing (toward its prey) — turning at a heavy animal's pace
    // (the course averaged over the last ~1.5 tiles walked, not over time: at 2× speed a time average followed each zig)
    if (moved > 1e-4) { const c = Math.min(1, moved / 1.5), ux = mx / moved, uy = my / moved; a.cx = (a.cx ?? ux) + (ux - (a.cx ?? ux)) * c; a.cy = (a.cy ?? uy) + (uy - (a.cy ?? uy)) * c; }
    // (walking by the sim's state: the sim ticks slower than frames, so most frames it moved nothing — reading that
    // as standing pulled the heading back toward its 8-way facing and forth again, every tick: the face shook)
    // (and across the tick or two between a chaser's re-plans, unless it's at its prey: else it snapped to face the
    // prey and back, every re-plan)
    if (isUnitMoving(e)) a.walkT = now; const walking = now - (a.walkT || -1e9) < 400 && !inActionRange(e);
    const want = walking && a.cx !== undefined ? Math.atan2(a.cy, a.cx) : target;
    if (a.hd === undefined) a.hd = want;
    a.hd += Math.atan2(Math.sin(want - a.hd), Math.cos(want - a.hd)) * Math.min(1, dt * 4);
    a.P = bearAnim(e, a, dt, moved);
  }
  const P = a.P, C = BEAR, K = DRAGON_K, Cc = DRAGON_C, RR = Cc * Math.SQRT2, cos = Math.cos, sin = Math.sin, TAU = Math.PI * 2;
  X.save(); if (e.facing === -1) X.scale(-1, 1);                                      // (it draws its own heading: undo drawUnit's mirror)
  const fx = cos(a.hd), fy = sin(a.hd), sx = -fy, sy = fx;
  const Pf = [(fx - fy) * Cc, (fx + fy) * Cc / 2], Ps = [(sx - sy) * Cc, (sx + sy) * Cc / 2];
  const pj = (x, y, z) => [x * Pf[0] + z * Ps[0], x * Pf[1] + z * Ps[1] - y * K];
  const depth = (x, z) => x * (fx + fy) + z * (sx + sy);
  // frames: the body pitched about the hind paws (rearing), lunged, rolled; the neck turned and nodded on it; the jaw
  const hindX = -0.22, cp = cos(P.pitch), spp = sin(P.pitch), cr = cos(P.roll), sr = sin(P.roll);
  const bm = (x, y, z = 0) => { const y1 = y * cr - z * sr, z1 = y * sr + z * cr;                      // roll about the body's long axis
    const dx = x - hindX; return [hindX + dx * cp - y1 * spp + P.lunge, dx * spp + y1 * cp + P.bob, z1]; };
  const ny = P.neckYaw, np = P.neckPitch + P.shake * 0.3;
  const nk = (x, y, z = 0) => { const x1 = x * cos(np) - y * sin(np), y1 = x * sin(np) + y * cos(np);
    return bm(0.32 + x1 * cos(ny) - z * sin(ny), 0.46 + y1, x1 * sin(ny) + z * cos(ny) + P.shake * 0.02); };
  const jw = (x, y, z = 0) => { const j = -0.7 * P.jaw, x1 = x * cos(j) - y * sin(j), y1 = x * sin(j) + y * cos(j); return nk(0.24 + x1, snY - 0.015 + y1, z); };
  let ccw = false;                                                                    // (the shade's cut-out: wound the other way, so overlapping parts stay one hole)
  const ellP = (cx, cy, rx, ry, rot = 0) => { X.moveTo(cx + rx * cos(rot), cy + rx * sin(rot)); X.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, TAU, ccw); };
  const ellOf = (f, x, y, z, rx, ry, rz) => { const o = pj(...f(x, y, z));
    const ax = [f(x + rx, y, z), f(x, y + ry, z), f(x, y, z + rz)].map(m => { const q = pj(...m); return [q[0] - o[0], q[1] - o[1]]; });
    let sxx = 0, sxy = 0, syy = 0; for (const [u, v] of ax) { sxx += u * u; sxy += u * v; syy += v * v; }
    const tr = (sxx + syy) / 2, dd = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy), rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return [o[0], o[1], Math.sqrt(tr + dd), Math.sqrt(Math.max(0, tr - dd)), rot, f(x, y, z)]; };
  let grp = null; const parts = [], add = (col, d, path, outline = true) => parts.push({ col, d, path, outline, g: grp });
  const blob = (col, f, x, y, z, rx, ry = rx, rz = rx, bias = 0, outline = true) => { const [cx, cy, a2, b2, rot, m] = ellOf(f, x, y, z, rx, ry, rz);
    add(col, depth(m[0], m[2]) + bias, () => ellP(cx, cy, a2, b2, rot), outline); parts[parts.length - 1].bb = [cx - a2, cy - a2, cx + a2, cy + a2]; };
  const tube = (col, m0, m1, r, bias = 0) => { const a0 = pj(...m0), a1 = pj(...m1), rr = r * RR, dx = a1[0] - a0[0], dy = a1[1] - a0[1], l = Math.hypot(dx, dy) || 1e-6, nx = -dy / l * rr, ny2 = dx / l * rr;
    // (the side quad wound as the end circles are: opposite windings cancelled where they overlap — holes in the leg)
    const q = [[a0[0] + nx, a0[1] + ny2], [a1[0] + nx, a1[1] + ny2], [a1[0] - nx, a1[1] - ny2], [a0[0] - nx, a0[1] - ny2]];
    let ar = 0; for (let k = 0; k < 4; k++) { const u = q[k], v = q[(k + 1) % 4]; ar += u[0] * v[1] - v[0] * u[1]; }
    const qq = (ar < 0) !== ccw ? q.slice().reverse() : q;
    add(col, (depth(m0[0], m0[2]) + depth(m1[0], m1[2])) / 2 + bias, () => { ellP(a0[0], a0[1], rr, rr); ellP(a1[0], a1[1], rr, rr);
      X.moveTo(qq[0][0], qq[0][1]); for (let k = 1; k < 4; k++) X.lineTo(qq[k][0], qq[k][1]); X.closePath(); }); };
  const bodyD = depth(...(m => [m[0], m[2]])(bm(-0.01, 0.42, 0)));
  // body: the boulder, the shoulder hump, a lighter belly, a stub tail (breathing swells it)
  const br = 1 + P.breath;
  grp = 'body';
  blob(C.fur, bm, -0.01, 0.38, 0, 0.42 * br, 0.36 * br, 0.33 * br);                        // (a fat cartoon boulder on stubby legs)
  blob(C.fur, bm, -0.1, 0.6, 0, 0.23, 0.2, 0.22, 0.02);
  grp = null;
  blob(C.fur, bm, -0.43, 0.4, 0, 0.065);
  // legs: from each hip to its paw (the pose's angle and reach), a dark paw on the end
  // (sorted behind the body, so only what hangs below it shows — sorted by its own depth, a near leg painted over the belly)
  BEAR.hips.forEach(([hx, hz], i) => { const L = P.legs[i], ux = sin(L.ang), uy = -cos(L.ang), len = BEAR.leg * L.len;
    const px = hx + ux * len, py = BEAR.hipY + uy * len, t0 = Math.min(0.06, len * 0.2), p = bm(px, py, hz);
    const far = depth(p[0], p[2]) < bodyD;                                              // the far pair a shade darker: in the body's shadow
    // (the leg ends inside its paw: its round cap below the paw showed as a brown rim under the foot)
    tube(far ? C.legFar : C.legCol, bm(hx + ux * t0, BEAR.hipY + uy * t0, hz), bm(px - ux * 0.075, py - uy * 0.075, hz), BEAR.legR, 0); parts[parts.length - 1].d = bodyD - 0.02 + (depth(p[0], p[2]) - bodyD) * 0.01; // (just behind the body: its top tucks up inside; a head turned away stays behind them)
    const legD = parts[parts.length - 1].d;
        blob(far ? C.pawFar : C.paw, bm, px + 0.015, py - 0.01, hz, 0.1, 0.032, 0.088);   // (the 3D paw: centred under the leg, a hair forward)
    // sorted just behind its own leg: the leg always stands over its paw (and by its own depth a far paw drew over a near leg)
    parts[parts.length - 1].d = legD - 1e-4; });
  // head: a big round head, tan muzzle, black nose, round ears (dark inside), the eyes; the jaw hinges under it
  const hx = 0.13, hy = 0.02, R = 0.2;
  const snY = -0.005;                                                                  // the snout's height on the face (as bearModel)
  grp = 'head'; blob(C.fur, nk, hx, hy, 0, R, R, R, 0.03); parts[parts.length - 1].line = true; grp = null; // (its own line where it sits over the body)
  // (only the part standing off the head shows: in 3D the rest sinks into it)
  blob(C.muzzle, nk, hx + 0.21, hy + snY - 0.005, 0, 0.082, 0.06, 0.085, 0.05);
  // the mouth: a tan lower jaw hinging down under the muzzle, dark inside as it gapes — always just behind the muzzle
  // (the muzzle covers its top from every side; sorted by their own centres they poked through it as a red smear)
  { const md = parts[parts.length - 1].d;
    if (P.jaw > 0.05) { blob(C.mouthIn, nk, hx + 0.19, hy + snY - 0.04 - 0.03 * P.jaw, 0, 0.075, 0.035 + 0.035 * P.jaw, 0.06, 0, false); parts[parts.length - 1].d = md - 0.002; }
    blob(C.muzzle, jw, 0.07, -0.01, 0, 0.075, 0.028, 0.058); parts[parts.length - 1].d = md - 0.001; }
  blob(C.nose, nk, hx + 0.285, hy + snY + 0.03, 0, 0.04, 0.032, 0.045, 0.06, false);
  // ears: lined, so they read against the fur-coloured body behind them (head-on they vanished)
  // (on top of the head, a touch back — lower down they sat on its side as rings)
  // round ears on the top corners of the head, cupped forward (thin front to back: as a flat side-facing disc they
  // were slivers head-on and rings on the cheek from the side); the dark inside on the front face, seen only facing us.
  // Sorted by their own depth, as the 3D model draws them: the near ear a round bump over the head, the far one peeking
  // past it. The inside just over its ear when the ear faces us, else under it.
  { const e0 = nk(hx, hy), e1 = nk(hx + 1, hy), facing = depth(e1[0] - e0[0], e1[2] - e0[2]) > 0;
    for (const z of [-1, 1]) { blob(C.fur, nk, hx - 0.03, hy + 0.185, z * 0.13, 0.04, 0.066, 0.062); const ed = parts[parts.length - 1].d; parts[parts.length - 1].line = true;
      blob(C.ear, nk, hx - 0.005, hy + 0.185, z * 0.13, 0.012, 0.038, 0.036, 0, false); parts[parts.length - 1].d = ed + (facing ? 0.0005 : -0.0005); } }
  // paint: silhouette strokes far to near, fills far to near
  parts.sort((p, q) => p.d - q.d);
  X.lineJoin = 'round'; X.strokeStyle = '#000'; X.lineWidth = 2 / UNIT_SCALE;
  for (const pt of parts) if (pt.outline) { X.beginPath(); pt.path(); X.stroke(); }
  // fills far to near; each group (the body, the head) gets the dragon's light underside shade as its last part is
  // painted — the shape less itself lifted — so nearer parts cover it
  const last = new Map(); for (const pt of parts) if (pt.g) last.set(pt.g, pt);
  const band = (ms, lift, col, alpha) => silhouetteBand(ms.map(p => p.path), ms.reduce((b, p) => [Math.min(b[0], p.bb[0]), Math.min(b[1], p.bb[1]), Math.max(b[2], p.bb[2]), Math.max(b[3], p.bb[3])], [Infinity, Infinity, -Infinity, -Infinity]), lift, col, alpha);
  // the light from above: a lit band along the top, the underside in shade
  const shade = g => { const ms = parts.filter(p => p.g === g && p.outline), k = g === 'head' ? 0.09 : 0.13;
    band(ms, k * K, '#140a00', 0.22); band(ms, -k * 0.55 * K, '#ffe1b4', 0.16); };
  for (const pt of parts) { X.fillStyle = pt.col; X.beginPath(); pt.path(); X.fill();
    if (pt.line) { X.save(); X.lineWidth = 1 / UNIT_SCALE; X.strokeStyle = 'rgba(0,0,0,0.55)'; X.stroke(); X.restore(); }
    if (pt.g && last.get(pt.g) === pt) shade(pt.g); }
  // eyes: little black dots on the side of the head that faces us (both, head-on)
  const o0 = nk(hx, hy, 0);
  // (the 3D model's eyes: on the head's surface, toward the snout — eyes(), js/pov3d.js)
  for (const zs of [-1, 1]) { const m = nk(hx + 0.15, hy + 0.09, zs * 0.096), toward = depth(m[0] - o0[0], m[2] - o0[2]);
    if (toward < 0.02) continue; const [ex, ey] = pj(...m); X.fillStyle = '#000'; X.beginPath(); X.arc(ex, ey, 1.25, 0, TAU); X.fill(); } // (plain black dots, as the 3D model's)
  X.restore();
}

// ---- The dragon's animation, shared by the 2D art (drawDragonBody) and the 3D model (js/pov3d.js) ----
// Viewer-only: nothing here is read by the sim. dragonAnim advances one dragon's animation state `a` by dt seconds
// and returns its pose numbers — the same numbers both views draw — plus this frame's events (footfalls, the slam,
// smoke) for each view's own dust and shake. The caller keeps a.phase / a.gait (its stride, from how far the
// dragon was drawn to move) and may set a.roarT (a scripted roar, 0..1), a.noRoar, a.lab.
const DRAGON_LEG_PHASE = [0, 0.5, 0.25, 0.75].map(f => f * 2 * Math.PI); // legs 0/1 hind, 2/3 fore
// The stride: each leg's foot, x −1 (back) … 1 (ahead), its lift, and the heel roll. A heavy walk: each foot is down
// DRAGON_DUTY of the cycle (weight on three feet most of the time); the heel peels up only at the end of the stance;
// the swing picks the foot up quickly and high, carries it, and sets it down deliberately — toes hanging in the air,
// flattening just before it lands.
const DRAGON_DUTY = 0.6;
function dragonStride(phase, i){
  const q = (((phase + DRAGON_LEG_PHASE[i] - Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), st = 2 * Math.PI * DRAGON_DUTY;
  if (q < st) { const u = q / st; return { q, x: 1 - 2 * u, up: 0, roll: Math.max(0, (u - 0.72) / 0.28) * 0.45 }; }
  const u = (q - st) / (2 * Math.PI - st), s = u * u * (3 - 2 * u);
  return { q, x: -1 + 2 * s, up: Math.sin(Math.PI * u ** 0.8), roll: -0.35 * Math.sin(Math.PI * u) * (1 - u) };
}
// The dragon's stride clock (both views): distance walked — and, pivoting in place, the arc its feet sweep round
// (≈0.9 tiles out) — drives the legs, so a turn steps round instead of sliding its planted feet. The walk eases in and
// out slowly (a heavy body getting going); a.turn is the smoothed turn rate (rad/s) the body reads (dragonAnim).
function dragonGaitStep(e, a, moved, dt, strideLen){
  const f = e.faceAng || 0, dth = a.lastFace === undefined ? 0 : Math.atan2(Math.sin(f - a.lastFace), Math.cos(f - a.lastFace));
  a.lastFace = f;
  a.turn = (a.turn || 0) + ((dt > 1e-4 ? dth / dt : 0) - (a.turn || 0)) * Math.min(1, dt * 5);
  const go = moved + Math.abs(dth) * 0.9;
  const on = isUnitMoving(e) || Math.abs(a.turn) > 0.15;                            // (from the sim's state: a frame without a tick moved nothing)
  a.gait = (a.gait || 0) + ((on ? 1 : 0) - (a.gait || 0)) * Math.min(1, dt * 3.5);
  a.phase = (a.phase || 0) + go * Math.PI * DRAGON_DUTY / strideLen;              // a stance sweeps 2·strideLen in DRAGON_DUTY of the cycle: planted feet keep pace with the ground
}
// dead (pov3d's dragonDeath): the body drops, legs folding under it, with a bounce; the neck and head fall after,
// the jaw slack, the eyes shut; the tail goes limp and the wings sag open onto the ground. age: ms since the death.
function dragonDeathPose(age){
  const fall = (t0, dur) => { const u = Math.max(0, Math.min(1, (age - t0) / dur)); return u * u; };        // accelerating
  const ease = (t0, dur) => { const u = Math.max(0, Math.min(1, (age - t0) / dur)); return u * u * (3 - 2 * u); };
  const bounce = (t0, amp) => age > t0 ? amp * Math.exp(-(age - t0) / 170) * Math.sin((age - t0) / 60) : 0;
  const fb = fall(100, 650), fn = fall(450, 600), limp = ease(300, 900);
  return { ck: 0, sl: 0, lie: Math.min(1, fb * 1.3), awake: 0, g: 0, rr: 0, inhale: 0, bl: 0, blast: 1, chest: 0, sink: 0, roll: 0, pitch: bounce(750, 0.03),
    bodyX: 0, bodyY: -0.44 * fb + bounce(750, 0.05), neck: 0.1 - 1.2 * fn + bounce(1050, 0.08), neckY: 0.25 * fn, head: 0.5 * fn + bounce(1070, 0.08), headX: 0,
    jaw: 0.25 * fall(1000, 400), eyeShut: fall(900, 300), tail: [0.2, 0.15, 0.2].map(v => v * limp), tailZ: [-0.2, -0.1, 0.1].map(v => v * limp), spade: 0,
    open: 0.35 * limp, wingAng: 1.35 - 1.6 * limp, beat: 0, flame: 0, reach: 0, ev: { steps: [], slam: false, snore: false, smoke: false } };
}
function dragonAnim(e, a, dt){
  const D = a.dr || (a.dr = { ck: 0, sp: {}, q: [0, 0, 0, 0] }); D.ck += dt; const ck = D.ck, idp = e.id || 0;
  const spring = (k, target, K, z) => { let S = D.sp[k]; if (!S) S = D.sp[k] = { x: target, v: 0 };
    const w = Math.sqrt(K); for (let left = dt; left > 1e-6; left -= 0.02) { const h = Math.min(0.02, left); S.v += (-K * (S.x - target) - 2 * z * w * S.v) * h; S.x += S.v * h; } return S.x; };
  const kick = (k, v) => { if (D.sp[k]) D.sp[k].v += v; };
  const moving = isUnitMoving(e), asleep = !e.awake && !moving, rof = UNITS.dragon.rof, cd = e.atkCooldown || 0;
  const since = e.breathTick !== undefined ? tick - e.breathTick : 1e9, blast = since < T30(26) ? since / T30(26) : 1;
  const bl = blast < 1 ? Math.sin(Math.min(1, blast * 3) * Math.PI / 2) * (1 - blast) ** 0.6 : 0;   // the thrust: snaps in, fades
  const inhale = e.target && !moving && blast >= 1 && cd > 0 && cd < rof * 0.35 ? 1 - cd / (rof * 0.35) : 0;
  if (e.target && e.target !== D.prey && a.roarT === undefined && !a.noRoar) D.roarAt = ck; D.prey = e.target;
  const ro = a.roarT ?? (D.roarAt !== undefined ? Math.min(1, (ck - D.roarAt) / 1.9) : 1);
  const sm = x => x * x * (3 - 2 * x), rr = ro < 0.3 ? sm(ro / 0.3) : ro < 0.62 ? 1 : ro < 0.74 ? 1 - ((ro - 0.62) / 0.12) ** 2 : 0; // rear up, hold, drop
  const roarJaw = ro > 0.18 && ro < 0.8 ? Math.sin((ro - 0.18) / 0.62 * Math.PI) : 0;
  // heavy: wakes and settles slowly — but knocked out (spent) it drops, fast, and hits the ground hard
  const ko = !!e.spent && asleep;
  a.sleep = (a.sleep ?? (asleep ? 1 : 0)) + ((asleep ? 1 : 0) - (a.sleep ?? 0)) * Math.min(1, dt * (ko ? 3 : 0.7));
  if (ko && !D.ko) { D.koAt = ck; D.koSlam = false; } D.ko = ko;
  const sl = sm(Math.max(0, Math.min(1, a.sleep))), g = a.gait, awake = 1 - sl;
  // breathing: slow and deep asleep, the chest swelling for the breath
  const bp = ck / (sl > 0.5 ? 4.6 : 3.2) * 2 * Math.PI + idp, br0 = 0.5 + 0.5 * Math.sin(bp);
  const chest = (0.045 * sl + 0.035 * awake) * br0 + 0.08 * inhale - 0.04 * bl;
  // footfalls: each leg's touchdown (its stride phase wrapping) sinks the body and rolls it
  const ev = { steps: [], slam: false, snore: false, smoke: false };
  for (let i = 0; i < 4; i++) { const q = dragonStride(a.phase, i).q;
    if (g > 0.5 && q < D.q[i] - Math.PI) { kick('sink', -0.95); kick('roll', (i % 2 ? 1 : -1) * 0.42); kick('pitch', i >= 2 ? -0.32 : 0.22); ev.steps.push(i); }
    D.q[i] = q; }
  if (D.lastRo !== undefined && D.lastRo < 0.74 && ro >= 0.74) { kick('sink', -1.6); kick('pitch', -0.6); kick('tailZ1', 1.4); kick('tailZ2', 2); ev.slam = true; } // the slam (the tail bounces)
  D.lastRo = ro;
  if (D.koAt !== undefined && !D.koSlam && ck - D.koAt > 0.35) { D.koSlam = true; kick('sink', -2.2); kick('pitch', -0.9); kick('roll', 0.8); kick('tailZ1', 1.6); kick('tailZ2', 2.2); ev.slam = true; } // the knockout lands
  // body: sink and bounce, roll with the steps and an idle weight shift, pitch about the hind feet (rear up / lurch)
  const sink = spring('sink', 0, 55, 0.3);
  const shift = Math.sin(ck * 0.33 + idp) * awake * (1 - g);                              // idle: the weight rocks from side to side
  // its turn rate (rad/s, + toward the model's +z, its left): the body leans in (+roll), the head leads (−neckY turns
  // it that way), the tail swings out wide (−tail yaw) and whips back after
  const tr = Math.max(-0.6, Math.min(0.6, a.turn || 0)) * awake;
  const roll = spring('roll', Math.sin(a.phase) * 0.08 * g + shift * 0.04 + tr * 0.18, 11, 0.42);
  const pitch = spring('pitch', 0.22 * rr + 0.05 * inhale - 0.09 * bl + Math.sin(2 * a.phase) * 0.02 * g, 22, 0.42);
  // neck and head: lag behind the body (a head of that weight swings through), look round slowly when idle
  const lookT = (0.45 * Math.sin(ck * 0.29 + idp) + 0.2 * Math.sin(ck * 0.71 + 2)) * awake * (1 - g * 0.6) * (1 - rr) * (1 - bl);
  const neck = spring('neck', -1.25 * sl + 0.12 * inhale - 0.4 * bl + 0.12 * rr - 0.5 * pitch - Math.sin(2 * a.phase + 0.6) * 0.12 * g + Math.sin(ck * 0.5 + idp) * 0.06 * awake * (1 - g), 16, 0.42);
  const neckY = spring('neckY', lookT * (1 - Math.min(1, Math.abs(tr) * 3)) - tr * 0.9, 6, 0.55);
  const head = spring('head', 0.8 * sl - 0.22 * inhale + 0.3 * bl - 0.3 * roarJaw, 26, 0.45);
  const headX = spring('headX', Math.sin(ck * 23) * 0.05 * roarJaw, 60, 0.3);                  // the roar shakes it
  const snore = sl * 0.07 * Math.max(0, Math.sin(bp + Math.PI));
  const jaw = spring('jaw', 0.65 * bl + 0.75 * roarJaw + snore + 0.06 * inhale, 70, 0.55);
  const blink = Math.max(0, Math.sin(ck * 0.83 + idp)) ** 60, eyeShut = Math.max(sl, blink);
  // tail, three joints: the swing travels down it — each joint later and wider than the last, on a softer spring,
  // so the tip whips; pressed down when it rears (and bounced by the slam); curled round the body asleep
  const wave = k => Math.sin(ck * 0.45 + idp - k * 0.9) * (0.16 + 0.07 * k) * awake * (1 - g) - Math.sin(a.phase - k * 0.8) * (0.14 + 0.06 * k) * g
    + Math.sin(ck * 4 - k * 1.2) * 0.12 * bl * k;                                                // (the breath's recoil lashes the tip)
  const tail = [0, 1, 2].map(k => spring('tail' + k, wave(k) + [0.6, 0.65, 0.7][k] * sl - tr * [0.5, 0.45, 0.4][k], [5, 7, 9][k], [0.35, 0.3, 0.25][k]));
  const tailZ = [0, 1, 2].map(k => spring('tailZ' + k, [-0.12 * sl - 0.4 * rr + 0.12 * bl, -0.1 * sl - 0.12 * rr + 0.06 * bl, 0.08 * sl + 0.1 * rr][k], [9, 8, 10][k], [0.4, 0.35, 0.3][k]));
  const spade = spring('spade', 0.6 * sl * Math.max(0, Math.sin(ck * 0.3 + idp)) ** 12 * Math.sin(ck * 9) + 0.3 * tail[2], 40, 0.3); // twitching in its sleep
  // wings: open to the roar and the breath (half at the inhale), beating as it roars; folded they rise with the breathing
  const shuffle = 0.3 * Math.max(0, Math.sin(ck * 0.17 + idp)) ** 10 * (1 - g);                // now and then it resettles its wings
  const open = Math.max(0, Math.min(1, spring('wing', Math.max(bl, rr, 0.55 * inhale, e.target && !moving ? 0.3 : 0, shuffle) * awake, 12, 0.5)));
  const beat = Math.sin(ck * 7) * 0.35 * rr + spring('wingBob', 0, 30, 0.3) * 0.5 + Math.sin(2 * a.phase - 0.8) * 0.08 * g; // folded wings bounce with the steps
  if (g > 0.5) kick('wingBob', -Math.abs(D.sp.sink ? D.sp.sink.v : 0) * dt * 3);
  const flame = bl > 0.02 ? Math.min(1, blast * 6) : 0;
  ev.snore = sl > 0.8 && D.lastBp !== undefined && Math.sin(D.lastBp + Math.PI) < 0.95 && Math.sin(bp + Math.PI) >= 0.95;
  ev.smoke = blast > 0.6 && blast < 1 && Math.random() < dt * 6;
  D.lastBp = bp;
  const reach = rr * (0.7 + 0.3 * Math.sin(ck * 5)) + 0.3 * inhale;                              // fore legs paw the air as it rears
  a.lie = sl;   // (lie: the legs tucked under; sl: asleep — one and the same, but for the dead)
  // the body's offset: pitched about the hind feet, lurched by the breath, crouched by the inhale, lowered asleep
  const hind = -0.45, bodyX = hind - hind * Math.cos(pitch) + 0.1 * bl - 0.04 * inhale, bodyY = -hind * Math.sin(pitch) + sink * 0.12 - 0.07 * inhale - 0.4 * sl;
  return { ck, sl, lie: sl, awake, g, rr, inhale, bl, blast, chest, sink, roll, pitch, bodyX, bodyY, neck, neckY, head, headX, jaw, eyeShut,
    tail, tailZ, spade, open, beat, flame, reach, ev };
}
// The dragon's wing, bat-style, laid out for fold fd (0 spread … 1 folded; tuck 0..1 tighter still, asleep): joints
// shoulder S → elbow E → wrist W, fingertips F0..F2, the hip attach B, and the membrane's scallop points M*. In the
// wing's own plane: x chord (back −), y span (out), z its normal (the pleats step out of it in turn, by side sd).
const DRAGON_WING = { S: [0.05, 0], LU: 0.38, LF: 0.5, LK: [0.82, 0.74, 0.6], B: [-0.78, 0.04],
  // joint angles from the span axis, + toward the back: spread (arm out, fingers fanned) → folded (upper arm back,
  // forearm doubled forward, fingers doubled back along it, drawn together)
  spread: { u: -0.1, f: -0.05, k: [0.05, 0.62, 1.2] }, folded: { u: 1.15, f: -1.35, k: [1.72, 1.8, 1.88] },
  tucked: { u: 1.4, f: -1.62, k: [1.92, 1.97, 2.02] },                                    // asleep: folded tighter still, fingers pulled in
  pleat: [0.07, 0.02, 0.07] };                                                             // folded, the fingers step out of the plane in turn: the membrane between zig-zags
function dragonWingJoints(fd, tuck, sd){
  const WG = DRAGON_WING, e = fd * fd * (3 - 2 * fd), A = (a, b) => a + (b - a) * e, P = WG.spread, T = WG.tucked, F0 = WG.folded;
  const mixQ = (a, b) => a + (b - a) * tuck, Q = { u: mixQ(F0.u, T.u), f: mixQ(F0.f, T.f), k: F0.k.map((v, k) => mixQ(v, T.k[k])) }; // the fold, tucked tighter as it sleeps
  const dir = th => [-Math.sin(th), Math.cos(th)], at = (o, th, L, z = 0) => { const v = dir(th); return [o[0] + v[0] * L, o[1] + v[1] * L, z]; };
  const S = [WG.S[0], WG.S[1], 0], u = A(P.u, Q.u), E = at(S, u, WG.LU), f = u + A(P.f, Q.f), W = at(E, f, WG.LF);
  const F = WG.LK.map((L, k) => at(W, f + A(P.k[k], Q.k[k]), L * A(1, 0.72 - 0.15 * tuck), sd * WG.pleat[k] * e));
  const B = [WG.B[0], WG.B[1], 0], mid = (a, b, t, z) => [(a[0] + b[0]) / 2 + (W[0] - (a[0] + b[0]) / 2) * t, (a[1] + b[1]) / 2 + (W[1] - (a[1] + b[1]) / 2) * t, z];
  return { S, E, W, B, F0: F[0], F1: F[1], F2: F[2], M01: mid(F[0], F[1], 0.28, (F[0][2] + F[1][2]) / 2 - sd * 0.03 * e), M23: mid(F[1], F[2], 0.28, (F[1][2] + F[2][2]) / 2 - sd * 0.03 * e), M3: mid(F[2], B, 0.2, F[2][2] / 2) };
}
// The dragon's legs: a two-bone reach (thigh th, shin sh, the knee bending by `bend`: hind forward +1, fore back −1)
// from the hip to a foot at (tx, ty) (hip-relative, y up): the hip and knee angles, 0 = straight down, + toward +x.
const DRAGON_FOOT = 0.1; // the ankle's height over the sole
const DRAGON_LEG = { hind: { th: 0.31, sh: 0.33, bend: 1 }, fore: { th: 0.28, sh: 0.32, bend: -1 } };
// Lying: the hip ~0.22 over the ground, so each joint rests ON it beside the body. Hind: thigh down-forward to the
// knee on the ground at the flank, shin folded straight back along it (the foot under it). Fore, a sphinx's: upper
// arm down-back to the elbow at the chest's side, forearm out forward along the ground.
// (the shin / forearm lifts DRAGON_TUCK_UP off level, so its end — the ankle, DRAGON_FOOT over the sole — sits at foot
// height: lying flat along the ground put the ankle AT the ground, sinking each foot and poking its claws through)
const DRAGON_TUCK_UP = Math.asin(DRAGON_FOOT / 0.33);
const DRAGON_TUCK = { hind: { hip: 0.78, knee: -Math.PI / 2 - 0.78 - DRAGON_TUCK_UP, out: 0.75 }, fore: { hip: -0.67, knee: Math.PI / 2 + 0.67 + DRAGON_TUCK_UP, out: 0.36 } };
function dragonLegIK(L, tx, ty){
  const d = Math.max(Math.abs(L.th - L.sh) + 0.02, Math.min(L.th + L.sh - 1e-3, Math.hypot(tx, ty)));
  const base = Math.atan2(tx, -ty), a1 = Math.acos((L.th * L.th + d * d - L.sh * L.sh) / (2 * L.th * d)), k = Math.acos((L.th * L.th + L.sh * L.sh - d * d) / (2 * L.th * L.sh));
  return [base + L.bend * a1, -L.bend * (Math.PI - k)];
}
// The dragon's animation sounds (its footfalls, the slam, snoring), from the view that draws it — the 2D map or the
// 3D world view, never both. Viewer-only.
function dragonSounds(e, ev){
  if (!window.playSound) return;
  if (ev.steps.length) playSound('dragon_step', e.x, e.y);
  if (ev.slam) playSound('dragon_slam', e.x, e.y);
  if (ev.snore) playSound('dragon_snore', e.x, e.y);
}
const DRAGON_COL = { plate: '#2c5a28', plateLit: '#4b8341', plateDark: '#24491f', body: '#3f7a3a', dark: '#35693a', bone: '#2c5a28', belly: '#dcc47e', membrane: '#6f9e4c', horn: '#efe3c4', eye: '#ffd23a' };
// The dragon in 2D: the 3D model's own shape (the same model numbers as js/pov3d.js), posed by the same dragonAnim
// numbers, and projected at its real heading into the map's isometric view — so it reads from every direction as
// it turns (side, three-quarter, front, back). Round parts project to ellipses, limbs to tubes, plates and wings to
// polygons; they're painted far to near under one black silhouette, with a flat cel shadow on each rounded part.
// (to scale with the map, as the 3D model: a model unit is a tile — HALF_TW across the iso view, the 3D view's HPX
// tall — divided by the UNIT_SCALE drawUnit applies)
// the underside shade: its tint, and each group's lift (model units: the band's depth under a level part)
const DRAGON_SHADE = { col: '#0c280c', alpha: 0.2, trunk: 0.2, neck: 0.07, face: 0.07, tail: 0.08, leg: 0.06, wing: 0.14 };
const DRAGON_K = HALF_TW * Math.SQRT2 * Math.sqrt(3) / 2 / UNIT_SCALE, DRAGON_C = HALF_TW / UNIT_SCALE, dragon2D = new Map();
const DRAGON_STRIDE = 0.5 * Math.sin(0.6), DRAGON_LIFT = 0.12; // (GAIT.dragon, js/pov3d.js — keep the two equal)
function drawDragonBody(e){
  // the animation: its own clock and stride per dragon; the selection/outline mask pass re-draws the last pose
  let a = dragon2D.get(e.id);
  if (!a) dragon2D.set(e.id, a = { phase: 0, gait: 0, px: e.x, py: e.y, last: 0 });
  if (!window._maskDraw || !a.P) {
    const now = performance.now(), dt = a.last ? Math.min(0.1, (now - a.last) / 1000) : 1 / 60; a.last = now;
    const moved = Math.hypot(...walkedSince(a, e));
    dragonGaitStep(e, a, moved, dt, DRAGON_STRIDE);
    a.P = e.__deathAge != null ? dragonDeathPose(e.__deathAge) : dragonAnim(e, a, dt);
    if (e.__deathAge == null) {
      for (const i of a.P.ev.steps) spawnParticles(e.x, e.y, '#b7a27a', 2, 0.02, 0.6);
      if (a.P.ev.slam) spawnParticles(e.x, e.y, '#b7a27a', 8, 0.04, 1.4);
      dragonSounds(e, a.P.ev);
    }
  }
  const P = a.P, C = DRAGON_COL, K = DRAGON_K, cos = Math.cos, sin = Math.sin, TAU = Math.PI * 2;
  X.save(); if (e.facing === -1) X.scale(-1, 1);                                                     // (it draws its own heading: undo drawUnit's mirror)
  // --- the projection: model (x forward, y up, z to its left) → world by its heading → the isometric screen (px) ---
  const hd0 = e.faceAng !== undefined ? e.faceAng : (e.dir !== undefined ? e.dir : 7) * Math.PI / 4;
  const fx = cos(hd0), fy = sin(hd0), sx = -fy, sy = fx, Cc = DRAGON_C, RR = Cc * Math.SQRT2;          // (a tube's thickness: the across-the-view scale, not the vertical)
  const Pf = [(fx - fy) * Cc, (fx + fy) * Cc / 2], Ps = [(sx - sy) * Cc, (sx + sy) * Cc / 2];
  const pj = (x, y, z) => [x * Pf[0] + z * Ps[0], x * Pf[1] + z * Ps[1] - y * K];
  const depth = (x, z) => x * (fx + fy) + z * (sx + sy);                                             // nearer the viewer = larger
  const cp = cos(P.pitch), spc = sin(P.pitch);
  const bm = (x, y, z = 0) => [P.bodyX + x * cp - y * spc, P.bodyY + x * spc + y * cp, z];           // body frame → model
  // --- path helpers (screen px); every subpath wound one way, so overlapping pieces of one path never cut holes ---
  const polyP = pts => { let a2 = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a2 += p[0] * q[1] - q[0] * p[1]; }
    const o = a2 < 0 ? pts.slice().reverse() : pts; X.moveTo(o[0][0], o[0][1]); for (let i = 1; i < o.length; i++) X.lineTo(o[i][0], o[i][1]); X.closePath(); };
  const ellP = (cx, cy, rx, ry, rot = 0) => { X.moveTo(cx + rx * cos(rot), cy + rx * sin(rot)); X.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, TAU); };
  // An ellipsoid in a frame f (f(x, y, z) → model point: the body's, the head's, the jaw's) seen on screen: its three
  // radii projected as vectors, and the ellipse they span (from their covariance) — turned with the part, not boxed
  // upright, so a long jaw seen at a slant stays a slim slanted oval.
  const ellOf = (f, x, y, z, rx, ry, rz) => { const o = pj(...f(x, y, z));
    const ax = [f(x + rx, y, z), f(x, y + ry, z), f(x, y, z + rz)].map(m => { const q = pj(...m); return [q[0] - o[0], q[1] - o[1]]; });
    let sxx = 0, sxy = 0, syy = 0; for (const [u, v] of ax) { sxx += u * u; sxy += u * v; syy += v * v; }
    const tr = (sxx + syy) / 2, dd = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy), rot = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return [o[0], o[1], Math.sqrt(tr + dd), Math.sqrt(Math.max(0, tr - dd)), rot, f(x, y, z)]; };
  const tubeP = (a0, a1, ra, rb) => { const dx = a1[0] - a0[0], dy = a1[1] - a0[1], l = Math.hypot(dx, dy) || 1e-6, nx = -dy / l, ny = dx / l;
    ellP(a0[0], a0[1], ra, ra); ellP(a1[0], a1[1], rb, rb);
    polyP([[a0[0] + nx * ra, a0[1] + ny * ra], [a1[0] + nx * rb, a1[1] + ny * rb], [a1[0] - nx * rb, a1[1] - ny * rb], [a0[0] - nx * ra, a0[1] - ny * ra]]); };
  // the parts: { col, path, d (depth), clip }
  // (grp: the shading group — trunk, head, tail, a leg — the parts added now belong to)
  let grp = null; const parts = [], add = (col, d, path, clip) => { const p = { col, d, path, clip, g: grp }; parts.push(p); return p; };
  // an ellipsoid (model centre, radii along its x / y / z) → the ellipse it projects to
  const blob = (col, m, rx, ry, rz) => { const [cx, cy] = pj(...m);
    const hx = Math.hypot(rx * Pf[0], rz * Ps[0]), hy = Math.hypot(rx * Pf[1], ry * K, rz * Ps[1]);
    add(col, depth(m[0], m[2]), () => ellP(cx, cy, hx, hy)).bb = [cx - hx, cy - hy, cx + hx, cy + hy]; };
  // (bb: a part's screen box, for its group's underside shade — see the paint pass)
  const blobF = (col, f, x, y, z, rx, ry, rz, dBias = 0) => { const [cx, cy, a, b2, rot, m] = ellOf(f, x, y, z, rx, ry, rz);
    add(col, depth(m[0], m[2]) + dBias, () => ellP(cx, cy, a, b2, rot)).bb = [cx - a, cy - a, cx + a, cy + a]; };
  const tube = (col, m0, m1, r0, r1, dBias = 0) => { const a0 = pj(...m0), a1 = pj(...m1), r = Math.max(r0, r1) * RR;
    add(col, (depth(m0[0], m0[2]) + depth(m1[0], m1[2])) / 2 + dBias, () => tubeP(a0, a1, r0 * RR, r1 * RR)).bb =
      [Math.min(a0[0], a1[0]) - r, Math.min(a0[1], a1[1]) - r, Math.max(a0[0], a1[0]) + r, Math.max(a0[1], a1[1]) + r]; };
  const poly = (col, ms, dBias = 0) => { const pts = ms.map(m => pj(...m)), xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
    add(col, ms.reduce((s, m) => s + depth(m[0], m[2]), 0) / ms.length + dBias, () => polyP(pts)).bb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
  const s1 = 1 + P.chest * 0.35, s2 = 1 + P.chest;
  // body: haunch, barrel, chest (model 3D's blobs), the back plates
  grp = 'trunk';
  blobF(C.body, bm, -0.52 * s1, 0.72 * s2, 0, 0.36 * s1, 0.36 * s2, 0.4 * s1);
  blobF(C.body, bm, -0.12 * s1, 0.74 * s2, 0, 0.62 * s1, 0.42 * s2, 0.44 * s1);
  blobF(C.body, bm, 0.28 * s1, 0.8 * s2, 0, 0.5 * s1, 0.46 * s2, 0.46 * s1); grp = null;
  const bodyD = depth(bm(0, 0)[0], 0);
  // the back plates: a row of fins stood along the spine — each set on the body's top line where it stands (so the row
  // follows the back in one line), a triangle ±0.5·h at the base, h tall, leaning back, with a little thickness so seen
  // end-on they're slim wedges, not lines; tallest mid-back, in the dark plate colour
  const topAt = x => Math.max(...[[-0.52, 0.72, 0.36, 0.36], [-0.12, 0.74, 0.62, 0.42], [0.28, 0.8, 0.5, 0.46]]
    .map(([cx, cy, rx, ry]) => { const u = (x - cx * s1) / (rx * s1); return u * u < 1 ? cy * s2 + ry * s2 * Math.sqrt(1 - u * u) : -9; }));
  const hull2 = pts => { pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = []; for (const q of pts) { while (lo.length > 1 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let n = pts.length - 1; n >= 0; n--) { const q = pts[n]; while (up.length > 1 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1)); };
  // Set where the 3D model sets them (the front ones sunk deep in the chest): only what stands above the back line
  // shows, so each triangle is clipped to the body's top — else the buried ones read as saw-teeth up the neck.
  for (let k = 0; k < 5; k++) { const x = 0.42 - k * 0.24, h = (0.36 - Math.abs(k - 2) * 0.07) * s2, y = (1.14 - Math.abs(k - 2) * 0.05) * s2, ln = 0.3;
    // the 3D plate's shape: a three-sided cone (base corners at radius 0.55·h, squashed to 0.35 across), so edge-on it's a spike
    const r = 0.55 * h, base = [[0, 0.35 * r], [0.866 * r, -0.175 * r], [-0.866 * r, -0.175 * r]], pts = [];
    const put = (u, v, w) => { const px = x + u * cos(ln) - v * sin(ln), py = y + u * sin(ln) + v * cos(ln); pts.push([px, Math.max(py, topAt(px) - 0.03), w]); };
    for (let n = 0; n < 3; n++) for (let t = 0; t <= 8; t++) { const [u0, w0] = base[n], [u1, w1] = base[(n + 1) % 3];
      put(u0 * (1 - t / 8), h * t / 8, w0 * (1 - t / 8)); put(u0 + (u1 - u0) * t / 8, 0, w0 + (w1 - w0) * t / 8); }
    if (pts.every(([px, py]) => py <= topAt(px) - 0.02)) continue;
    const ms = pts.map(([px, py, w]) => bm(px, py, w));
    const out = hull2(ms.map(m => pj(...m)));
    // two-tone, split down its ridge (apex to the middle of its base): the half toward the light (the view's left) lit,
    // the other dark — so every spike reads as a solid from any side, never a flat cut-out lost against the wing bones
    const P3 = (u, v) => { const px = x + u * cos(ln) - v * sin(ln), py = y + u * sin(ln) + v * cos(ln); return pj(...bm(px, Math.max(py, topAt(px) - 0.03), 0)); };
    const ap = P3(0, h), bs = P3(0, 0);
    add(C.plate, Math.max(ms.reduce((a, m) => a + depth(m[0], m[2]), 0) / ms.length + 0.01, bodyD + 0.037), () => polyP(out)).draw = () => { // (over the far wing's root, under the near one's)
      X.save(); X.beginPath(); polyP(out); X.clip(); X.fillStyle = C.plateDark; X.fill();
      X.fillStyle = C.plateLit; X.beginPath(); X.moveTo(ap[0], ap[1] - 50); X.lineTo(ap[0], ap[1]); X.lineTo(bs[0], bs[1]); X.lineTo(bs[0], bs[1] + 50); X.lineTo(Math.min(ap[0], bs[0]) - 80, bs[1] + 50);
      X.lineTo(Math.min(ap[0], bs[0]) - 80, ap[1] - 50); X.closePath(); X.fill(); X.restore(); };
    parts[parts.length - 1].strokeOnly = () => polyP(out); }
  // the belly, as the 3D model's: a pale ellipsoid pressed into the body, seen only where its surface lies outside the
  // body's blobs (from the side a strip along the underside, from the front the bottom of the chest, from above nothing).
  // Traced as a smooth outline: its viewer-facing half, laid out polar (ρ from the silhouette rim at 1 in to the middle at
  // 0, round by φ); along each spoke the visible run starts at the rim and ends where it enters the body (found by
  // bisection). Its whole ellipse joins the silhouette (where it pokes below the body, that's the outline).
  { const B = [0.02 * s1, 0.46 * s2, 0, 0.62 * s1, 0.2 * s2, 0.34 * s1];
    const bodies = [[-0.52 * s1, 0.72 * s2, 0.36 * s1, 0.36 * s2, 0.4 * s1], [-0.12 * s1, 0.74 * s2, 0.62 * s1, 0.42 * s2, 0.44 * s1], [0.28 * s1, 0.8 * s2, 0.5 * s1, 0.46 * s2, 0.46 * s1]];
    const hv = [(fx + fy) / Math.SQRT2 * cos(Math.PI / 6), sin(Math.PI / 6), (sx + sy) / Math.SQRT2 * cos(Math.PI / 6)];  // toward the viewer (model), the iso 30°
    const hb2 = [hv[0] * cp + hv[1] * spc, -hv[0] * spc + hv[1] * cp, hv[2]];                                          // … in the body frame
    // the unit-sphere frame: w the facing pole (a surface point u faces the viewer when u·w > 0), e1/e2 across it
    let w = [hb2[0] / B[3], hb2[1] / B[4], hb2[2] / B[5]]; const wl = Math.hypot(...w); w = w.map(v => v / wl);
    const ax = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    let e1 = cr(w, ax); const l1 = Math.hypot(...e1); e1 = e1.map(v => v / l1); const e2 = cr(w, e1);
    const at = (r, f) => { const c = cos(f) * r, sn = sin(f) * r, h = Math.sqrt(Math.max(0, 1 - r * r));
      return [0, 1, 2].map(n => B[n] + B[n + 3] * (c * e1[n] + sn * e2[n] + h * w[n])); };
    const seen = c => !bodies.some(([x, y, rx, ry, rz]) => ((c[0] - x) / rx) ** 2 + ((c[1] - y) / ry) ** 2 + (c[2] / rz) ** 2 < 1);
    const scr = (r, f) => pj(...bm(...at(r, f)));
    const inner = f => { let r = 1; while (r > 0 && seen(at(r - 0.05, f))) r -= 0.05; if (r <= 0) return 0;          // the run's inner end
      let lo = r - 0.05, hi = r; for (let n = 0; n < 7; n++) { const m = (lo + hi) / 2; if (seen(at(m, f))) hi = m; else lo = m; } return hi; };
    const NF = 72, fs = Array.from({ length: NF }, (_, n) => n / NF * TAU), rim = fs.map(f => seen(at(1, f)));
    const edge = (f0, f1) => { let lo = f0, hi = f1; const s0 = seen(at(1, f0)); for (let n = 0; n < 7; n++) { const m = (lo + hi) / 2; if (seen(at(1, m)) === s0) lo = m; else hi = m; } return (lo + hi) / 2; };
    const loops = [];
    if (rim.every(Boolean)) {                                                    // the whole rim shows (seen head-on): the ellipse, less any hidden middle
      const inn = fs.map(inner); loops.push(fs.map(f => scr(1, f)));
      if (inn.some(r => r > 0.02)) loops.push(fs.map((f, n) => scr(inn[n], f)).reverse());
    } else if (rim.some(Boolean)) {                                              // runs of spokes whose rim shows: rim out, inner ends back
      const k0 = rim.indexOf(false);
      for (let j = 0; j < NF; j++) { const k = (k0 + j) % NF; if (!rim[k] || rim[(k + NF - 1) % NF]) continue;
        const run = []; let m = k; while (rim[m % NF] && run.length < NF) { run.push(m % NF); m++; }
        const fa = edge(fs[(k + NF - 1) % NF] + (k === 0 ? -TAU : 0), fs[k]), fb = edge(fs[(m - 1) % NF], fs[(m - 1) % NF] + TAU / NF);
        const out = [scr(1, fa)], back = [];
        for (const q of run) { out.push(scr(1, fs[q])); back.push(scr(inner(fs[q]), fs[q])); }
        loops.push(out.concat([scr(1, fb)], back.reverse())); }
    }
    const [ecx, ecy, ea, eb, erot] = ellOf(bm, B[0], B[1], B[2], B[3], B[4], B[5]);
    // (loops drawn as given — a hidden middle is wound against the rim, so nonzero fill leaves it a hole)
    const lp = L => { X.moveTo(L[0][0], L[0][1]); for (let n = 1; n < L.length; n++) X.lineTo(L[n][0], L[n][1]); X.closePath(); };
    if (loops.length) parts.push({ col: C.belly, d: bodyD + 0.02, strokeOnly: () => ellP(ecx, ecy, ea, eb, erot), path: () => { for (const L of loops) lp(L); } }); }
  // tail: from inside the haunch, three joints (their swing turning it sideways, their lift bending it), the spade
  { let x = -0.8, y = 0.74, z = 0, yaw = 0, pit = 0;
    grp = 'tail'; tube(C.body, bm(-0.45, 0.74), bm(-0.8, 0.74), 0.34, 0.26);
    [[-0.6, -0.16, 0.26, 0.17], [-0.6, -0.2, 0.17, 0.1], [-0.55, 0.02, 0.1, 0.05]].forEach(([dx, dy, r0, r1], k) => {
      yaw += P.tail[k]; pit += P.tailZ[k]; const L = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) + pit;
      const nx = x + cos(ang) * L * cos(yaw), ny = y + sin(ang) * L, nz = z + L * sin(yaw);
      tube(C.body, bm(x, y, z), bm(nx, ny, nz), r0, r1); x = nx; y = ny; z = nz; }); grp = null;
    // the spade, as the 3D one: a dark arrowhead on the tail's tip pointing on along it — a flattened cone (its
    // base round the tip, 0.13 across, its point 0.3 on), the outline of its projected corners, so it reads from any side
    const back = [-cos(pit) * cos(yaw), -sin(pit), sin(yaw)], bl = Math.hypot(...back); back.forEach((v, n) => back[n] = v / bl);
    const up0 = [0, 1, 0], sdv = [back[1] * up0[2] - back[2] * up0[1], back[2] * up0[0] - back[0] * up0[2], back[0] * up0[1] - back[1] * up0[0]];
    const sl = Math.hypot(...sdv) || 1; sdv.forEach((v, n) => sdv[n] = v / sl);
    const upv = [sdv[1] * back[2] - sdv[2] * back[1], sdv[2] * back[0] - sdv[0] * back[2], sdv[0] * back[1] - sdv[1] * back[0]];
    const at = (d, a, b2) => bm(x + back[0] * d + sdv[0] * a + upv[0] * b2, y + back[1] * d + sdv[1] * a + upv[1] * b2, z + back[2] * d + sdv[2] * a + upv[2] * b2);
    const cone = [at(0.3, 0, 0)]; for (let n = 0; n < 8; n++) { const t = n / 8 * TAU; cone.push(at(-0.02, cos(t) * 0.1, sin(t) * 0.14)); }
    const cp2 = hull2(cone.map(m => pj(...m)));
    add(C.plate, cone.reduce((a, m) => a + depth(m[0], m[2]), 0) / cone.length + 0.02, () => polyP(cp2)); }
  // neck and head: the neck swings by P.neck, turns by P.neckY (a yaw at its root), the head by P.head, the jaw by P.jaw
  const nr = P.neck, ny = P.neckY;
  const nk = (x, y) => { const lx = x * cos(nr) - y * sin(nr), ly = x * sin(nr) + y * cos(nr); return bm(0.6 + lx * cos(ny), 0.95 + ly, -lx * sin(ny)); };
  const hr = nr + P.head, hb = [0.5 * cos(nr) - 0.78 * sin(nr), 0.5 * sin(nr) + 0.78 * cos(nr)];
  const hdp = (x, y, z = 0) => { const lx = hb[0] + x * cos(hr) - y * sin(hr), ly = hb[1] + x * sin(hr) + y * cos(hr); return bm(0.6 + lx * cos(ny) - z * sin(ny), 0.95 + ly, -lx * sin(ny) + z * cos(ny)); };
  const jaw2 = Math.min(0.6, P.jaw), jr = hr - jaw2, jb = [0.08, -0.12];                             // (as the 3D jaw, capped: never gaping into a big pale patch)
  const jwp = (x, y, z = 0) => { const hx = jb[0] + x * cos(jr - hr) - y * sin(jr - hr), hy = jb[1] + x * sin(jr - hr) + y * cos(jr - hr); return hdp(hx, hy, z); };
  { const pts = [[-0.25, -0.2], [0, 0], [0.18, 0.3], [0.3, 0.58], [0.42, 0.74]].map(q => nk(...q)), r = [0.3, 0.26, 0.22, 0.18, 0.15];
    grp = 'neck'; for (let i = 0; i < 4; i++) tube(C.body, pts[i], pts[i + 1], r[i], r[i + 1]); }
  // the mouth, simply: the pale lower jaw (as the 3D model's) swings down on its hinge under the snout — a rigid oval
  // turning, nothing else drawn, so it never stretches or warps as it opens
  { const [cx, cy, a2, b2, rot] = ellOf(jwp, 0.2, -0.02, 0, 0.2, 0.045, 0.09), sm = hdp(0.32, -0.02);   // the jaw: always just behind the snout
    add(C.belly, depth(sm[0], sm[2]) - 0.005, () => ellP(cx, cy, a2, b2, rot)); }                     // (it hangs under it: the snout covers its top from every side)
  grp = 'face';                                                                                       // (its own band: in the neck's it'd fall inside the neck)
  blobF(C.body, hdp, 0.06, 0.02, 0, 0.24, 0.19, 0.2);                                                // skull
  blobF(C.body, hdp, 0.32, -0.02, 0, 0.24, 0.12, 0.14); grp = null;                                  // snout
  // the horns, exactly the 3D model's: an even round tube (radius 0.042, round-ended) along its curve from the top back
  // of the skull, both of them, each sorted by its own depth (the far one's root tucks behind the skull, as in 3D)
  for (const zs of [-1, 1]) { const q = t => hdp((1 - t) ** 2 * -0.02 + 2 * (1 - t) * t * -0.15 + t * t * -0.28, (1 - t) ** 2 * 0.15 + 2 * (1 - t) * t * 0.27 + t * t * 0.25,
      zs * ((1 - t) ** 2 * 0.1 + 2 * (1 - t) * t * 0.15 + t * t * 0.19));
    for (let k = 0; k < 3; k++) tube(C.horn, q(k / 3), q((k + 1) / 3), 0.042, 0.042); }
  // legs: the shared reach in the body frame (x, y), each on its side (z), splaying out as it lies down
  const leg = (i, z) => {
    const hind = i < 2, L = DRAGON_LEG[hind ? 'hind' : 'fore'], hx = hind ? -0.45 : 0.36, hy = 0.62, st = dragonStride(a.phase, i);
    const hw = bm(hx, hy), tw = [hw[0] + st.x * DRAGON_STRIDE * P.g, DRAGON_FOOT + DRAGON_LIFT * 1.8 * st.up * P.g];
    const bx = tw[0] - P.bodyX, by = tw[1] - P.bodyY; let tx = bx * cp + by * spc - hx, ty = -bx * spc + by * cp - hy;
    if (!hind && P.reach > 0.2) { const pw = P.ck * 5.5 + (z > 0 ? 0 : Math.PI), px = 0.2 + 0.14 * sin(pw), py = -0.3 + 0.1 * cos(pw), w = Math.min(1, (P.reach - 0.2) * 2);
      tx += (px - tx) * w; ty += (Math.max(ty, py) - ty) * w; }
    let [h, k] = dragonLegIK(L, tx, ty); const T = DRAGON_TUCK[hind ? 'hind' : 'fore']; h += (T.hip - h) * P.lie; k += (T.knee - k) * P.lie;
    const kx = hx + sin(h) * L.th, ky = hy - cos(h) * L.th, ax = kx + sin(h + k) * L.sh, ay = ky - cos(h + k) * L.sh;
    const out = T.out * P.lie * Math.sign(z) * 0.5, zk = z + out * 0.6, za = z + out;
    const col = C.body, r0 = hind ? 0.17 : 0.13, r1 = hind ? 0.11 : 0.095; grp = 'leg' + i;
    blob(col, bm(hx, hy - 0.03, z), hind ? 0.21 : 0.16, hind ? 0.22 : 0.17, hind ? 0.17 : 0.14);   // the haunch / shoulder at the leg's top (as 3D)
    tube(col, bm(hx, hy, z), bm(kx, ky, zk), r0, r1, -0.05); tube(col, bm(kx, ky, zk), bm(ax, ay, za), r1, 0.065, -0.04);
    const A = bm(ax, ay, za), fa = -P.pitch + dragonStride(a.phase, i).roll * P.g * (1 - P.lie);
    const ft = (x, y) => [A[0] + x * cos(fa) - y * sin(fa), A[1] + x * sin(fa) + y * cos(fa), za];      // the foot, flat on the ground
    const toe = (hind ? 1.25 : 0.35) * P.lie * Math.sign(z);                                            // lying, the toes turn out to its side (as 3D)
    const fF = (x, y, z2) => { const q = ft(x * Math.cos(toe), y); return [q[0], q[1], za + z2 + x * Math.sin(toe)]; }; // the foot's frame (turned with it)
    blobF(col, fF, 0.07, -DRAGON_FOOT * 0.5, 0, 0.17, DRAGON_FOOT * 0.55, 0.14); grp = null;         // a broad round foot
    for (const cz of [-0.06, 0.06]) tube(C.horn, fF(0.19, -DRAGON_FOOT * 0.62, cz), fF(0.27, -DRAGON_FOOT * 0.95, cz * 1.15), 0.04, 0.014, 0.02); // two fat claws
  };
  leg(0, -0.34); leg(1, 0.34); leg(2, -0.32); leg(3, 0.32);
  // wings: the shared joints; the plane stood up by its angle, out from its side as it spreads
  const wingAng = P.wingAng ?? (1.35 + (0.35 + 0.6 * P.rr + P.beat - 1.35) * P.open) * (1 - P.sl) + (0.45 + P.chest * 1.5) * P.sl;
  for (const sd of [-1, 1]) {
    const J = dragonWingJoints(1 - P.open, P.sl, sd), up = sin(wingAng), outw = cos(wingAng);
    const at = q => bm(0.1 + q[0], 1.08 + q[1] * up, sd * (0.32 + q[1] * outw));
    const Q = {}; for (const k in J) Q[k] = at(J[k]);
    const fo = Math.max(0, Math.min(1, (P.open - 0.15) / 0.35));                                       // folded: one clean fold; the hand opens out of it
    const n0 = parts.length; grp = 'wing' + (sd > 0 ? 1 : 0);                                        // (the membrane's band: along its trailing edge)
    poly(C.membrane, [Q.S, Q.E, Q.W, fo > 0 ? Q.F2 : Q.W, Q.M3, Q.B], 0.05 * sd);
    if (fo > 0) poly(C.membrane, [Q.W, Q.F0, Q.M01, Q.F1, Q.M23, Q.F2], 0.05 * sd); grp = null;
    tube(C.bone, Q.S, Q.E, 0.045, 0.04, 0.06 * sd); tube(C.bone, Q.E, Q.W, 0.04, 0.032, 0.06 * sd);
    for (const f of ['F0', 'F1', 'F2']) tube(C.bone, Q.W, Q[f], 0.024, 0.018, 0.06 * sd);          // dark bones rim the wing (as 3D): its edge reads even folded
    // (it's rooted on top of the back: the far wing too stands over the barrel, so it never sorts behind it — its
    // root stays attached to the body instead of the membrane floating free above it)
    // the far one (by where its root sits, this view) just under the back plates, the near one over them
    const r0 = at([0, 0]), r1 = bm(0.1, 1.08, -sd * 0.32), far = depth(r0[0], r0[2]) < depth(r1[0], r1[2]);
    for (let n = n0; n < parts.length; n++) parts[n].d = Math.max(parts[n].d, bodyD + (far ? 0.03 : 0.045));
  }
  // the flame: a flickering cone from the jaws along the head's line — a part like the rest, sorted just past the mouth
  // (seen from behind, the head and body cover it; from the front it's over everything), never outlined
  if (P.flame > 0 && !window._maskDraw) {
    const len = 2.1 * P.flame, f0 = pj(...jwp(0.45, 0.02)), f1 = pj(...jwp(0.45 + len, 0.02)), fm = jwp(0.75, 0.02);
    const dx = f1[0] - f0[0], dy = f1[1] - f0[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny2 = dx / l, fl = n => sin(P.ck * 30 + n * 2.1) * 1.5;
    const cone = (col, w, k) => { const tx = f0[0] + dx * k, ty = f0[1] + dy * k; X.fillStyle = col; X.beginPath(); X.moveTo(f0[0], f0[1]);
      X.quadraticCurveTo(f0[0] + dx * k * 0.5 + nx * w * 0.5, f0[1] + dy * k * 0.5 + ny2 * w * 0.5 + fl(1), tx + nx * w, ty + ny2 * w + fl(2));
      X.quadraticCurveTo(tx + dx / l * 3, ty + dy / l * 3 + fl(3), tx - nx * w, ty - ny2 * w + fl(4));
      X.quadraticCurveTo(f0[0] + dx * k * 0.5 - nx * w * 0.5, f0[1] + dy * k * 0.5 - ny2 * w * 0.5 + fl(5), f0[0], f0[1]); X.closePath(); X.fill(); };
    parts.push({ d: depth(fm[0], fm[2]), draw: () => { X.save(); X.globalAlpha *= 0.9; cone('#c8280a', 0.5 * K, 1); cone('#ff8a1e', 0.34 * K, 0.85); cone('#ffe36a', 0.18 * K, 0.6); X.restore(); } });
  }
  // --- paint: every part stroked black (the silhouette), then filled far to near (flat colours: kept simple) ---
  parts.sort((p, q) => p.d - q.d);
  // the bear's idiom, lightly: a flat darker band along each group's underside — the group's outline less itself lifted
  // (trunk, neck+head, tail, each leg: one band per group, so tube joints don't scallop). Masked on a scratch canvas,
  // laid on as its group's nearest part is painted (nearer parts then cover it).
  const last = new Map(); for (const pt of parts) if (pt.g) last.set(pt.g, pt);
  const shadeGroup = g => { if (window._maskDraw) return;
    const ms = parts.filter(p => p.g === g && p.bb && (p.col === C.body || p.col === C.dark || p.col === C.membrane)); if (!ms.length) return;
    const lift = DRAGON_SHADE[g.replace(/\d/, '')] * K, m = X.getTransform();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ms) for (const [u, v] of [[p.bb[0], p.bb[1]], [p.bb[2], p.bb[1]], [p.bb[0], p.bb[3]], [p.bb[2], p.bb[3]]]) {
      const dx = m.a * u + m.c * v + m.e, dy = m.b * u + m.d * v + m.f; x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy); }
    x0 = Math.floor(x0) - 2; y0 = Math.floor(y0) - 2; const w = Math.ceil(x1) + 2 - x0, h = Math.ceil(y1) + 2 - y0;
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return;
    const dragonShadeC = bandCanvas(w, h), O = dragonShadeC.getContext('2d'), X0 = X; O.setTransform(1, 0, 0, 1, 0, 0); O.clearRect(0, 0, w, h);
    O.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0); X = O;                                   // (the path helpers draw on X)
    try { O.fillStyle = DRAGON_SHADE.col; O.beginPath(); for (const p of ms) p.path(); O.fill();
      O.globalCompositeOperation = 'destination-out';
      // parts already painted in front of a group member (a horn over the skull) keep their colour: cut from the band
      const d0 = Math.min(...parts.filter(p => p.g === g).map(p => p.d)), upto = parts.indexOf(last.get(g));
      O.beginPath(); for (let j = 0; j < upto; j++) { const p = parts[j]; if (p.g !== g && p.d > d0 && !p.clip && (!p.draw || p.strokeOnly)) (p.strokeOnly || p.path)(); } O.fill();
      O.translate(0, -lift); O.beginPath(); for (const p of ms) p.path(); O.fill();
      O.globalCompositeOperation = 'source-over'; } finally { X = X0; }
    X.save(); X.setTransform(1, 0, 0, 1, 0, 0); X.globalAlpha *= DRAGON_SHADE.alpha; X.drawImage(dragonShadeC, 0, 0, w, h, x0, y0, w, h); X.restore(); };
  X.lineJoin = 'round'; X.strokeStyle = '#000'; X.lineWidth = 2.2 / UNIT_SCALE;
  for (const pt of parts) if (!pt.clip && (!pt.draw || pt.strokeOnly)) { X.beginPath(); (pt.strokeOnly || pt.path)(); X.stroke(); }
  for (const pt of parts) {
    if (pt.draw) { pt.draw(); continue; }
    if (pt.clip) { X.save(); X.beginPath(); pt.clip(); X.clip(); X.fillStyle = pt.col; X.beginPath(); pt.path(); X.fill(); X.restore(); continue; }
    X.fillStyle = pt.col; X.beginPath(); pt.path(); X.fill();
    if (pt.g && last.get(pt.g) === pt) shadeGroup(pt.g);
    if (pt.seam) { X.save(); X.strokeStyle = pt.col; X.lineWidth = 0.8; X.stroke(); X.restore(); }  // (closes the hairline seams between cells)
  }
  // the eyes: each set in its side of the skull, looking out sideways and a little forward (turned with the head). An
  // eye shows when it looks toward the viewer — and the far one only when the head faces the viewer nearly head-on
  // (the eyes side by side in depth); otherwise the skull hides it. A plain yellow dot on the skull's surface.
  // shut (asleep, a blink) it squashes to a thin slit along the head, as the 3D eye's scale.y
  { const o0 = hdp(0, 0, 0), dirD = v => { const m = hdp(...v); return depth(m[0] - o0[0], m[2] - o0[2]) + (m[1] - o0[1]) * 0.5; }; // (+ up: the view looks down)
    const E = zs => hdp(0.17, 0.08, zs * 0.16), dE = zs => { const m = E(zs); return depth(m[0], m[2]); };
    for (const zs of [-1, 1]) {
      if (dirD([0.35, 0.1, zs * 0.93]) < 0.3) continue;                                             // looking away
      if (dE(zs) < dE(-zs) && dE(-zs) - dE(zs) > 0.09) continue;                                     // the far eye, behind the skull
      const [ex, ey] = pj(...E(zs)), [fx2, fy2] = pj(...hdp(0.3, 0.08, zs * 0.16)), rot = Math.atan2(fy2 - ey, fx2 - ex);
      X.fillStyle = C.eye; X.beginPath(); X.ellipse(ex, ey, 1.1 + 0.3 * P.eyeShut, Math.max(0.35, 1.1 * (1 - 0.92 * P.eyeShut)), fx2 === ex ? 0 : rot, 0, TAU); X.fill();
    } }
  X.restore();
}

// Sheep body — the last self-contained archetype block; see drawBearBody.
// A grazing sheep's tiny grass puffs (not in the outline mask pass — a SELECTED grazing sheep would double-spawn them).
// Counter-advance guard (the workSwingCycles pattern): a bare tick%N renders the same tick 2-3 rAF frames in a row.
function sheepGrazePuffs(e){
  if (!e.eatingGrass) return;
  let gcyc = Math.floor(tick / T30(24));
  if (!window._maskDraw && grazeCycles.get(e.id) !== gcyc) { grazeCycles.set(e.id, gcyc); spawnParticles(e.x + (e.facing * 0.25), e.y + 0.1, '#4e8c2d', 1, 0.008, 0.9); }
}

function drawUnit(e){
  if(e.garrisonedIn)return; // hidden inside a building
  const faceOnView = e.dir === 1 || e.dir === 5; // S/N — forward is the view axis
  // the per-dir rig bases, fixed for the whole draw: F = the facing's
  // screen projection, R = the lateral (unit-right) axis
  const F = RIG[e.dir], R = RIG[(e.dir + 2) & 7];
  let scr=mapToScreen(e.x,e.y);
  let sx=Math.round(scr.sx), sy=Math.round(scr.sy+HALF_TH);
  if(isOffscreen(sx,sy,50))return;
  // Group spread: offset based on unit ID so stacked units are visible
  let { ox, oy } = getUnitGroupOffset(e.id);
  sx += ox; sy += oy;

  // Shadow — not part of the body silhouette: the outline mask pass must
  // skip it or the selection ring traces the shadow blob too.
  if(!window._maskDraw){
    // Every unit — ram included — uses the shared drawUnitShadow, which
    // projects a per-type ground oval through the real iso transform and
    // rotates it to the unit's facing. So a horse (or ram) in profile
    // casts a long flat shadow, head-on a shorter rounder one, and the
    // diagonal facings (SE/SW/NW/NE) a properly TILTED one. (The villager rig's corpse lies down: no standing shadow
    // once it goes over.)
    // (a villager stepped into its work spot casts it there: villagerWorkSpot's drawn spot)
    const S = e.utype === 'villager' && vil2DState.get(e.id), wdx = S && S.wx != null ? S.wx - e.x : 0, wdy = S && S.wy != null ? S.wy - e.y : 0;
    if (!(e.__deathAge > DIE.buckle)) drawUnitShadow(e, sx + (wdx - wdy) * HALF_TW, sy + (wdx + wdy) * HALF_TH);
  }

  // Smart Face Direction: defaults to right, automatically flips based on movement or target location
  if(e.facing===undefined) e.facing = 1;
  let tx = -1, ty = -1;
  // Facing priority: the PATH wins while the unit is actually walking —
  // facing the target first made a unit on a detour route (pathing around a
  // wall/forest toward a target on the far side) moonwalk: body toward the
  // target, feet going the other way (repro: aoe2-game-test01.json, knight
  // walking E around an obstacle while facing its ram target to the W).
  // AoE2 units face their travel direction in transit and square up to the
  // target only when the walk ends (in range / at the work site).
  if(e.path && e.path.length > 0){
    // the current leg's own line (its start to its end): steady the whole leg, never a turn further on
    const fx = e.fromX ?? e.x, fy = e.fromY ?? e.y, lx = e.path[0].x - fx, ly = e.path[0].y - fy;
    if (lx || ly) { tx = e.x + lx; ty = e.y + ly; } else { tx = e.path[0].x; ty = e.path[0].y; }
  } else if(e.target){
    let t = entitiesById.get(e.target);
    if(t) { tx = t.x; ty = t.y; }
  } else if(e.buildTarget){
    let t = entitiesById.get(e.buildTarget);
    if(t) { tx = t.x; ty = t.y; }
  } else if(e.gatherX !== undefined && e.gatherY !== undefined && e.task && e.task !== 'return'){
    tx = e.gatherX + 0.5;
    ty = e.gatherY + 0.5;
  }
  if(e.facingNorth===undefined) e.facingNorth = false;
  let dx = 0, dy = 0;
  if(e.faceAng!==undefined){ tx = e.x + Math.cos(e.faceAng); ty = e.y + Math.sin(e.faceAng); } // the dragon faces its own slow heading (its fire goes that way)
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
    let dir = spriteDir(dx, dy);
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

    setFacingFromDir(e, dir);
  }
  e.lastX = e.x;
  e.lastY = e.y;

  // (every body bobs with its own step: the rigs' gaits, the ram's rolling sway)
  X.save();
  X.translate(sx, sy);
  X.scale(e.facing * UNIT_SCALE, UNIT_SCALE);

  // --- DRAW FLIPPABLE STUFF ---
  if(e.utype==='sheep_carcass'){
    drawSheep2D(e);
  } else if(e.utype==='ram'){
    drawRamBody(e);
  } else if(e.utype==='tradecart'){
    drawTradeCartBody(e);
  } else if(e.utype==='bear'){
    drawBearBody(e);
  } else if(e.utype==='dragon'){
    drawDragonBody(e);
  } else if(e.utype!=='sheep'){
    drawPerson2D(e);
  } else {
    drawSheep2D(e); sheepGrazePuffs(e);
  }

  X.restore(); // restore to absolute coordinates so text and UI aren't mirrored

  // Idle indicator — part of the unit's SHAPE, so it draws in the mask pass
  // too: the selection ring wraps it and the behind-building silhouette shows
  // it (spot an idle villager hidden behind a building). Keep showing while
  // walking, as long as no task/target is actually assigned (a bare move order
  // isn't "working"). Absolute coords — not under UNIT_SCALE. A HUD cue, so
  // the 3D eye view (window._povDraw, js/pov3d.js) leaves it out.
  if(e.team===myTeam&&e.utype==='villager'&&!e.task&&!e.target&&e.__deathAge==null&&!window._povDraw){
    X.fillStyle='#ffd700';X.strokeStyle='#000';X.lineWidth=2;
    X.font='bold 16px sans-serif';X.textAlign='center';
    X.strokeText('?',sx,sy-20*UNIT_SCALE);
    X.fillText('?',sx,sy-20*UNIT_SCALE);
  }

  // Remaining floating overlays (the HP bar) are NOT part of the body
  // silhouette — skip them in the mask pass, or a wounded selected unit gets a
  // detached gold ring hovering around its HP bar rectangle.
  if(window._maskDraw) return;

  // HP bar floats clear above the head (higher for the scout — horse and
  // rider stand taller) so it never covers the unit's face.
  if(e.hp<e.maxHp){
    let bx = e.utype==='dragon' ? sx + 40*UNIT_SCALE*(e.facing||1) : sx;   // (the dragon's over its head, which leads)
    let hpTop = e.utype==='dragon' ? sy-80*UNIT_SCALE : (isMountedUnit(e.utype)||e.utype==='tradecart') ? sy-40*UNIT_SCALE : sy-30*UNIT_SCALE; // (the dragon's: over its raised head)
    X.fillStyle='#000000';X.fillRect(bx-9,hpTop,18,5);
    X.fillStyle='#300';X.fillRect(bx-8,hpTop+1,16,3);
    X.fillStyle=e.hp/e.maxHp>0.5?'#0c0':'#c00';X.fillRect(bx-8,hpTop+1,16*e.hp/e.maxHp,3);
  }
  // A loaded ram flies a small team flag + rider count (own team only) so you
  // can see at a glance it's manned — the unit-side echo of the building
  // garrison-count flag (render-buildings.js).
  if(e.utype==='ram' && e.team===myTeam && e.garrison && e.garrison.length>0){
    // Plant the pole base at the ram body's center so the flag reads as
    // stuck IN the ram (not floating above it), cloth flying clear of the roof.
    let bh=14, poleLen=28;
    drawWavingFlag(sx, sy, bh, teamColor(e.team), teamColorDark(e.team), poleLen);
    let label=String(e.garrison.length);
    let fy=sy-bh-2-poleLen; // pole top (matches drawWavingFlag's `top`)
    X.font='bold 12px sans-serif';X.textAlign='left';
    let tw=X.measureText(label).width+9;
    X.fillStyle='rgba(0,0,0,0.6)';X.fillRect(sx+3,fy-2,tw,15);
    X.fillStyle='#ffd700';X.fillText(label,sx+7,fy+9);
    X.textAlign='left';
  }
  // Selection is drawn separately, in drawUnitOutlines() — a final
  // pass after every building this frame, so it stays visible even when a
  // building is painted over this unit later in the depth sort (see there
  // for why: this codebase has no z-buffer, just one Y-sorted paint pass).
}

