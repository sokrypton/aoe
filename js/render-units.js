// Mounted units share the scout's horse rendering; the knight swaps the
// coat/rider styling (see the knight accents in the shared branches).
function isMountedUnit(t){ return t === 'scout' || t === 'knight'; }

// Accent metal by the owner's FORGE tier (forging/iron_casting): crude
// grey -> steel -> polished. Every metal piece a soldier wears (helm,
// shield metal, scale rows) shows the blacksmith's quality; SHAPES
// (kettle vs Norman helm) stay age-driven via the unitEquipment tables.
const FORGE_METAL = ['#8f8a7d', '#a8adb3', '#c6cdd8'];

// ---- equipment loadout ----
// Cosmetic gear for SOLDIER units, selected from (utype, owner age, owner
// techs): what this unit visibly wears. Read-only view of sim state
// (teamAge/teamTechs) — never feeds a sim decision, never written to `e`
// (entities are wholesale-replaced on MP sync; the outline mask pass
// re-calls drawUnit and relies on draws being pure).
const EQUIP_TECHS = ['forging','iron_casting','scale_armor','chain_mail','fletching'];
const EQUIP_TECH_MASK = techMask(EQUIP_TECHS);
const equipCache = new Map();
function unitEquipment(e){
  if(!MILITARY.has(e.utype)) return null;
  let age = ageBonus(e.team);
  let techs = (teamTechs && isPlayerTeam(e.team) ? teamTechs[e.team] : 0) & EQUIP_TECH_MASK;
  let key = e.utype + '|' + age + '|' + techs; // + future per-unit tier
  let v = equipCache.get(key);
  if(v) return v;
  // Tiers come from the SAME helpers the sim uses (spawn attack / live
  // armor), so the drawn gear can never drift from the stats it signals.
  let atk = upgradeAtkBonus(e.team), arm = upgradeArmorBonus(e.team);
  v = {
    metal: FORGE_METAL[atk],
    // Armor line reads on the torso: plain tunic → scale rows → chain mail.
    torso: arm >= 2 ? 'chain' : arm >= 1 ? 'scale' : null,
    // Attack line reads on the weapon: base → forged (1) → iron-cast (2).
    weapon: atk,
    fletched: hasUpgrade(e.team, 'fletching'),
    helmet: null, shield: null, quiver: false,
  };
  switch(e.utype){
    case 'militia':
      // helmetless tiers wear the team cap — ONE bare-head read for all
      // military (matches archer/scout)
      v.helmet = age >= 2 ? 'norman' : age === 1 ? 'kettle' : 'hood-team';
      v.shield = age >= 2 ? 'kite' : age === 1 ? 'round' : null;
      break;
    case 'spearman':
      v.helmet = age >= 2 ? 'norman' : 'kettle';
      break;
    case 'archer':
      v.helmet = 'hood-team'; // team-color cap at every age — the archer's team tell
      v.feather = v.fletched; // fletching pin, archer only (fletched is team-wide)
      v.quiver = age >= 2;    // the back quiver is the CASTLE-age mark
      break;
    case 'scout':
    case 'knight':
      v.helmet = e.utype === 'knight' ? 'greathelm' : age >= 2 ? 'spiked' : 'hood-team';
      v.shield = e.utype === 'knight' ? 'kite' : age >= 2 ? 'round' : null;
      break;
  }
  equipCache.set(key, v);
  return v;
}

// One painter per helmet design, front (face open) and back views. hx/hy are
// the human offsets, id feeds the feather's flutter phase; assumes
// strokeStyle '#000' / lineWidth 1 on entry (the torso pass contract) and
// leaves them that way.
// hturn = the head's lateral turn on screen (0 face-on, .707 on the
// diagonals, 1 in profile), from e.facing·RIG[dir].sx — the facing mirror
// puts the face side at +x, so hturn is never negative here and ONE
// profile variant serves both W and E. The crown/dome is ~spherical so
// it stays put; FACE-attached details (nose bar, ridge, eye slit, brim
// tilt) slide toward the facing by fx — the same rule the eyes follow —
// and profiles (hturn ≥ .9) get dedicated side reads. Lighting
// highlights are world-fixed (upper-left) and never shift.
function drawHelmet(v, hx, hy, back, team, id, hturn = 0){
  let tc = teamColor(team);
  let fx = hturn * 2.4;                    // face-detail lateral shift (matches the eyes)
  let prof = !back && hturn > 0.9;         // true side view (W/E)
  if (v.helmet === 'kettle') {
    // Iron kettle hat (chapel-de-fer): dome seated ON the head, brim
    // tilted BACK so it flares out BEHIND the dome — never a floating
    // halo over the brow, and the face/eyes stay fully open.
    X.fillStyle = v.metal;
    if (back) {
      // Dome first, brim ON TOP — seen from behind, the near side of the
      // brim crosses the head.
      X.beginPath();X.arc(hx,-15.2+hy,4,0,Math.PI*2);X.fill();X.stroke();
      X.beginPath();X.ellipse(hx,-13.9+hy,5.4,1.5,0,0,Math.PI*2);X.fill();X.stroke();
    } else if (prof) {
      // Profile: the brim is a disk seen EDGE-ON at the dome's base —
      // tilted BACK, so its FRONT rim foreshortens (short raised stub
      // over the brow) while the back rim trails long and low behind
      // the head: the board sits shifted rearward with a gentle slope.
      X.beginPath();X.arc(hx-0.2,-15.4+hy,3.9,Math.PI,0);X.fill();X.stroke();
      X.beginPath();X.ellipse(hx-0.8,-15.5+hy,5.2,0.85,-0.14,0,Math.PI*2);X.fill();X.stroke();
    } else {
      // Front: the BACK RIM (upper half-disk) flares behind the dome —
      // visible as brim wings past its sides at brow height; the brim
      // mass eases toward the back of the head as it turns.
      let bx = hx - fx*0.3;
      X.beginPath();X.ellipse(bx,-15.4+hy,5.6,1.7,0,Math.PI,0);X.closePath();X.fill();X.stroke();
      X.beginPath();X.arc(hx,-15.4+hy,3.9,Math.PI,0);X.fill();X.stroke();
      // hard line at the helm's base so the lower edge reads on the face
      X.beginPath();X.moveTo(hx-3.9,-15.4+hy);X.lineTo(hx+3.9,-15.4+hy);X.stroke();
    }
  } else if (v.helmet === 'norman') {
    // Norman iron helm: dome with ridge + highlight, riveted gold band,
    // nose bar (front hemisphere only, turning with the head).
    let cy0 = -15, bandY = back ? cy0 - 0.5 : cy0; // one crown height in EVERY view
    X.fillStyle = v.metal;
    X.beginPath();
    if (back) X.arc(hx,cy0+hy,4.5,0,Math.PI*2); else X.arc(hx,cy0+hy,4.5,Math.PI,0);
    X.fill();X.stroke();
    X.save();
    X.strokeStyle='rgba(0,0,0,0.22)';X.lineWidth=1/UNIT_SCALE;
    if (prof) {
      // side-on the center ridge descends the dome's FRONT curve
      X.beginPath();X.moveTo(hx+2.6,cy0-3.4+hy);X.quadraticCurveTo(hx+3.8,cy0-1.8+hy,hx+4.1,cy0-0.2+hy);X.stroke();
    } else {
      X.beginPath();X.moveTo(hx+fx,cy0-4.4+hy);X.lineTo(hx+fx,cy0+(back?-0.6:-0.2)+hy);X.stroke();
    }
    X.strokeStyle='rgba(255,255,255,0.5)';X.lineWidth=1.2/UNIT_SCALE;X.lineCap='round';
    X.beginPath();X.arc(hx,cy0+hy,3.3,Math.PI*1.15,Math.PI*1.55);X.stroke();
    X.lineCap='butt';X.restore();
    X.fillStyle='#daa520';
    X.beginPath();X.rect(hx-4.5,bandY+hy,9,1.5);X.fill();X.stroke();
    X.fillStyle='rgba(0,0,0,0.45)';
    [-3,0,3].forEach(rx=>{X.beginPath();X.arc(hx+rx,bandY+0.75+hy,0.4,0,Math.PI*2);X.fill();});
    if (!back) {
      // nose bar rides the head turn; in profile it's the thin guard
      // hanging edge-on off the helm's leading rim
      X.fillStyle=v.metal;
      if (prof) { X.beginPath();X.rect(hx+3.7,cy0+1.2+hy,1.2,2.8);X.fill();X.stroke(); }
      else { X.beginPath();X.rect(hx+fx-0.75,cy0+hy,1.5,4);X.fill();X.stroke(); }
    }
  } else if (v.helmet === 'greathelm') {
    // Blocky GREAT HELM — flat-topped box covering the whole face:
    // team-color plume, brighter crown band; front adds the face ridge,
    // dark eye slit and breath holes (all turning with the head).
    X.fillStyle=tc;
    X.beginPath();
    X.moveTo(hx-1.2,-18.5+hy);
    X.quadraticCurveTo(hx-2.2,-21.5+hy,hx,-22.3+hy);
    X.quadraticCurveTo(hx+2.2,-21.5+hy,hx+1.2,-18.5+hy);
    X.closePath();X.fill();X.stroke();
    X.fillStyle=v.metal;
    X.beginPath();X.rect(hx-4,-18.5+hy,8,7.5);X.fill();X.stroke();
    X.fillStyle='rgba(255,255,255,0.28)';
    X.fillRect(hx-4,-18.5+hy,8,1.6);
    if (!back && prof) {
      // Profile: the face plate is edge-on — a SHORT slit wraps the
      // leading corner and only the forward breath holes show; the
      // center ridge vanishes with the plate.
      X.fillStyle='#1c1c1c';
      X.fillRect(hx+1.4,-15.4+hy,2.6,1.2);
      X.fillStyle='rgba(0,0,0,0.45)';
      X.beginPath();X.arc(hx+2.1,-12.4+hy,0.4,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(hx+3.3,-12.4+hy,0.4,0,Math.PI*2);X.fill();
    } else if (!back) {
      X.strokeStyle='rgba(0,0,0,0.3)';X.lineWidth=1.1/UNIT_SCALE;
      X.beginPath();X.moveTo(hx+fx,-16.9+hy);X.lineTo(hx+fx,-11+hy);X.stroke();
      X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
      X.fillStyle='#1c1c1c';
      X.fillRect(hx+fx-2.6,-15.4+hy,5.2,1.2);
      X.fillStyle='rgba(0,0,0,0.45)';
      X.beginPath();X.arc(hx+fx-1.6,-12.4+hy,0.4,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(hx+fx,-12.4+hy,0.4,0,Math.PI*2);X.fill();
      X.beginPath();X.arc(hx+fx+1.6,-12.4+hy,0.4,0,Math.PI*2);X.fill();
    }
  } else if (v.helmet === 'spiked') {
    // Spiked cavalry helm — open face, small spike on top; distinct from
    // the knight's flat-topped great helm.
    let cy0 = -15, sb = -18.6; // one crown height in EVERY view
    X.fillStyle=v.metal;
    X.beginPath();
    X.moveTo(hx-0.8,sb+hy);
    X.lineTo(hx,sb-2.8+hy);
    X.lineTo(hx+0.8,sb+hy);
    X.closePath();X.fill();X.stroke();
    X.beginPath();X.arc(hx,sb-0.1+hy,0.9,0,Math.PI*2);X.fill();X.stroke(); // spike ball base
    X.beginPath();
    if (back) X.arc(hx,cy0+hy,4.2,0,Math.PI*2); else X.arc(hx,cy0+hy,4.2,Math.PI,0);
    X.fill();X.stroke();
    // hard BLACK line at the helm's lower edge so the boundary reads
    if (back) { X.beginPath();X.moveTo(hx-3.7,-13+hy);X.lineTo(hx+3.7,-13+hy);X.stroke(); }
    else { X.beginPath();X.moveTo(hx-4.2,cy0+hy);X.lineTo(hx+4.2,cy0+hy);X.stroke(); }
    X.save();
    X.strokeStyle='rgba(255,255,255,0.5)';X.lineWidth=1.1/UNIT_SCALE;X.lineCap='round';
    X.beginPath();X.arc(hx,cy0+hy,3,Math.PI*1.15,Math.PI*1.55);X.stroke();
    X.lineCap='butt';X.restore();
  } else {
    // Hoods: archer's green, everyone else's peasant leather.
    X.fillStyle = v.helmet === 'hood-team' ? tc : '#4a2e1b';
    X.beginPath();
    if (back) X.arc(hx,-15+hy,4.5,0,Math.PI*2); else X.arc(hx,-15+hy,4.5,Math.PI,0); // one crown height in EVERY view
    X.fill();X.stroke();
    if (prof && v.helmet !== 'hood-team') {
      // side-on the leather hood drapes down the NAPE behind the head
      // (the team CAP is brimless and close-fitting — no flap)
      X.beginPath();
      X.moveTo(hx-4.4,-15.2+hy);
      X.quadraticCurveTo(hx-5.5,-12.4+hy,hx-3.9,-10.4+hy); // outer drape curve
      X.quadraticCurveTo(hx-2.9,-11.6+hy,hx-3.2,-14.6+hy); // tucks back to the crown
      X.closePath();X.fill();X.stroke();
    }
    if (v.helmet === 'hood-team' && v.feather) {
      // Fletching tell: a tall team-color plume pinned in the cap, fluttering
      // gently (idle-anim idiom: tick + id phase) — the tech's only
      // always-visible mark, so it's deliberately exaggerated.
      let fy = 0; // crowns align in every view
      let sway = Math.sin(tick*0.12 + id*0.7)*0.16;
      X.save();
      X.translate(hx+fx*0.5, -18.6+fy+hy); X.rotate(0.08 + sway); // rides the crown as the head turns
      X.fillStyle=teamColorLight(team); // lighter than the cap so it pops
      X.beginPath();
      X.moveTo(0,0);
      X.quadraticCurveTo(-2.2,-3.6, -1.1,-7.6);  // outer edge up
      X.quadraticCurveTo(-0.1,-9.4, 1.4,-7.9);   // rounded tip
      X.quadraticCurveTo(1.7,-3.6, 0.9,-0.2);    // inner edge back down
      X.closePath();X.fill();X.stroke();
      // quill line up the middle
      X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8/UNIT_SCALE;
      X.beginPath();X.moveTo(0.1,-0.5);X.quadraticCurveTo(-0.5,-3.8, 0.1,-7.8);X.stroke();
      X.restore();
      X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
    }
  }
}

// Big readable broadsword, drawn with the context translated to the grip.
// Combat swing is shaped: slow overhead wind-up, fast slash (like the
// villagers' work swing) instead of a symmetric sine wobble.
// Shaped slash cycle shared by the sword and the arm that swings it:
// slow windup over the shoulder → whip-fast strike (ease-out cubic) with
// a small overshoot settle → smooth recovery back to guard.
function swordSwingAngle(e){
  // Rides the reload clock like the archer's draw and the bear's bite —
  // atkCooldown resets to rof ON the hit, so the phase sweeps through the
  // strike exactly as the sim deals damage (the +0.52 offset parks the
  // just-hit frame at the strike's end).
  let rof=(typeof UNITS!=='undefined' && UNITS[e.utype] && UNITS[e.utype].rof)||T30(60);
  let ph=(1-(e.atkCooldown||0)/rof+0.52)%1;
  if(ph<0.35){let t=ph/0.35;return 0.5+0.65*t*t;}                        // windup -> 1.15
  if(ph<0.52){let t=(ph-0.35)/0.17;return 1.15-2.5*(1-Math.pow(1-t,3));} // strike -> -1.35
  if(ph<0.68){let t=(ph-0.52)/0.16;return -1.35+0.25*t;}                 // settle -> -1.1
  let t=(ph-0.68)/0.32;return -1.1+1.6*(t*t*(3-2*t));                    // recover -> 0.5
}

// Should this unit be showing its attack/harvest ANIMATION right now? The
// animation must match what the sim actually DOES: the sim only deals damage /
// harvests when the unit is genuinely in range (see updateUnit — damageEntity
// gated by adjToBuilding / distToTarget<=range, harvest by SHEEP_HARVEST_RANGE).
// A looser gate ("has a target and is standing still") lets a unit that halted
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

// attack-tech steel ramp: 0 crude grey iron, 1 forged steel, 2 polished
const tierSteel = t => t >= 2 ? '#f2f6fb' : t >= 1 ? '#dde3ea' : '#a7abb0';
// two-stroke wooden shaft: black round-cap outline + timber core
function strokeShaft(x1, y1, x2, y2, wOut, wIn){
  X.strokeStyle='#000';X.lineWidth=wOut/UNIT_SCALE;X.lineCap='round';
  X.beginPath();X.moveTo(x1,y1);X.lineTo(x2,y2);X.stroke();
  X.strokeStyle='#8B4513';X.lineWidth=wIn/UNIT_SCALE;
  X.beginPath();X.moveTo(x1,y1);X.lineTo(x2,y2);X.stroke();
  X.lineCap='butt';
}
function drawBigSword(rot, tier = 0, edgeOn = false){
  // rot 0 = blade straight up; rest passes the seam's anim.restRot;
  // swings pass anim.swordRot so the blade is the ARM'S EXTENSION — it
  // continues the shoulder→grip line, never scissors against the arm.
  X.rotate(rot);
  // The anchor (= the gripping hand) sits at the CENTER of the handle —
  // grip runs local y 0..5.4, so shift the whole sword up half that along
  // the blade axis; swings then rotate about the fist, not the crossguard.
  // The art's blade axis is drawn at local x +0.5 — the −0.5 centers it
  // on the anchor so the fist sits exactly ON the blade line (visible at
  // the dead-center S rest, user caught it).
  X.translate(-0.5,-2.7);
  if (edgeOn){
    // The sword ROTATED 90° about its long axis — seen down the guard
    // (face-on idle: the flat rests against the leg, the camera sees the
    // EDGE): thin blade line, crossguard foreshortened to a nub. The
    // chop keeps the wide face — the edge leads a strike, turning the
    // flat toward the camera.
    let ext = tier >= 2 ? 3 : tier >= 1 ? 1.5 : 0;
    // THREE flat rectangles — grey blade, gold guard, brown grip (user
    // call: no round caps or beads; the edge-on sword is pure silhouette)
    X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
    X.fillStyle = tier >= 2 ? '#f2f6fb' : tier >= 1 ? '#dde3ea' : '#a7abb0';
    X.beginPath();X.rect(-0.3,-21-ext,1.6,19+ext);X.fill();X.stroke();
    X.fillStyle='#daa520';
    X.beginPath();X.rect(-1.2,-1.6,3.4,1.8);X.fill();X.stroke();
    X.fillStyle='#5c3d24';
    X.beginPath();X.rect(-0.3,0.2,1.6,5.2);X.fill();X.stroke();
    // (no pommel — simplified silhouette, user call)
    return;
  }
  X.strokeStyle='#000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
  // Same design as the barracks' crossed-swords emblem: parallel-edged
  // blade tapering to a point, rounded gold crossguard, leather grip,
  // gold pommel.
  // Blade tier (attack techs), dark→bright so the upgrade pops: 0 crude
  // grey iron, 1 forged steel (a touch longer), 2 iron-cast polish
  // (+fuller groove, longer again).
  let ext = tier >= 2 ? 3 : tier >= 1 ? 1.5 : 0;
  X.fillStyle = tierSteel(tier);
  X.beginPath();
  X.moveTo(-1.7,-2);X.lineTo(-1.4,-17-ext);X.lineTo(0.5,-22-ext);
  X.lineTo(2.4,-17-ext);X.lineTo(2.7,-2);X.closePath();X.fill();X.stroke();
  if(tier >= 2){ // fuller groove down the center
    X.strokeStyle='rgba(0,0,0,0.28)';X.lineWidth=0.9/UNIT_SCALE;
    X.beginPath();X.moveTo(0.5,-3.5);X.lineTo(0.5,-16.5-ext);X.stroke();
  }
  // FLAT rectangular crossguard (a rounded capsule read as tilted
  // toward the screen, user call)
  X.fillStyle='#daa520';X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
  X.beginPath();X.rect(-4.2,-1.6,9.4,1.8);X.fill();X.stroke();
  // Grip
  X.strokeStyle='#000';X.lineWidth=3/UNIT_SCALE;
  X.beginPath();X.moveTo(0.5,0);X.lineTo(0.5,5.6);X.stroke();
  X.strokeStyle='#5c3d24';X.lineWidth=1.6/UNIT_SCALE;
  X.beginPath();X.moveTo(0.5,0);X.lineTo(0.5,5.4);X.stroke();
  X.lineCap='butt';
  // (no pommel — simplified silhouette, user call)
}

// The spearman's long spear in drawBigSword's frame (the spearman rides
// the whole sword pose seam): rot 0 = shaft straight up, the anchor (=
// the gripping hand) 12 up from the butt — most of the spear above the
// fist. Butt +12 → head base −16 → tip −24 (total 36). k foreshortens
// the shaft along its own axis about the grip (a tilted thrust points
// into the iso depth — drawn full-length it overshoots both ways).
function drawBigSpear(rot, tier = 0, k = 1){
  X.rotate(rot);
  if (k !== 1) X.scale(1, k);
  X.strokeStyle='#000';X.lineWidth=3.2/UNIT_SCALE;X.lineCap='round';
  X.beginPath();X.moveTo(0,12);X.lineTo(0,-16);X.stroke();
  X.strokeStyle='#8B4513';X.lineWidth=1.6/UNIT_SCALE;
  X.beginPath();X.moveTo(0,12);X.lineTo(0,-16);X.stroke();
  X.lineCap='butt';
  // Spearhead tier (attack techs), dark→bright like the sword: 0 crude
  // grey iron, 1 forged steel (leaf head), 2 polished DIAMOND head.
  X.fillStyle = tierSteel(tier);
  X.strokeStyle='#000';X.lineWidth=1.1/UNIT_SCALE;X.lineJoin='round';
  if(tier >= 2){
    // diamond symmetric about the shaft: back overlaps the shaft end
    X.beginPath();X.moveTo(0,-15.2);X.lineTo(-2.5,-19.6);X.lineTo(0,-24);X.lineTo(2.5,-19.6);
    X.closePath();X.fill();X.stroke();
  } else {
    // leaf head: base corners at the shaft end ± perpendicular
    X.beginPath();X.moveTo(-2.8,-16);X.lineTo(0,-24);X.lineTo(2.8,-16);X.closePath();
    X.fill();X.stroke();
  }
}

// Recurve bow about the archer's grip anchor (+x = shoot direction). f is
// the flex: 0 braced rest, →1 at full draw (tips pull back and inward,
// limb curvature deepens), <0 during the forward release snap. Tier
// (attack techs) changes a DIFFERENT part per step — 0 pale selfbow,
// 1 laminated dark wood + leather-wrapped riser, 2 composite with in-path
// siyahs + horn nocks — while the string always attaches at the tips, so
// the nock/pull math is tier-invariant. Returns the tip position.
function drawRecurveBow(f, tier){
  // BIG dramatic recurve with a REAL-bow silhouette (user calls, both):
  // TALL limbs sweep back from the riser through a deep belly and curl
  // OUTWARD at the tips (an S per limb — cubic), while the string still
  // braces only ~4 behind the riser so the draw arm never overstretches
  // (the old deep-C put the brace ~7 back and the arm read rubber).
  let tx = 4.6 - 2.6*f, ty = 10.6 - 1.8*f;     // limb tips (string ends)
  let c1x = 5.6 + 0.8*f, c1y = 7.2 - 1.4*f;    // back-sweep (belly) control
  // tip-curl control PINNED to the tip (fixed offset): the flex bends the
  // BELLY only — a drawn recurve keeps its outward tip curls (user call);
  // an f-term here flattened the S at full draw. (The old tier-2 siyah
  // tip segments are gone — stacked on the built-in curls they kinked
  // the silhouette; the horn nocks carry the tier-2 read.)
  let c2x = tx - 2.2, c2y = ty - 1.0;
  const path = () => {
    X.beginPath();
    X.moveTo(tx, -ty);
    X.bezierCurveTo(c2x, -c2y, c1x, -c1y, 7.6, -2.6); // upper limb: curl out, sweep in
    X.quadraticCurveTo(8.5, 0, 7.6, 2.6);             // rigid riser (never flexes)
    X.bezierCurveTo(c1x, c1y, c2x, c2y, tx, ty);      // lower limb
  };
  const riser = () => {
    X.beginPath(); X.moveTo(7.6, -2.6); X.quadraticCurveTo(8.5, 0, 7.6, 2.6);
  };
  X.lineCap='round'; X.lineJoin='round';
  X.strokeStyle='#000'; X.lineWidth=3.4/UNIT_SCALE; path(); X.stroke();
  X.lineWidth=4.6/UNIT_SCALE; riser(); X.stroke();  // thicker handle
  let wood = tier >= 2 ? '#7d4a14' : tier >= 1 ? '#6e3d10' : '#b3874a';
  X.strokeStyle=wood; X.lineWidth=1.8/UNIT_SCALE; path(); X.stroke();
  X.strokeStyle = tier >= 1 ? '#c9a15e' : wood; X.lineWidth=2.8/UNIT_SCALE; riser(); X.stroke();
  if (tier >= 1) { // wrap ticks across the leather riser
    X.strokeStyle='#8a6a3a'; X.lineWidth=0.8/UNIT_SCALE;
    X.beginPath();
    X.moveTo(7.3,-1.2); X.lineTo(8.6,-1.2);
    X.moveTo(7.5,0);    X.lineTo(8.8,0);
    X.moveTo(7.3,1.2);  X.lineTo(8.6,1.2);
    X.stroke();
  }
  if (tier >= 2) { // horn nocks at the tips
    X.fillStyle='#ece4d2'; X.strokeStyle='#000'; X.lineWidth=1/UNIT_SCALE;
    X.beginPath(); X.arc(tx,-ty,1.1,0,Math.PI*2); X.fill(); X.stroke();
    X.beginPath(); X.arc(tx, ty,1.1,0,Math.PI*2); X.fill(); X.stroke();
  }
  X.lineCap='butt';
  return { tx, ty };
}

// Uniform size multiplier for every drawn character (units and corpses).
const UNIT_SCALE = 1.25;

// Rest grip anchors in the mirrored body frame — shared by the hand-pose
// seam, drawHeldLayer's translates, and drawCorpse's dropped-weapon HOLD
// table. (Scout/knight HOLD is a drop point, not a grip — stays local.)
const GRIP_REST = { militia:{x:6.5,y:-6}, spearman:{x:3,y:-6}, archer:{x:4,y:-8},
                    mountedRest:{x:5.5,y:-8.5} }; // swing grips orbit the shoulder (see the seam)
// Villager work-tool anchor: the handle rotates about this point and the
// gripping hand rides the same anchor (hand-pose seam) — one spelling so
// they can't drift, same contract as GRIP_REST.
// (tool anchor lives in RIG_MOUNTS.villager.tool — projected per dir
// at the seam as anim.toolRest)
// Carried-resource mount: the load rides OVERHEAD, centered above the
// head with both arms raised to steady it — identical in every
// direction by construction (user call: dir-independent and clear).
const CARRY_UP = 20.5;
// tasks whose walking villager pushes the (post-tech) wheelbarrow —
// resource gathering only; builders keep bare hands
const BARROW_TASKS = new Set(['chop', 'mine_gold', 'mine_stone', 'farm', 'forage']);
// Swing-orbit neutral pose (angle 0.5): constants of anchoring the orbit
// center onto GRIP_REST, so idle IS the swing's neutral frame (same
// grip, same side) and engage can't pop. The blade-angle constant in the
// swing (see the seam) is chosen so the NEUTRAL blade stands DEAD
// VERTICAL — matching the rest draw — and the windup tips PAST vertical
// backward before the strike sweeps forward.
const SWING_NEUTRAL = (() => {
  let p0 = -0.8 - 0.96*0.5;
  return { rs: 1.2*Math.sin(0.5), cos: Math.cos(p0), sin: Math.sin(p0) };
})();
// Face-on (S/N) chop model — see the sword pose seam. REACH = elevation
// driven past vertical at the strike; DOWN_K = a down-pointing blade
// reads shorter (it's coming at the camera); DROP = how far the grip
// falls over the chop; RISE = how high the hands climb on the windup
// (th < 0) — a FULL overhead swing, fists up over the head before the
// blade drives down. The grip NEVER moves inward — the arm hangs at
// the shoulder line and the whole chop happens straight down out there.
const CHOP = { REACH: 2.4, DOWN_K: 0.75, DROP: 2.2, RISE: 10 };

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
// Vertical PARALLAX damping for mounts: the full iso projection puts a
// near-side grip ~2px lower than a far-side one — 3D-correct, but at
// ~20px sprites the ±2px reads as units sitting UN-LEVEL across dirs.
// Keep a hint of the depth cue, not the full effect.
const RIG_YK = 0.35;
// Per-dir FORWARD screen basis {sx,sy,d}; the RIGHT basis is row
// (d+2)&7 — the right of facing d is the facing two dirs clockwise.
const RIG = RIG_DIRV.map(([wx, wy]) => {
  let n = Math.hypot(wx, wy), x = wx / n, y = wy / n;
  return { sx: (x - y) * RIG_C1, sy: (x + y) * RIG_C2, d: (x + y) * RIG_C1 };
});
// Sword mount per silhouette (rig coords), FITTED so the projections
// reproduce the hand-approved per-dir anchors.
// ONE sword hold for both silhouettes — the mount is relative to the
// HUMAN body origin, and the rider's humanX/YOffset already seats that
// origin on the horse, so foot and rider grip the sword identically.
// ONE sword placement for EVERY weapon-arm mode (user call): the
// UNHANDED centerline mount. L/R/B render the sword identically — only
// the arms differ — and because lat = 0 every mirror-dir pair places
// the sword symmetrically (S/N dead-center falls out free). The old
// handed per-dir table (cross-body SW, E far-stretch, NW/NE pins) was
// one-hand-LEFT choreography and died with this decision.
// profileHeld: at the dead-on profiles (W/E) the forward depth projects
// to 0 and would TIE with the body — the field pins the forward-held kit
// just over it. One value; any pin in (0.01, ~2.5) sorts identically.
// (The archer's bow deliberately has NONE: it derives BEHIND the body at
// E side-on, nocked arrow furthest back — user call.)
const SWORD_MOUNT = { lat: 0, fwd: 8.0, up: 7.1, profileHeld: 0.5 }; // fwd keeps the blade clear of the face in every dir
// Shield mount: ALWAYS strapped to the off forearm (side = −gripS folds
// the L/R flip in), in every view and mode — the plate turns with the
// body: full face at the profiles, edge-on STRIP at S/N (the sword's
// edge convention, user call), back face on the away quarters. A
// separate slung-on-back mode was built and cut — one mount is honest
// and covers every read.
const SHIELD_MOUNT = { lat: 6.2, fwd: 0.8, up: 5.5 }; // lat clears the hanging arm at S/N
const RIG_MOUNTS = {
  // (militia/spearman/mounted read SWORD_MOUNT directly)
  // held-item DEPTH mounts for the other humanoids (lat/fwd only —
  // their draw anchors stay where they are; these place the item in the
  // sort: forward-held kit sorts over the body facing camera, behind it
  // facing away, from the F.d sign alone)
  // (spearman: pose + heldD fully derived at its seam — no mount entry)
  archer:   { bow:   { lat: -1, fwd: 6 } },
  // fwd 6.5: the tool swings clearly IN FRONT of the body — lower values
  // put the NE/E grips backward past the shoulder (user calls, twice)
  villager: { tool:  { lat: 0,  fwd: 6.5, up: 9, profileHeld: 0.5 } },
};
// Tool-head frames: +x along the drawn handle (fixed handle geometry).
const AXE_HEAD_ROT = Math.atan2(-14, 9);
const MALLET_HEAD_ROT = Math.atan2(-12, 7.5);
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
  if (c.carrying > 0 && !weathered && cargoT < 0.55) drawCargo(); // still boxed in: walls occlude it
  // near outer faces are TEAM-COLORED panels (the live cart's ownership
  // read) — but once a wall folds past ~45° its blue outer face turns
  // toward the ground, so the visible side becomes the brown INNER face
  let faceFlipped = tFold > 0.5;
  wallQ(nearB, wood(faceFlipped ? '#74593a' : teamColor(c.team), '#877e6c'));
  endQ(u.y<0 ? -L : L, wood(faceFlipped ? '#74593a' : teamColorDark(c.team), '#877e6c'));
  X.restore();

  if (u.x !== 0 && tFold <= 0.3) nearWheels(); // still tipping: over the standing box

  // once the walls have mostly folded open the spilled cargo lies ON them
  if (c.carrying > 0 && !weathered && cargoT >= 0.55) {
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
  let scr=mapToScreen(c.x,c.y);
  let sx=Math.round(scr.sx), sy=Math.round(scr.sy+HALF_TH);
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
      path:[], target:null, buildTarget:null, task:null, order:null,
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
      militia:  {...GRIP_REST.militia,  a:0.5},
      scout:    {x:-4.5, y:-17, a:-0.6},
      knight:   {x:-4.5, y:-17, a:-0.6},
      spearman: {...GRIP_REST.spearman, a:0},
      archer:   {...GRIP_REST.archer,   a:0}
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
      // The spear, lying loose — the LIVING art fn at the owner's tier
      // (a static copy here went stale against two shaft rewrites)
      X.save();X.scale(0.8,0.8);X.rotate(0.785);
      drawBigSpear(0, (unitEquipment(c.pose) || {}).weapon || 0);
      X.restore();
    } else if(c.utype==='archer'){
      // The bow, lying loose at its braced rest profile (owner's tier)
      X.save();X.scale(0.95,0.95);
      let bt = drawRecurveBow(0, (unitEquipment(c.pose) || {}).weapon || 0);
      X.strokeStyle='#e8e8e8';X.lineWidth=1/UNIT_SCALE;
      X.beginPath();X.moveTo(bt.tx,-bt.ty);X.quadraticCurveTo(0.4,0,bt.tx,bt.ty);X.stroke();
      X.restore();
    } else {
      // Militia / scout broadsword — dropped at the owner's forged tier
      X.rotate(0.35);
      drawBigSword(0.5, (unitEquipment(c.pose) || {}).weapon || 0);
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
let grazeCycles = new Map(); // per-sheep grazing-puff cycle (same pattern)

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
// ---- WHEELBARROW (the Wheelbarrow tech's tell) ----
// A true projected box in the trade-cart idiom: authored ONCE in the
// facing frame (u = push axis, v = ground lateral, c = up); the five
// authored facings come from mirroredDir, dirs 2/3/4 free via the facing
// mirror. Drawn about the unit's GROUND CENTER; the barrow extends
// forward along u (tray TB..TF, axle at AXA, handles back to HA at HZ —
// the fist points barrowGrips exports for the hand seam). tilt rocks
// tray + handles + load about the AXLE while the wheel stays planted.
// FWD shifts the whole composite ahead along u: the handles land AT the
// body (a+FWD ~ 0) and tray/wheel push out front — authored about the
// unit center they put the handles BEHIND the villager, arms reaching
// backward (user caught it at E).
const BARROW_DIM = { TB:-2.5, TF:7.5, WB:3.1, CB:2.7, CH:6.2, WR:3.6, AXA:12, HA:-8.2, HZ:9.2, FWD:10, WTH:1.5 };
function barrowAxes(e){
  let useDir = mirroredDir(e);
  let ax = useDir === 7 ? SIDE_AXES : (RAM_AXES[useDir] || SIDE_AXES);
  // RIG_YK-style vertical parallax damping on u ONLY: the barrow
  // reaches ~22px along u, and full-strength u.y hoists it to head
  // height on the up-screen diagonals (floating barrow). v spans just
  // ±WB — damping it flattens the tray until loads leak through. The
  // head-on facings keep the FULL axis: there u is purely vertical,
  // and damping it eclipses the whole barrow behind the body at N.
  let k = useDir === 1 || useDir === 5 ? 1 : 0.4;
  return { useDir, ax: { u: { x: ax.u.x, y: ax.u.y * k }, v: ax.v } };
}
function barrowGrips(e, tilt, shift){
  const { WB, WR, AXA, HA, HZ, FWD } = BARROW_DIM;
  let { ax } = barrowAxes(e);
  let u = ax.u, v = ax.v, sh = shift || 0;
  const P = (a,b,c) => ({ x: (a+sh+FWD)*u.x + b*v.x, y: (a+sh+FWD)*u.y + b*v.y - c });
  let axle = P(AXA, 0, WR), ca = Math.cos(tilt || 0), sa = Math.sin(tilt || 0);
  let nearB = Math.sign(v.y) || 1;
  const rot = p => ({ x: axle.x + (p.x-axle.x)*ca - (p.y-axle.y)*sa,
                      y: axle.y + (p.x-axle.x)*sa + (p.y-axle.y)*ca });
  return [rot(P(HA, nearB*WB, HZ)), rot(P(HA, -nearB*WB, HZ))]; // [near, far]
}
function drawBarrow(e, rolling, tilt, loadFn, part, kind, shift){
  const { TB, TF, WB, CB, CH, WR, AXA, HA, HZ, FWD, WTH } = BARROW_DIM;
  let { useDir, ax } = barrowAxes(e);
  let u = ax.u, v = ax.v, headOn = useDir === 1 || useDir === 5;
  let plow = kind === 'plow', sh = shift || 0;
  const P = (a,b,c) => ({ x: (a+sh+FWD)*u.x + b*v.x, y: (a+sh+FWD)*u.y + b*v.y - c });
  let axle0 = P(AXA, 0, WR);
  X.save();
  X.translate(axle0.x, axle0.y); X.rotate(tilt || 0); X.translate(-axle0.x, -axle0.y);
  const lw = 1.1/UNIT_SCALE;
  const poly = (pts, fill) => {
    X.fillStyle = fill; X.beginPath();
    pts.forEach((p,i) => i ? X.lineTo(p.x,p.y) : X.moveTo(p.x,p.y));
    X.closePath(); X.fill();
    X.strokeStyle = '#000'; X.lineWidth = lw; X.lineJoin = 'round'; X.stroke();
  };
  const rod = (p, q, wOut, wIn) => {
    X.lineCap='round';
    X.strokeStyle='#000'; X.lineWidth=wOut/UNIT_SCALE;
    X.beginPath(); X.moveTo(p.x,p.y); X.lineTo(q.x,q.y); X.stroke();
    X.strokeStyle='#8B4513'; X.lineWidth=wIn/UNIT_SCALE;
    X.beginPath(); X.moveTo(p.x,p.y); X.lineTo(q.x,q.y); X.stroke();
    X.lineCap='butt';
  };
  // wheel ground drop: at the PROFILE the near leg dips v.y·WB below
  // the anchor plane but the centered wheel doesn't; the up-screen
  // diagonals (NE/NW) hover worse — the damped push axis lifts the far
  // wheel off its ground line (user caught both). Hoisted so the plow
  // beam can aim at the REAL wheel center, not the undropped axle.
  const wDrop = useDir === 7 ? WB*0.85*Math.abs(v.y) : useDir === 6 ? 2.2 : 0;
  const wheel = () => {
    let axle = { x: axle0.x, y: axle0.y + wDrop };
    if (headOn) { // edge-on slab — the cart's S/N wheel convention.
      // full WR height: the 0.8 shave read as a smaller wheel at S
      // next to the side views' full disc (user caught it)
      let w2 = 1.3, h2 = WR;
      X.fillStyle='#33261a'; X.fillRect(axle.x-w2, axle.y-h2, w2*2, h2*2);
      X.strokeStyle='#1d150c'; X.lineWidth=0.9/UNIT_SCALE;
      X.strokeRect(axle.x-w2, axle.y-h2, w2*2, h2*2);
      X.fillStyle='#5a4630'; X.fillRect(axle.x-0.4, axle.y-h2+0.5, 0.8, h2*2-1);
      return;
    }
    // single spoked wheel in the push plane (the cart's chariot wheel).
    // No extra shear damp here: barrowAxes already damps u.y, and a
    // second 0.35 left the disc flatter than the tray's edge — the
    // wheel read as skewed off the barrel at NE/NW (user caught it;
    // the original squished-oval fix predates the axis-level damping)
    let wu = { x: u.x, y: u.y };
    const ringAt = (cx, cy, fill) => {
      X.save(); X.transform(wu.x,wu.y,0,-1,cx,cy);
      X.beginPath(); X.arc(0,0,WR,0,Math.PI*2); X.arc(0,0,WR-1.2,0,Math.PI*2,true);
      X.restore(); X.fillStyle=fill; X.fill('evenodd');
    };
    const disc = (cx, cy, rr) => { X.save(); X.transform(wu.x,wu.y,0,-1,cx,cy);
      X.beginPath(); X.arc(0,0,rr,0,Math.PI*2); X.restore(); };
    // DEPTH: the far rim face peeks behind the near one along the
    // lateral axis (the cart's two-face treatment)
    let bx = axle.x - v.x*WTH, by = axle.y - v.y*WTH;
    ringAt(bx, by, '#453522');
    X.strokeStyle='#1d150c'; X.lineWidth=0.7/UNIT_SCALE;
    disc(bx, by, WR); X.stroke();
    // near rim face
    ringAt(axle.x, axle.y, '#6b543a');
    X.strokeStyle='#1d150c'; X.lineWidth=0.9/UNIT_SCALE;
    disc(axle.x, axle.y, WR); X.stroke(); disc(axle.x, axle.y, WR-1.2); X.stroke();
    let ang = typeof rolling === 'number' ? rolling
            : rolling ? tick*0.35 + e.id : 0.6;
    X.strokeStyle='#8a6a4a'; X.lineWidth=1.2/UNIT_SCALE;
    for (let k = 0; k < 3; k++){
      let A = ang + k*Math.PI/3, c2 = Math.cos(A), s2 = Math.sin(A), t = WR - 0.9;
      X.beginPath();
      X.moveTo(axle.x - c2*wu.x*t, axle.y - (c2*wu.y + s2)*t);
      X.lineTo(axle.x + c2*wu.x*t, axle.y + (c2*wu.y + s2)*t);
      X.stroke();
    }
    X.fillStyle='#8a6a4a'; X.strokeStyle='#1d150c'; X.lineWidth=0.7/UNIT_SCALE;
    X.beginPath(); X.arc(axle.x, axle.y, WR*0.25, 0, Math.PI*2); X.fill(); X.stroke();
  };
  let nearB = Math.sign(v.y) || 1;   // +v.y side is nearer the camera
  // the FAR handle rod is its own depth part (drawn BEHIND the villager
  // on the front facings — the poles straddle the body, user call)
  if (part === 'farRod') {
    // plow handles fan from ONE beam root (no tray corners on a plow)
    rod(P(TB, plow ? 0 : -nearB*WB, CH), P(HA, -nearB*WB, HZ), 2.2, 1.1);
    X.restore(); return;
  }
  let wheelFar = u.y < -0.05;        // pushing up-screen: the wheel is far
  if (wheelFar) wheel();
  if (plow) {
    // PLOW body on the barrow frame: beam from the handle root to the
    // axle, a polished-steel share digging at the ground line (the
    // plow IS the Heavy Plow tier tell — always tierSteel(2)), and the
    // twin handles fanning back from the beam root to the same grips
    // the barrow uses (fists weld via the shared barrowGrips).
    // the share is a MOLDBOARD blade in the WHEEL's full convention
    // (user call): push-plane transform, own projected anchor, two
    // faces offset along v (the back-rim treatment), a face-on SLAB
    // shape at S/N (the plane is edge-on there and the true
    // projection collapses to a sliver), and painter order by the
    // same far/near rule as the wheel.
    // V-WEDGE share (user call): both faces meet on one shared KEEL
    // line at the ground (closed bottom) and spread apart upward along
    // v — the far face draws BEHIND the beam, the near face in front.
    // No blade at S/N: the wedge is edge-on there, beam+wheel carry
    // the head-on read alone.
    // ONE triangle in plane coordinates for every view (the wheel's
    // one-circle-one-transform rule); the anchor rides wDrop so blade
    // and wheel share the same ground line in every facing — the NE
    // collision was the wheel dropping out from under the blade, not
    // a shape problem.
    // the blade takes the BEAM's local share of the wheel drop (~40%
    // at this a-position), not the full drop: constant triangle height
    // and constant beam overlap in every view (full drop grew the
    // blade at NE/E, user caught it); the keel floats a hair above the
    // dropped-wheel ground there, hidden behind the wheel.
    // up-screen the dropped wheel leans back over the blade's ground
    // slot — the blade steps back ~2 along the axis there so the tip
    // clears the rim (user call)
    let shB0 = P(useDir === 6 ? 3.6 : 4.6, 0, 0);
    let shB = { x: shB0.x, y: shB0.y + wDrop*0.39
                   - (useDir === 6 ? 1.0 : useDir === 0 ? 0.6 : useDir === 7 ? 0.6 : 0) };
    const shareFace = (ox, oy, fill) => {
      X.beginPath();
      X.save(); X.transform(u.x, u.y, 0, -1, shB.x, shB.y);
      // NE/NW: slight clockwise turn about the apex — counters most of
      // the axis slope so the keel runs near-parallel to the ground
      // (user call); other views keep the pure plane keel
      if (useDir === 6) { X.moveTo(-3.5, 0.15); X.lineTo(3.8, -0.75); }
      // E/W: ~8deg clockwise about the apex (user call) — the front
      // tip dips into the soil, the back corner rises
      else if (useDir === 7) { X.moveTo(-4.15, 0.05); X.lineTo(3.05, -1.0); }
      else { X.moveTo(-3.5, -0.3); X.lineTo(3.8, -0.3); }
      X.restore();
      X.save(); X.transform(u.x, u.y, 0, -1, shB.x + ox, shB.y + oy);
      X.lineTo(-1.4, 4.6);                             // spread top corner
      X.restore();
      X.closePath();
      X.fillStyle = fill; X.fill();
      X.strokeStyle = '#000'; X.lineWidth = lw; X.lineJoin = 'round'; X.stroke();
    };
    if (!headOn) shareFace(-v.x*WTH, -v.y*WTH, '#8f8f8f');            // far, shadowed
    rod(P(TB, 0, CH), { x: axle0.x, y: axle0.y + wDrop }, 3.4, 2.0);
    if (!headOn) shareFace(v.x*WTH*0.7, v.y*WTH*0.7, tierSteel(2));    // near, polished
    rod(P(TB, 0, CH), P(HA, nearB*WB, HZ), 2.2, 1.1);
    if (!wheelFar || useDir === 6) wheel();
    X.restore(); return;
  }
  // rear legs to the ground — at the PROFILE the two legs project
  // nearly on top of each other and read as clutter (user caught it):
  // keep only the NEAR leg there (same geometry as every other view,
  // so its length matches), the true pair everywhere else
  rod(P(TB+0.6, nearB*WB, CB), P(TB+1.2, nearB*WB*0.85, 0), 2.0, 1.0);
  if (useDir !== 7)
    rod(P(TB+0.6, -nearB*WB, CB), P(TB+1.2, -nearB*WB*0.85, 0), 2.0, 1.0);
  // tray, painter order: far wall (shadowed inner) → far end board →
  // floor → cargo → near end board → near wall (lit)
  poly([P(TB,-nearB*WB,CB), P(TF,-nearB*WB,CB), P(TF,-nearB*WB,CH), P(TB,-nearB*WB,CH)], '#74593a');
  let endFarA = u.y < 0 ? TF : TB;
  poly([P(endFarA,-WB,CB), P(endFarA,WB,CB), P(endFarA,WB,CH), P(endFarA,-WB,CH)], '#74593a');
  poly([P(TB,-WB,CB), P(TF,-WB,CB), P(TF,WB,CB), P(TB,WB,CB)], '#3a2c1c'); // floor
  // head-on the handles rise straight through the cargo zone — draw the
  // near rod BEFORE the load so both poles sit behind the resources
  // (user call; the split-out far rod is already a behind part)
  const nearRod = () => rod(P(TB, nearB*WB, CH), P(HA, nearB*WB, HZ), 2.2, 1.1);
  if (headOn) nearRod();
  // seat the cargo HIGH: most of each art rides above the tray rim so
  // the resource reads at a glance (user call), while the near wall
  // still crops the base — nothing pokes out the underside
  if (loadFn) loadFn(P((TB+TF)/2, 0, CB+4.4));
  let endNearA = u.y < 0 ? TB : TF;
  poly([P(endNearA,-WB,CB), P(endNearA,WB,CB), P(endNearA,WB,CH), P(endNearA,-WB,CH)], '#a07c4c');
  poly([P(TB,nearB*WB,CB), P(TF,nearB*WB,CB), P(TF,nearB*WB,CH), P(TB,nearB*WB,CH)], '#a07c4c');
  // near handle rod, over everything (side views)
  if (!headOn) nearRod();
  if (!wheelFar) wheel();
  X.restore();
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
  // fat stroke-curls read as white bananas): broad at the poll,
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
// The trade cart's ONE canonical load: crate + sack + gold. Drawn only while
// the cart is LOADED (carrying>0) — the sack appears when it picks up gold at
// the far market and vanishes when it deposits at home, mirroring a villager's
// carried resource. Shared by the living cart and the death-spill sequence.
// `pos(key, dx, dy)` maps each piece's local offset from the load anchor to its
// final center, which lets the wreck spill the pieces apart along their paths.
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
    // (u.y=±0.55) instead of a single flat plank — far board first,
    // thin side rails, floor, cargo peeking over the far rim, then the near
    // board and near wheels over it. Widened (like the ram's head-on v) so
    // it doesn't read as a narrow spike.
    let nearA = useDir===5 ? -L : L; // the end toward the camera
    let farA  = -nearA;
    // modest widening only (WB*1.25): at 1.7 the head-on cart reads
    // wider than every other view
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
    if (e.carrying > 0) drawCartLoad((k,dx,dy)=>({x:cc.x+dx, y:cc.y+dy}), lw);
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
    if (e.carrying > 0) drawCartLoad((k,dx,dy)=>({x:cc.x+dx, y:cc.y+dy}), lw);
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
// head-on. Tuned so the humanoid footprint matches a 6×3-ish ellipse.
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
  let tc=teamColor(e.team);
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
  // Facing priority: the PATH wins while the unit is actually walking —
  // facing the target first made a unit on a detour route (pathing around a
  // wall/forest toward a target on the far side) moonwalk: body toward the
  // target, feet going the other way (repro: aoe2-game-test01.json, knight
  // walking E around an obstacle while facing its ram target to the W).
  // AoE2 units face their travel direction in transit and square up to the
  // target only when the walk ends (in range / at the work site).
  if(e.path && e.path.length > 0){
    // Look 3 steps ahead to smooth out diagonal paths that alternate N+E or S+W steps
    let ahead = Math.min(3, e.path.length - 1);
    tx = e.path[ahead].x;
    ty = e.path[ahead].y;
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
    // The maul rides the REAL bite clock (atkCooldown, like the archer's
    // draw): crouch back → rear up on the haunches → explosive pounce
    // landing EXACTLY when the damage tick fires → jaws-in hold with a
    // worrying head-shake that decays.
    let bearRof = (UNITS.bear && UNITS.bear.rof) || T30(60), bcd = e.atkCooldown || 0;
    let bp = attacking ? 1 - bcd/bearRof : 0;   // 0 just bitten → 1 next bite
    let justBit = attacking && bcd > bearRof*0.85;
    let bsnap = attacking ? Math.max(0, (bcd - bearRof*0.85)/(bearRof*0.15)) : 0;
    let lunge = 0, rear = 0, jaw = 0;
    if (justBit) { lunge = 4.5; jaw = Math.max(0, bsnap*2 - 1); rear = -0.2; } // CHOMP: jaws snap shut as the bite lands
    else if (attacking && bp > 0.85) { let t = (bp-0.85)/0.15; lunge = -1.2+5.7*t*t; rear = 0.8*(1-t)-0.2; jaw = t; }
    else if (attacking && bp > 0.55) { let t = (bp-0.55)/0.3; lunge = -1.2*t; rear = 0.8*t; }
    let sway = moving ? Math.sin(tick*0.25+e.id)*0.05 : 0;
    sway += Math.sin(tick*1.4)*0.05*bsnap; // worrying the prey — decays after the bite
    let breath = (!moving && !attacking && !e.corpseRot) ? Math.sin(tick*0.05+e.id)*0.25 : 0;

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

    X.save();
    X.rotate(sway);
    // Pounce along the view axis when facing the camera/away — a sideways
    // lunge in the S/N poses reads as a side attack.
    if (pose === 'front') X.translate(0, lunge*0.7);
    else if (pose === 'back') X.translate(0, -lunge*0.7);
    else X.translate(lunge, 0);
    // Cartoon proportions: one huge boulder of a body on tiny stub legs.
    X.scale(1.4, 1.4);
    // Rearing up on the haunches: profiles pivot at the hind paws; head-on
    // poses stretch tall instead (anchored at the paws).
    if (rear) {
      if (pose === 'side' || pose === 'backside') {
        X.translate(-7, 4); X.rotate(-rear*0.22); X.translate(7, -4);
      } else {
        X.translate(0, 5); X.scale(1, 1 + rear*0.12); X.translate(0, -5);
      }
    }

    // Stub-leg walk cycle: comically short, thick legs mostly hidden
    // under the body mass — just paws scuttling along
    let lw1 = moving ? Math.sin(tick*0.5+e.id)*1.8 : 0;
    let lw2 = -lw1;
    // Pounce stance: front paws reach into the strike, hind paws brace back
    let pounce = Math.max(0, Math.min(1, jaw));
    let legPts = [[-6,2,lw1-1.8*pounce],[-3,2.5,lw2-1.2*pounce],[2.5,2.5,lw1+1.6*pounce],[5.5,2,lw2+2.2*pounce]];
    X.beginPath();
    legPts.forEach(p=>{ X.moveTo(p[0],p[1]); X.lineTo(p[0]+p[2],5); });
    X.strokeStyle='#000'; X.lineWidth=4.2/UNIT_SCALE; X.lineCap='round'; X.stroke();
    X.strokeStyle='#4e3520'; X.lineWidth=2.6/UNIT_SCALE; X.stroke(); X.lineCap='butt';
    X.fillStyle='#241a10';
    legPts.forEach(p=>{ X.beginPath(); X.ellipse(p[0]+p[2],5.2,1.6,1,0,0,Math.PI*2); X.fill(); });

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

    // Mauling: articulated jaw — opens through the pounce, snaps shut on
    // the bite. front: mouth gapes; side: lower-jaw wedge hinges down off
    // the snout over the red mouth.
    if(jaw > 0.05){
      X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE; X.lineJoin='round';
      if(pose==='front'){
        X.fillStyle='#a03030';
        X.beginPath(); X.ellipse(0,-2.2,1.6,0.3+1.5*jaw,0,0,Math.PI*2); X.fill(); X.stroke();
      } else if(pose==='side'){
        // Gape + lower jaw share ONE hinge at the snout base: the red
        // mouth is the fan between the upper gum line and the jaw tip,
        // and the fur jaw wedge rides the same rotation.
        let ja = 0.7*jaw;
        X.save(); X.translate(hx+1.6, hy+1.2);
        X.fillStyle='#a03030';
        X.beginPath();
        X.moveTo(0,0);
        X.lineTo(3.9,-0.4);                                  // upper gum line
        X.lineTo(3.7*Math.cos(ja), 3.7*Math.sin(ja));        // jaw tip
        X.closePath(); X.fill(); X.stroke();
        X.rotate(ja);
        X.fillStyle='#6b4a2c';
        X.beginPath(); X.moveTo(-0.2,0); X.lineTo(3.7,0); X.lineTo(3.1,1.4); X.lineTo(-0.2,1.2); X.closePath();
        X.fill(); X.stroke();
        X.restore();
      }
    }
    X.restore();
  } else if(e.utype!=='sheep'){
    // Seated over the saddle center; face-on (S) the saddle reads at
    // body center, so the rider sits right of the -2 profile seat.
    // face-on riders sit CENTERED on the horse (S 0.5 / N 0 — the head
    // is centered there too); the side/diagonal views keep the saddle
    // seat back at −2
    let humanXOffset = isMountedUnit(e.utype) ? (e.dir === 1 ? 0.5 : e.dir === 5 ? 0 : -2) : 0;
    let humanYOffset = isMountedUnit(e.utype) ? -11 : 0;
    let eq = unitEquipment(e); // null for non-soldiers (villager)
    let weaponTier = eq ? eq.weapon : 0;

    // ---- hand-pose seam ----
    // TRUE screen-space angle from this unit to its combat target. Used to
    // point aimed weapons (bow, spear) along the real attack line. Callers
    // must first UNDO the facing mirror (X.scale(e.facing,1) inside the
    // already-mirrored context cancels it) and then rotate by this — never
    // clamp the angle to the mirrored frame (a clamp renders steep or
    // across-the-body shots up to ~130° off). When the target entity is
    // gone mid-swing (or a preview has none), fall back to the FACING
    // projected through the rig — NOT horizontal: a horizontal fallback
    // made the NW/NE diagonals swing sideways instead of up-screen.
    const facingAim = () => Math.atan2(RIG[e.dir].sy, RIG[e.dir].sx);
    const targetCenter = (t) => t.type === 'building'
      ? { x: t.x + (t.w || 1) / 2, y: t.y + (t.h || 1) / 2 } : { x: t.x, y: t.y };
    let aimAngle = () => {
      let t = entitiesById.get(e.target);
      if (!t) return facingAim();
      let tc = targetCenter(t);
      let dix = ((tc.x - e.x) - (tc.y - e.y)) * HALF_TW;
      let diy = ((tc.x - e.x) + (tc.y - e.y)) * HALF_TH;
      if (dix === 0 && diy === 0) return facingAim();
      return Math.atan2(diy, dix);
    };
    // Archer variant: the LAUNCH tangent of the ballistic arc, not the flat
    // line to the target — the nocked arrow releases exactly along the real
    // arrow's initial flight line. Constants (35, /5, startH 12, endH 8)
    // must stay in sync with spawnProjectile/drawProjectiles.
    let aimAngleBallistic = () => {
      let t = entitiesById.get(e.target);
      if (!t) return facingAim();
      let tc = targetCenter(t);
      let dix = ((tc.x - e.x) - (tc.y - e.y)) * HALF_TW;
      let diy = ((tc.x - e.x) + (tc.y - e.y)) * HALF_TH;
      let A = 35 * (Math.hypot(tc.x - e.x, tc.y - e.y) / 5); // arc amplitude
      diy -= Math.PI * A + (8 - 12); // + endH − startH (units launch at 12, impact at 8)
      if (dix === 0 && diy === 0) return facingAim();
      return Math.atan2(diy, dix);
    };
    // ---- ARM-STATE MODEL ----
    // Arms are BODY sides (s: −1 left, +1 right); this maps a body side
    // to its mirrored-frame hand target. Profiles (lateral axis edge-on)
    // keep FIXED sides (left→rear, right→front — the approved reads).
    // One helper replaces every front/rear choice heuristic; it
    // reproduces all 8 previously hand-picked sword-arm choices.
    const armFrameSide = (s) => {
      let v = e.facing * s * RIG[(e.dir + 2) & 7].sx;
      if (v > 0.1) return 'front';
      if (v < -0.1) return 'rear';
      return s > 0 ? 'front' : 'rear';
    };
    // ---- SHARED PARTS-PASS RULES (one copy for every humanoid family;
    // per-family riders come in as flags — see each parts block) ----
    // frame-forward sign for tool mirroring: facing-projected forward,
    // ties broken by the lateral axis depth.
    const frameFwdSign = () => {
      let v = e.facing * RIG[e.dir].sx;
      return v > 0.05 ? 1 : v < -0.05 ? -1 : (RIG[e.dir].d >= 0 ? 1 : -1);
    };
    // held-item sort depth from a mount; at the dead-on profiles the
    // forward depth ties with the body, so profileHeld pins it just over
    // (lat parameter for the militia's mode-adjusted lateral)
    const mountHeldD = (M, R, F, lat = M.lat) =>
      (Math.abs(F.d) < 0.05 && M.profileHeld !== undefined) ? M.profileHeld
        : lat * R.d + M.fwd * F.d;
    // ONE arm-depth rule: grip/support arms span THEIR OWN shoulder to
    // the held item; the shoulder side decides occlusion AT ALL TIMES
    // (user calls) — a camera-side shoulder's arm reaches around visibly,
    // its hand wrapping the handle viewer-side over body AND weapon; a
    // far shoulder's arm tucks BEHIND the torso (its fist still sweeps
    // past the silhouette). Pins win; shield hands sit just under their
    // plate; carry arms ride the load; idle arms hang. o riders:
    //   farGripPin    (mounted)  far grip arm pinned just under the sword
    //   farBehindHeld (militia)  far arm deepens UNDER a behind-body sword
    //   flankClamp    (mounted)  the idle rein arm hangs ON the flank
    //   shieldGap     per-family gap under the plate
    const armDepthRule = (s, o) => {
      let st = anim.armState ? anim.armState[s] : 'idle';
      if (st === 'grip' || st === 'support') {
        if (o.farGripPin && st === 'grip' && anim.gripS * o.R.d < -0.05)
          return o.held - 0.1;
        let d = (s * 4.5 * o.R.d + o.held) / 2;
        if (s * o.R.d > 0.05) d = Math.max(d, o.held + 0.1, 0.02);
        else if (s * o.R.d < -0.05)
          d = d > 0.005 ? 0.005 : o.farBehindHeld ? Math.min(d, o.held - 0.1) : d;
        return d;
      }
      if (st === 'shield') return o.shield - o.shieldGap;
      // carry arms follow the IDLE convention: the far-shoulder arm
      // tucks BEHIND the body (its fist re-emerges at the handle/load —
      // the bigger forward barrow rig puts the far grip past the
      // silhouette, so the fist reads), the near arm rides over the
      // carried thing.
      if (st === 'carry') {
        // barrow at dead-away N: arms AND shoulders render behind the
        // body with the barrow (user call) — near arm still over far.
        // N is where sx≈0 with sy<0 (F.d is strongly NEGATIVE there,
        // not ~0 — the first cut keyed on d and never fired)
        if ((anim.barrow || anim.plowRig) && Math.abs(o.F.sx) < 0.05 && o.F.sy < -0.05)
          return anim.carryD + 0.03 + (s > 0 ? 0.01 : 0);
        return s * o.R.d < -0.05 ? 0.005
          : (anim.barrow || anim.plowRig) ? Math.max(anim.carryD + 0.03, 0.02)
          : anim.carryD + 0.03;
      }
      let hang = s * 4.5 * o.R.d + 0.15 * o.F.d;
      return o.flankClamp && hang < 0.01 ? 0.005 : hang;
    };
    // the plate straps OUTSIDE its (idle) arm; nearOnly skips far-side
    // (behind-the-horse) braces so the flank clamp can't drag them on top
    const strapShieldOut = (shield, armDepth, nearOnly) => {
      if (anim.shieldState && (!nearOnly || shield > 0) &&
          anim.armState[-anim.gripS] !== 'shield') {
        let ad = armDepth(-anim.gripS);
        if (shield < ad + 0.03) shield = ad + 0.03;
      }
      return shield;
    };
    // ascending depth sort IS the draw order
    const runParts = (parts) => {
      parts.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < parts.length; i++) parts[i][1]();
    };

    // Per-frame animation snapshot shared by the ARM pass (body layer) and
    // the GRIP anchors (held layer) — the two draw at different times per
    // facing, so any phase math they share must live here, not in either
    // closure. Pure reads only (safe under the outline mask pass); sounds/
    // particles stay in drawHeldLayer behind their _maskDraw guards.
    const anim = { armSwing: moving ? Math.sin(tick*0.4+e.id)*1.5 : 0 };
    // TRUE PROFILE views (E/W): the body is seen exactly side-on —
    // legs align under the center and the shoulders sit ON the
    // centerline (consumers: legs in drawBodyLayer, shoulders in
    // computeHandTargets). Other dirs keep the 3/4 read.
    anim.profile = e.dir === 3 || e.dir === 7;
    // POSE-RIG shoulders — EVERY humanoid (villager convention adopted
    // unit-wide): both shoulders project to the rotated rim (face-on
    // wide, diagonals tucked, profiles on the centerline) and the near
    // shoulder rides slightly lower, damped like the weapon mounts
    // (RIG_YK). The FAR arm keeps its true anchor even where the body
    // hides it. (Arm layering itself is the parts pass — the old
    // farArm flag is gone.)
    {
      // sPlus = which body side (±lat) lands on the mirrored frame's +x
      let sPlus = R.sx > 0.1 ? e.facing : R.sx < -0.1 ? -e.facing : 0;
      anim.shDx = Math.abs(R.sx);        // shoulder rim scale per dir
      anim.shDy = sPlus * R.sy * RIG_YK; // frame-front shoulder drop, per unit of rim width
    }
    // One spelling of "mid-attack-animation" for every weapon branch
    // (inActionRange already honors the gallery's __animAttack preview).
    if (MILITARY.has(e.utype))
      anim.swinging = !e.corpseRot && inActionRange(e) && e.path.length===0;
    if (e.utype === 'villager') {
      // "At the work site" — a villager whose task is already back to
      // chop/mine but who is still STANDING AT THE DROP-OFF must not flash
      // the tool or swing it; require actual proximity to the work.
      let atSite = true;
      if (e.task === 'chop' || e.task === 'mine_gold' || e.task === 'mine_stone') {
        atSite = e.gatherX >= 0 &&
          Math.max(Math.abs(e.x - e.gatherX), Math.abs(e.y - e.gatherY)) < 1.8;
      } else if (e.task === 'build' && e.buildTarget) {
        let bt = entitiesById.get(e.buildTarget);
        atSite = !!bt && distToTarget(e, bt) < 1.8;
      } else if (e.target) {
        atSite = inActionRange(e);
      }
      anim.atSite = atSite;
      anim.working = isActive && e.path.length===0 && atSite;
      anim.gripTask = e.task==='chop'||e.task==='mine_gold'||e.task==='mine_stone'||e.task==='build';
      // Shaped work swing: slow wind-up (70% of the cycle), fast strike
      // (30%). swing is the tool's rotation: -1.1 raised, +0.5 at impact.
      anim.phRaw = tick*0.055 + e.id*0.37;
      let ph = ((anim.phRaw % 1) + 1) % 1;
      let u = ph < 0.7 ? ph/0.7 : 1-(ph-0.7)/0.3;
      // gripTask-gated like every consumer — a working forager/farmer has
      // no swinging tool, and an ungated value invites wiring one on.
      // DRAMATIC overhead arc (the sword-swing treatment): the windup
      // raises the tool head well over the shoulder before the strike;
      // the impact angle (+0.5) is unchanged, so sound/particle sync and
      // the work cycle counter are untouched.
      anim.swing = (anim.working && anim.gripTask) ? (0.5 - 2.4*u) : 0;
      // Bow Saw replaces the chopping AXE with a literal bow saw: the
      // motion becomes a horizontal SAWING stroke (translation along the
      // blade), not a rotation — sawOff drives tool + hand + body alike.
      anim.sawing = anim.working && e.task === 'chop' && hasUpgrade(e.team, 'bow_saw');
      anim.sawOff = anim.sawing ? Math.sin(anim.phRaw * Math.PI * 2) * 3.8 : 0;
      if (anim.sawing) anim.swing = 0; // the saw never rotates
      // Heavy Plow replaces the farm SCYTHE with a literal wheeled PLOW
      // (the Bow Saw treatment): the motion becomes a PUSH along the
      // facing — slow drive forward on the work cycle's 70%, quick reset
      // drag on the 30% — plowOff drives tool + hands + body alike.
      anim.plowing = anim.working && e.task === 'farm' && hasUpgrade(e.team, 'heavy_plow');
      anim.plowOff = anim.plowing ? u*4 - 2 : 0;
      // the plow RIDES the barrow rig (same projected frame, wheel,
      // grips, depth rules): a wheelbarrow minus the tray plus a share
      anim.plowRig = anim.plowing;
      // Farmers below Heavy Plow work a SCYTHE: a horizontal sweep
      // (rotation about the grip anchor) at the standard work-cycle
      // rate; sweep drives tool + hand from one value.
      anim.scythe = anim.working && e.task === 'farm' && !anim.plowing;
      anim.sweep = anim.scythe ? Math.sin(anim.phRaw * Math.PI * 2) * 0.3 : 0;
      // The rock accompanies the TOOL swing only (gripTask + the plow):
      // 'working' alone is true for any truthy task standing at-site
      // (foragers, fighters, the gallery's dummy task) — no shake there.
      if (anim.working && (anim.gripTask || anim.plowing)) { // upper body rocks gently, legs planted
        // gentle: the DRAMA lives in the oversized saw's travel, the
        // body keeps the same quiet work rock as every other task
        if (anim.sawing) { anim.upperLean = 0.02*anim.sawOff; anim.upperLunge = 0.31*anim.sawOff; }
        // the plow push leans the body INTO the drive (legs follow via
        // the attack-legwork rule — a real digging step)
        else if (anim.plowing) { anim.upperLean = 0.03*anim.plowOff; anim.upperLunge = 0.5*anim.plowOff; }
        // rock rescaled for the wider overhead swing (±2.4 vs the old
        // ±1.6) — same perceived body sway, no twitch
        else { anim.upperLean = 0.05*anim.swing; anim.upperLunge = 0.12*anim.swing; }
        anim.upperPivot = -2.5; anim.stance = 1.2;
      }
      anim.pick = Math.sin(tick*0.18+e.id);
      anim.carcassTarget = !e.task&&e.target&&entitiesById.get(e.target)?.utype==='sheep_carcass';
      let jabPh = ((tick*0.06 + e.id*0.41) % 1 + 1) % 1;
      anim.jab = jabPh < 0.25 ? jabPh/0.25 : 1-(jabPh-0.25)/0.75; // 0..1 spike
      // TOOL RIG — the weapon conventions adopted: tools live in the
      // LEFT hand (rig convention), swung TWO-HANDED (grip + support on
      // the shaft, like the militia's B mode); the anchor projects from
      // the tool mount per dir, and the face-on views (S/N) shift it to
      // the grip side exactly like the sword's rule — a centered screen-
      // plane swing would read sideways. Saws/scythes stay one-handed
      // in art terms (their support hand is on the frame/snath grip).
      // grip side follows the NEAR shoulder per dir: with a fixed left
      // grip the viewer-side arm held the handle TOP at NW but the
      // BOTTOM at NE — mirror pairs read asymmetric (user caught NE).
      // Tools have no visible handedness, so the near hand always takes
      // the grip; face-on (R.d 0) keeps the left-grip convention, which
      // drives the S/N grip-side shift.
      {
        let Rd = RIG[(e.dir + 2) & 7].d;
        anim.gripS = Math.abs(Rd) > 0.05 ? (Rd > 0 ? 1 : -1) : -1;
      }
      let toolHeld = (anim.working && anim.gripTask) || anim.sawing || anim.scythe;
      anim.armState = {};
      // the LOAD shows only while HAULING (collected, walking to the
      // drop-off) — never during ANY work action (user call, keeps the
      // reads simple): tool swings stay two-handed, and butchering/
      // foraging keep their poses too (they work via TARGET, not task —
      // a toolHeld-only gate let the carry pose hijack the butcher jab,
      // user caught it). anim.working covers them all.
      anim.carryShow = e.carrying > 0 && !anim.working;
      // WHEELBARROW (the tech's literal tell): hauling villagers push a
      // barrow — load in the tray outbound, EMPTY on the walk back to
      // the resource (user call; builders keep bare hands).
      anim.barrow = hasUpgrade(e.team, 'wheelbarrow') && !anim.working &&
        (e.carrying > 0 || (e.path.length > 0 && BARROW_TASKS.has(e.task)));
      anim.armState[anim.gripS] = (anim.barrow || anim.plowRig || anim.carryShow) ? 'carry'
        : toolHeld ? 'grip' : 'idle';
      anim.armState[-anim.gripS] = (anim.barrow || anim.plowRig || anim.carryShow) ? 'carry'
        : (toolHeld && !anim.sawing && !anim.scythe) ? 'support' : 'idle';
      {
        let M = RIG_MOUNTS.villager.tool;
        anim.heldD = mountHeldD(M, R, F);
        // face-on side shift kept SMALL — 4 read as the tool drifting off
        // the body; near-center with just enough offset to clear the head
        let mLat = faceOnView ? 2 * anim.gripS : 0;
        anim.toolRest = { x: e.facing * (mLat * R.sx + M.fwd * F.sx),
                          y: (mLat * R.sy + M.fwd * F.sy) * RIG_YK - M.up };
        // CARRY RIG: overhead — centered above the head, the SAME spot
        // in every direction. Facing the camera the assembly rides over
        // everything; dead-away (N) the load AND both raised arms render
        // BEHIND the character (user call) — the carry-arm rule
        // (carryD + 0.03) follows the flip automatically.
        // With the BARROW the anchor is the unit's GROUND CENTER — the
        // barrow rig (drawBarrow/barrowGrips) owns all directionality
        // through its projected axes; sorting by the forward sign.
        if (anim.barrow || anim.plowRig) {
          anim.carryRest = { x: 0, y: 4.6 };
          // sort by the barrow's own push axis, not F.d — at dead-away
          // N the face depth is ~0 but the barrow still extends
          // up-screen and must draw behind the body
          anim.carryD = barrowAxes(e).ax.u.y < -0.05 ? -2 : 2;
          // the WHEEL stays planted; the tray ROCKS about the axle as
          // the bobbing hands lift and drop the handles (user call) —
          // one tilt for frame, load and fists alike
          // lever-aware: the grips ride ~20 behind the axle, so a
          // small angle already moves them visibly — 0.013 keeps the
          // rock under ~0.4px (0.05 swung a full bob-height at E/W and
          // the hands read as bouncing, user caught it)
          anim.barrowTilt = anim.plowRig ? 0 : moving ? bob * 0.013 : 0;
        } else {
          anim.carryRest = { x: 0, y: -CARRY_UP };
          anim.carryD = F.d < -0.9 ? -2 : 2;
        }
      }
    } else if (e.utype === 'militia' || e.utype === 'spearman' || isMountedUnit(e.utype)) {
      // Sword pose seam — the spearman rides it WHOLESALE (user call:
      // exact replication, spear art in the sword's hands; only the
      // swing choreography is spear-tuned later) — TWO models by view,
      // both anchored on GRIP_REST
      // so idle IS the swing's frame at its neutral phase (offset-free
      // body coords; consumers add humanX/YOffset):
      //  side/diagonal — the grip ORBITS (φ linear in the swing angle:
      //    windup over the shoulder, strike forward-down) and the whole
      //    arc AIMS at the target;
      //  face-on (S/N) — a forward CHOP through the VIEW PLANE: the pose
      //    is ONE elevation angle θ (0 = the vertical rest, π/2 = at the
      //    camera, CHOP.REACH = driven down past the target, negative =
      //    tipped back over the shoulder), drawn as the EDGE-ON art
      //    scaled by cos θ — the blade never sweeps sideways.
      anim.faceOn = faceOnView;
      // POSE RIG: the rest anchor, binding arm and sort depth all derive
      // from ONE 3D sword mount projected through the per-dir basis (see
      // the RIG consts).
      {
        let M = SWORD_MOUNT; // militia, spearman AND mounted share it
        // ARM-STATE RESOLVER. The SWORD placement per dir is CANONICAL
        // (one mount; it NEVER moves with the mode — user call). The mode picks the ARMS only: 'L' left-hand grip
        // (default), 'R' right-hand (the other arm reaches the same
        // grip), 'B' both (grip + support; dark-age militia default).
        // Every arm is in exactly ONE state — grip | support | shield |
        // idle — and an idle arm is IDENTICAL to the idle pose at all
        // times, attacks included (no counterswing, no special cases).
        // window.__weaponArm (gallery [L]/[R]/[B] toggle) forces a mode.
        let armMode = window.__weaponArm ||
            (!isMountedUnit(e.utype) && !(eq && eq.shield) ? 'B' : 'L');
        anim.gripS = armMode === 'R' ? 1 : -1; // body side of the gripping hand
        anim.twoHand = armMode === 'B';
        anim.armState = {};
        anim.armState[anim.gripS] = 'grip';
        anim.armState[-anim.gripS] = anim.twoHand ? 'support'
            : (eq && eq.shield && !e.facingNorth) ? 'shield' : 'idle';
        let mLat = M.lat, mFwd = M.fwd, mUp = M.up;
        // face-on views (S/N), militia AND mounted: one-handed grips
        // shift the sword (and its arm) to the GRIP hand's side, shield-
        // spaced — L right / R left on screen — clearing the centered
        // horse head / body line; two-handed stays DEAD-CENTER (user
        // call; the one deliberate mode-dependent placement)
        if (faceOnView) mLat = anim.twoHand ? 0 : 6.2 * anim.gripS;
        var rest0 = { x: e.facing * (mLat * R.sx + mFwd * F.sx),
                      y: (mLat * R.sy + mFwd * F.sy) * RIG_YK - mUp };
        // sort depth resolved ONCE here for the parts pass
        anim.heldD = mountHeldD(M, R, F, mLat);
        // ---- SHIELD RIG ----
        // BRACED on the off forearm when that arm is in shield state;
        // SLUNG across the back when nobody can brace it (facing away,
        // or mode B — both hands on the sword). Position projects from
        // the mount like the sword's rest0; the plate's outward normal
        // is the LATERAL axis, so face (front iff normal toward camera)
        // and width foreshortening derive from R.d — full face at the
        // profiles, floored at 0.55 face-on so it never goes sliver.
        if (eq && eq.shield) {
          let side = -anim.gripS, SM = SHIELD_MOUNT;
          anim.shieldState = 'braced'; // strapped to the off forearm in EVERY view
          anim.shieldRest = { x: e.facing * (side * SM.lat * R.sx + SM.fwd * F.sx),
                              y: (side * SM.lat * R.sy + SM.fwd * F.sy) * RIG_YK - SM.up };
          anim.shieldD = side * SM.lat * R.d + SM.fwd * F.d;
          anim.shieldFace = side * R.d > 0 ? 'front' : 'back';
          anim.shieldWK = 0.55 + 0.45 * Math.abs(R.d);
          // S/N: the plate's normal is perpendicular to the view —
          // EDGE-ON, drawn as a thin strip (the sword's convention)
          anim.shieldEdge = Math.abs(R.d) < 0.3;
        } else anim.shieldState = null;
        // the gripping hand's frame target (derived — armFrameSide
        // reproduces every previously hand-picked choice)
        anim.swArm = armFrameSide(anim.gripS);
      }
      // idle blade leans ~30° toward the facing (user call); the S/N
      // edge views stay dead vertical — the chop model pivots there
      anim.restRot = anim.faceOn ? 0 : 0.52;
      // θ → blade scale + grip. fwdChop(0) IS the rest pose (fwdK 1,
      // grip = rest0), so idle/engage continuity is structural.
      const fwdChop = (th) => {
        anim.swordRot = 0; anim.swordAimM = 0;
        anim.fwdK = Math.cos(th) * (th > Math.PI/2 ? CHOP.DOWN_K : 1);
        anim.grip = { x: rest0.x, // straight down — never inward
                      y: rest0.y + CHOP.DROP*(1 - Math.cos(Math.max(0, th)))
                                 - CHOP.RISE*Math.sin(-Math.min(0, th)) };
      };
      if (anim.swinging) {
        let ssa = swordSwingAngle(e); // one phase read per frame — everything derives from it
        anim.s = Math.sin(ssa);
        if (anim.faceOn) {
          if (e.utype === 'spearman') {
            // face-on STAB: no overhead cock (the chop's rise/sweep read
            // as swinging) — the SPRING drive runs the show instead.
            let t = Math.sin(0.5) - anim.s;
            let drive = t < 0 ? 7*t : 5*Math.pow(t, 1.6);
            // straight POKES, elevation FIXED (an elevation sweep read
            // as swinging, user call); the spring drive pushes along the
            // view axis. S: the shaft FLIPS tip-down (rot π) — the enemy
            // stands down-screen, an up-pointing poke never read as an
            // attack — heavily foreshortened, tip striking toward the
            // viewer, butt clearing the chin. N: tip up, driving away.
            if (e.dir === 1) {
              fwdChop(0.9);
              anim.swordRot = Math.PI;
              anim.grip.y += 0.55*drive;
            } else {
              fwdChop(0.7);
              anim.grip.y -= 0.55*drive;
            }
          } else {
            // elevation runs from the rest pose at the cycle's neutral
            // (t = −anim.s, t0 at the rest angle 0.5) up to CHOP.REACH at
            // the strike; the windup goes negative — blade tips back.
            let t = -anim.s, t0 = -Math.sin(0.5);
            fwdChop((t - t0) / (1 - t0) * CHOP.REACH);
          }
        } else if (e.utype === 'spearman') {
          // SPEAR STAB — a PIERCE, not a sweep: the shaft lies DEAD
          // LEVEL (aimM 0; the facing mirror gives left/right — the iso
          // aim slope ran the back of the shaft up OVER the shoulder on
          // the S-side diagonals, user call) at a height pinned just
          // UNDER the shoulder line, constant 90° the whole engagement.
          // Only the linear drive animates, like a SPRING: it compresses
          // back past the rest point, then releases in an accelerating
          // extension — t^1.6 keeps the early travel slow and the last
          // stretch a SNAP.
          // Tilted thrust knobs (live-tunable from the gallery's SPEAR
          // TUNE panel via window.__spearTune; untouched knobs keep
          // these defaults): TILT the shaft angle on the diagonals;
          // SLEN = foreshortening along the shaft — a tilted thrust
          // points INTO the iso depth, so it projects shorter, shrinking
          // the butt-over-shoulder AND tip-into-ground overshoots at
          // once; BACK/FWD/EXP the spring drive; TY the line height
          // (all dirs); DROP = how much LOWER the tilted diagonals ride
          // than the level profiles (one height dial per concern — the
          // old rotation-pivot knob had degenerated into a second,
          // overlapping height, user caught it).
          let TN = window.__spearTune || 0;
          // per-dir tilt: down-forward on the S-side diagonals, up-forward
          // on the N-side (pointing at an up-screen enemy), dead level at
          // the E/W profiles — the sign rides the facing's screen slope
          // (F.sy, mirror-invariant), the magnitude is the TILT knob.
          let tiltBase = TN.tiltDeg !== undefined ? TN.tiltDeg*Math.PI/180 : Math.PI/4;
          let fsy = RIG[e.dir].sy;
          let tilt = (fsy > 0.05 ? 1 : fsy < -0.05 ? -1 : 0) * tiltBase;
          // per-side height offsets from LINE HEIGHT: the down- and
          // up-tilts arrange the shaft oppositely around the shoulder
          // (S-side butt-high behind, N-side tip-high ahead) — one
          // shared offset kept fixing one side and breaking the other.
          let DROP  = TN.drop  !== undefined ? TN.drop  : 3.5; // S-side (down-tilts)
          let DROPN = TN.dropN !== undefined ? TN.dropN : -2;  // N-side (up-tilts)
          anim.spearLen = tilt ? (TN.slen !== undefined ? TN.slen : 0.75) : 1;
          anim.swordAimM = tilt;
          let t = Math.sin(0.5) - anim.s; // −0.43 compressed … +1.48 extended
          let drive = t < 0 ? (TN.back !== undefined ? TN.back : 7)*t
                            : (TN.fwd !== undefined ? TN.fwd : 5)*Math.pow(t, TN.exp !== undefined ? TN.exp : 1.6);
          let cr = Math.cos(tilt), nr = Math.sin(tilt);
          // HOLD-IN: the hold base pulled toward the chest (fraction of
          // the sword mount's forward offset) — at full offset the arms
          // were ALREADY stretched straight before the drive, so the
          // spring read as rubber; pulled in, compression = bent elbows
          // and full extension lands exactly on the snap.
          let bx = rest0.x * (TN.basek !== undefined ? TN.basek : 0.4);
          // up-tilts ride a touch FORWARD: their extension climbs, so the
          // same path read as starting BEHIND the body and ending at
          // center (caught at NE vs SW) — biased ahead, compression sits
          // at the center and the drive reads forward like the S-side.
          if (nr < -0.05) bx += 2.5;
          // TY is authoritative (no rest0.y floor — it blocked exploring
          // overhead lines; crown ~ -18.6, shoulder -8, waist -3)
          // The drive follows the tilt line through the WHOLE cycle: any
          // phase-split height term made the grip bounce mid-cycle and
          // each stab read as two motions.
          anim.grip = { x: bx + drive*cr,
                        y: (TN.ty !== undefined ? TN.ty : -6.4)
                           + drive*nr + (nr > 0.05 ? DROP : nr < -0.05 ? DROPN : 0) };
          anim.swordRot = Math.PI/2;
        } else {
          // wide DRAMATIC arc (user call): the grip rises up over the
          // head at the windup and drives down through the strike; the
          // neutral angle (0.5) still lands exactly on the rest anchor
          let phi = -0.63 - 1.3*ssa;
          // Radius: extended at the strike, and BOOSTED past the neutral
          // on the windup side so the HAND genuinely rises OVER the head
          // — the fist crests slightly above and behind it at full windup
          // (a short cocked radius left the overhead drama all wrist —
          // the arm barely moved, user caught it). The boost is zero AT
          // the neutral (s = sin 0.5), so the orbit still lands exactly
          // ON the rest anchor and engage can't pop.
          let base = isMountedUnit(e.utype) ? 3.4 : 4.2;
          let r = base - 1.2*anim.s + 18*Math.max(0, anim.s - 0.479);
          let r0 = base - SWING_NEUTRAL.rs;
          let ox = -r0*SWING_NEUTRAL.cos + r*Math.cos(phi);
          let oy = -r0*SWING_NEUTRAL.sin + r*Math.sin(phi);
          // The arc AIMS at the target (like the spear/bow): the offset
          // is authored with +x = attack direction, rotated by the aim
          // mapped INTO the mirrored body frame — the atan2 fold keeps
          // "up" up for either facing.
          let aim = aimAngle();
          anim.swordAimM = Math.atan2(Math.sin(aim), e.facing*Math.cos(aim));
          let cr = Math.cos(anim.swordAimM), nr = Math.sin(anim.swordAimM);
          anim.grip = { x: rest0.x + ox*cr - oy*nr, y: rest0.y + ox*nr + oy*cr };
          // blade sweep: OVER THE HEAD at the windup (tipped back ~−69°),
          // down through vertical, HORIZONTAL (90°) at the strike — never
          // past it into the ground. Quadratic in ssa through all three
          // user-set constraints incl. neutral(0.5) = the ~30° rest lean
          // (engage can't pop). (ssa: windup ~1.15 → strike −1.35.)
          anim.swordRot = 1.366 - 1.275*ssa - 0.831*ssa*ssa;
        }
        // Weight shifts back on windup, into the strike — but the BODY is
        // segmented: legs plant (stance), the torso leans hard from the
        // hips, the head counter-rotates to stay level. Mounted: the horse
        // gets only a small global surge; the rider does the leaning from
        // the saddle.
        let lean = 0.07 - 0.14*anim.s;
        if (isMountedUnit(e.utype)) {
          anim.lean = lean*0.18; anim.lunge = -0.5*anim.s;      // horse surge
          anim.upperLean = lean*0.8; anim.upperPivot = -12;     // rider from the saddle
        } else {
          // spearman: NO lean — the upperly rotation tilted the level
          // pierce line (caught at E/W); the lunge alone drives the body
          anim.upperLean = e.utype === 'spearman' ? 0 : lean;
          anim.upperLunge = -1.0*anim.s; // torso from the hips
          anim.upperPivot = -2.5; anim.stance = 1.6;
        }
      } else { anim.s = 0; anim.grip = { x: rest0.x, y: rest0.y }; }
    } else if (e.utype === 'archer') {
      // Draw cycle rides the REAL reload timer, so the nocked arrow
      // releases exactly when the real arrow leaves (works on MP guests).
      let rof = (UNITS.archer && UNITS.archer.rof) || T30(60), cd = e.atkCooldown || 0;
      anim.drawT = Math.min(1, Math.max(0, 1 - cd/(rof*0.85)));
      anim.justFired = cd > rof*0.85;
      anim.snapT = Math.max(0, (cd - rof*0.85)/(rof*0.15)); // string still snapping forward
      // draw starts ON the brace string (x 4.6, matching the rest bow)
      // and anchors at the chest — the old -6 full draw dragged the rear
      // arm way past the shoulder (overstretched, user call)
      anim.pull = 4.6 - 7.6*anim.drawT;
      // arm states: bow always in the left fist; the right hand is on
      // the string only while drawing — otherwise it IS the idle arm
      anim.gripS = -1;
      anim.armState = { '-1': 'grip',
        '1': (anim.swinging && !anim.justFired) ? 'support' : 'idle' };
      {
        let M = RIG_MOUNTS.archer.bow;
        anim.heldD = mountHeldD(M, R, F);
      }
      if (anim.swinging) {
        anim.theta = aimAngleBallistic();
        anim.upperLean = -0.10*anim.drawT;  // torso braces back into the draw
        anim.upperLunge = -0.5*anim.drawT;
        anim.upperPivot = -2.5; anim.stance = 1.4;
      }
    }

    // The head counter-rotates against the torso lean (stays near level —
    // eyes on the target) — the tell that the body is segmented.
    if (anim.upperLean) anim.headLean = -0.4*anim.upperLean;

    // One arm subpath shoulder→hand through a bent elbow. bend is signed
    // (elbow toward the left normal of shoulder→hand; the facing mirror
    // flips it with the context) and straightens as the arm extends. The
    // quadratic passes THROUGH the elbow at t=0.5, hence ctrl = mid + 2·n·off.
    const armPath = (sx0, sy0, hx, hy, bend, reach = 8) => {
      let dx = hx-sx0, dy = hy-sy0, d = Math.hypot(dx, dy) || 0.01;
      let off = bend ? bend * 2.6 * Math.max(0, 1 - d/reach) : 0;
      X.moveTo(sx0, sy0);
      // a zero-bend arm is a true line — a degenerate quadratic rasterizes
      // with subtly different antialiasing
      if (!off) X.lineTo(hx, hy);
      else X.quadraticCurveTo((sx0+hx)/2 - dy/d*2*off, (sy0+hy)/2 + dx/d*2*off, hx, hy);
    };

    // Where each hand IS this frame, in the mirrored body frame — the arm
    // pass draws to these, the held layer anchors its items on the same
    // values, so hands and grips can never drift apart. Memoized per
    // drawUnit invocation (anim is frozen for the frame; mounted units
    // draw their two arms in separate passes and would recompute).
    let _hands = null;
    const handTargets = () => _hands || (_hands = computeHandTargets());
    const computeHandTargets = () => {
      let hxo = humanXOffset, hyo = humanYOffset;
      // Lego-style shoulders: anchors sit ON the torso rim (narrower dress
      // rim for the female villager), never inside it — wide in every view
      // (tucked per-view shoulders were tried and rejected), and an arm
      // drawn behind the torso still shows its shoulder cap and hanging
      // length instead of vanishing into the body's cover.
      let shx = (e.utype==='villager' && e.female) ? 3.9 : 4.5;
      // rig-projected shoulders for EVERY humanoid — rim width and
      // near/far drop scale with the direction (anim.shDx/shDy from the
      // pose seam); profiles collapse to the centerline via shDx = 0
      let shdy = anim.shDy * shx;
      shx *= anim.shDx;
      let shF = shx+hxo, shR = -shx+hxo;
      let shFy = -8 + shdy + hyo, shRy = -8 - shdy + hyo;
      // SE reads slightly TURNED: the sword-side shoulder rides a touch
      // toward the facing (user call). Two-handed (dark-age) also applies
      // it at SW — the same shift in the mirrored frame — so the pair
      // stays an EXACT mirror; feudal SW keeps its cross-body shifts.
      if ((e.utype === 'militia' || e.utype === 'spearman') &&
          (e.dir === 0 || (e.dir === 2 && anim.twoHand))) shF += 0.8;
      // The walk swing is FORWARD/BACK motion. Facing the camera or away
      // (S/N) that axis is depth, not screen-x — an x swing there drags
      // the hands across the torso silhouette (vanishing behind it, or
      // smearing over the unit's back), so it maps to a small antiphase
      // bob instead.
      let nsView = faceOnView;
      let axial = nsView ? 0 : anim.armSwing;
      let bobY  = nsView ? anim.armSwing*0.4 : 0;
      // Idle/walk: arms hang extended, symmetric about the shoulders. In
      // the N/S views both arms hang RELAXED, straight down from the
      // shoulders with barely-bowed elbows (an inward point toward the
      // hips was tried and read tense, user call; bend signs flip per
      // side — armPath's bend is path-direction-relative).
      let front = nsView ? { x: shF-0.1, y: -3+bobY+hyo, bend: -0.15 }
                         : { x: shF+0.9+axial, y: -3.2+shdy+hyo, bend: 0.3 };
      let rear  = nsView ? { x: shR+0.1, y: -3-bobY+hyo, bend: 0.15 }
                         : { x: shR-0.9-axial, y: -3.2-shdy+hyo, bend: 0.3 };
      // Corpses keep the hanging default: drawCorpse suppresses the held
      // weapon and lays it on the ground — a grip target would leave the
      // toppled arms clutching empty air.
      if (e.corpseRot) return { front, rear, shF, shR, shFy, shRy };
      // A weapon-local grip point mapped into the mirrored body frame,
      // riding the aim rotation while swinging. The facing un-mirror
      // (X.scale(e.facing,1) in the held layer) folds ONLY into the x
      // rotation term — keep both weapons on this one spelling.
      const gripAt = (A, px, py) => {
        if (!anim.swinging) return { x: A.x+px+hxo, y: A.y+py+hyo };
        let c = Math.cos(anim.theta), n = Math.sin(anim.theta);
        return { x: A.x + e.facing*(px*c - py*n) + hxo, y: A.y + px*n + py*c + hyo };
      };
      // Off hand strapped to the BRACED shield's inner face — bound to
      // the SHIELD RIG's projected center, so the arm follows the plate
      // wherever the mount lands (the shield draws over, covering the
      // hand). Slung shields bind nothing (the off arm is idle).
      const shieldGrip = () => ({
        x: anim.shieldRest.x + hxo,
        y: anim.shieldRest.y + hyo,
        bend: anim.swArm === 'rear' ? 0.5 : -0.5
      });
      if (e.utype === 'villager') {
        let picking  = !moving && (e.task==='forage'||anim.carcassTarget); // farmers hold the scythe instead
        let fighting = !moving && !e.task && e.target && !picking && !anim.carcassTarget;
        if (anim.gripTask && anim.working) {
          // TWO-HANDED tool grip riding the swinging handle (the militia
          // B-mode treatment): grip fist partway up the shaft, support
          // fist below it, both rotated by the swing about the rig-
          // projected toolRest; twf mirrors the swing offsets with the
          // tool art. Saws stay one-handed (frame grip).
          // (same predicate as the tool draw: frame-forward sign, ties
          // by depth — the hands must mirror WITH the art)
          let twf = frameFwdSign();
          let c = Math.cos(anim.swing), n = Math.sin(anim.swing);
          let gx = anim.toolRest.x + twf*(2.2*c + 2.4*n), gy = anim.toolRest.y + 2.2*n - 2.4*c;
          let bend = 0.8;
          if (anim.sawing) { // hand wraps the saw's near frame upright, riding the stroke
            gx = anim.toolRest.x + twf*(anim.sawOff + 0.5); gy = anim.toolRest.y + 1.5; bend = 0.5;
          }
          let gT = armFrameSide(anim.gripS);
          if (gT === 'rear') rear = { x: gx, y: gy, bend: -bend };
          else front = { x: gx, y: gy, bend };
          if (anim.armState[-anim.gripS] === 'support') {
            // support fist further DOWN the handle — ON the handle LINE
            // (collinear with the grip vector (2.2,-2.4) about the
            // anchor; the old (-1.5,-1.7) sat up-back OFF the shaft and
            // the near arm floated misaligned, caught at NE)
            let sx2 = anim.toolRest.x + twf*(-0.9*c - 1.0*n), sy2 = anim.toolRest.y - 0.9*n + 1.0*c;
            let s2 = { x: sx2, y: sy2, bend: 0.5 };
            if (gT === 'rear') front = s2; else rear = s2;
          }
        }
        else if (anim.scythe) {
          // hand rides the snath through the sweep, about the RIG-
          // projected tool anchor (same predicate/side as every tool —
          // the fixed (2,−8) + facingNorth mirror was the last pre-rig
          // hand bind)
          let twf2 = frameFwdSign();
          let c2 = Math.cos(anim.sweep), n2 = Math.sin(anim.sweep);
          let gx = anim.toolRest.x + twf2*(1.2*c2 - 2.2*n2);
          let gy = anim.toolRest.y + 1 + 1.2*n2 + 2.2*c2;
          if (armFrameSide(anim.gripS) === 'rear') rear = { x: gx, y: gy, bend: -0.5 };
          else front = { x: gx, y: gy, bend: 0.5 };
        }
        else if (picking)   front = { x: 5.6+anim.pick*0.8, y: -5.5-anim.pick*3.5, bend: 0.6 };
        // (the rear arm keeps its IDLE hang during the jab — idle-state
        // arms never take attack-specific poses, user call)
        else if (fighting)  front = { x: 4.5+anim.jab*4.5, y: -6.5-anim.jab*1.5, bend: 0.6 };
        if (anim.barrow || anim.plowRig) {
          // both fists on the barrow's projected handle ends (barrowGrips
          // rides the same axes + axle rock drawBarrow draws with, so
          // hands and barrow can never drift apart in any facing) — the
          // PLOW rides the same weld, its work stroke fed in as the
          // shared rig shift so the arms pump with the drive.
          // -bob: fists pin to the COUNTER-BOBBED handles — the barrow
          // stays grounded while the shoulders bob, the arms absorb it.
          let g = barrowGrips(e, anim.barrowTilt || 0, anim.plowRig ? anim.plowOff : 0);
          let by = anim.carryRest.y - bob/UNIT_SCALE;
          // each fist takes the handle on ITS OWN side of the frame
          // (assigning near-handle-to-front-arm crossed the arms on the
          // diagonals — one hand read as missing, the other on the
          // wrong handle, user caught it at SE). Side comes from the
          // UNTILTED lateral axis: at the profiles the grips tie in
          // screen x and the axle rock flipped the tie-break every half
          // bob cycle — the fists hopped between handles (the E/W
          // "bouncing hands", user caught it twice)
          let bv = barrowAxes(e).ax.v;
          // second clause: at the MIRRORED profile (W) the front-depth
          // arm carries the other frame label than at E (R.d flips
          // under the mirror, the label fallback doesn't) — swap so the
          // visible near arm still gets the near/lower handle
          if ((Math.sign(bv.y) || 1) * bv.x < -0.005 ||
              (Math.abs(bv.x) <= 0.005 && e.facing < 0)) g = [g[1], g[0]];
          // REAL elbows: these arms run ~10 long, past armPath's default
          // reach of 8 — the bend damping clamped to ZERO and every bend
          // value drew dead-straight rods (why the elbows "weren't
          // used", user caught it). reach 14 restores the bow; one
          // shared positive bend bows BOTH elbows back-down (the same
          // world side — mirrored signs sent one elbow forward).
          // face-on (S/N) the arms run foreshortened toward the viewer
          // — sideways elbow bows read wrong there (user call): tiny
          // mirrored bends instead.
          let bF = faceOnView ? -0.15 : 0.55, bR = faceOnView ? 0.15 : 0.55;
          front = { x: anim.carryRest.x + g[0].x, y: by + g[0].y, bend: bF, reach: 14 };
          rear  = { x: anim.carryRest.x + g[1].x, y: by + g[1].y, bend: bR, reach: 14 };
        } else if (anim.carryShow) {
          // BOTH hands under the overhead load, elbows bowed outward —
          // hands and resource can never drift apart, every direction.
          // The spread rides the lateral axis's visible width: widest
          // face-on (S/N — arms clearly OUT holding the load, user
          // call), tapering to the profiles.
          let w = 2.2 + 2.3 * Math.abs(RIG[(e.dir + 2) & 7].sx);
          front = { x: w, y: anim.carryRest.y + 2.2, bend: -0.3 };
          rear  = { x: -w, y: anim.carryRest.y + 2.2, bend: 0.3 };
        }
      } else if (e.utype === 'militia' || e.utype === 'spearman' || isMountedUnit(e.utype)) {
        // ONE sword-hand bind for foot + spearman + mounted. bend per pose: the
        // cross-body arm SAGS (0.45); face-on vertical arms bow OUTWARD
        // (sign flips with the arm); else the standard reach bow.
        let g = { x: anim.grip.x+hxo, y: anim.grip.y+hyo,
                  bend: anim.faceOn ? (anim.swArm === 'rear' ? 0.35 : -0.35) : 0.5 };
        if (anim.swArm === 'rear') rear = g; else front = g;
        // DARK-AGE militia (no shield yet): the off hand JOINS the sword
        // — a TWO-HANDED grip, both fists on the SAME grip point in every
        // view (a 1.5 down-the-handle stack was tried and reverted — it
        // dragged one arm visibly lower, read as broken, user call).
        // Face-on the support elbow mirrors the grip's bend so the two
        // arms are exact mirrors. (Riders keep a hanging off arm —
        // reins; shielded tiers strap it below.)
        if (anim.twoHand) {
          let g2 = { x: g.x, y: g.y, bend: anim.faceOn ? -g.bend : 0.4 };
          if (anim.swArm === 'rear') front = g2; else rear = g2;
        }
        // the non-grip arm: shield state binds it to the shield's inner
        // face; support (two-hand) bound to g2 above; IDLE arms keep the
        // hanging defaults untouched — identical to the idle pose at all
        // times, attacks included (the counterswing was deleted, user call)
        if (anim.armState[-anim.gripS] === 'shield') {
          let sg = shieldGrip();
          if (anim.swArm === 'rear') front = sg; else rear = sg;
        }
      } else if (e.utype === 'archer') {
        // Front fist wraps the riser BELOW the arrow line (the arrow skims
        // over the hand, not through it) — closer grip keeps the arm bent;
        // rear hand tracks the string nock while drawing (the release
        // reads for free when it lets go).
        // the fist always reads at the BOTTOM of the riser: the grip's
        // bow-local side flips with the aim's cos so the rotated hand
        // never rides the upper handle (user call); ±90° aims converge
        // on the riser center gracefully
        let gy = 1.8 * ((anim.swinging ? Math.cos(anim.theta) : 1) >= 0 ? 1 : -1);
        front = { ...gripAt(GRIP_REST.archer, 7.2, gy), bend: 0.55 };
        if (anim.swinging && !anim.justFired) rear = { ...gripAt(GRIP_REST.archer, anim.pull, 0), bend: 0.9 };
      }
      return { front, rear, shF, shR, shFy, shRy };
    };
    // Upper-body pose: torso-and-up (arms, gear, head) leans/lunges from
    // a pivot — the hips on foot, the saddle when mounted — while legs or
    // horse stay planted. The head then counter-rotates inside (headly).
    const upperly = (fn) => {
      if (!anim.upperLean && !anim.upperLunge) { fn(); return; }
      X.save();
      if (faceOnView) {
        // Facing the camera (S) or away (N): forward is down/up-screen —
        // a sideways rotate reads as a SIDE attack. Lunge shifts along
        // the view axis; the lean foreshortens the torso instead.
        let sgn = e.dir === 1 ? 1 : -1;
        X.translate(0, sgn*(anim.upperLunge || 0)*0.6 + anim.upperPivot);
        X.scale(1, 1 - Math.abs(anim.upperLean || 0)*0.35);
        X.translate(0, -anim.upperPivot);
      } else {
        X.translate(anim.upperLunge || 0, anim.upperPivot);
        X.rotate(anim.upperLean || 0);
        X.translate(0, -anim.upperPivot);
      }
      fn(); X.restore();
    };
    const headly = (fn) => {
      // no counter-rotation in the S/N views — the torso doesn't rotate there
      if (!anim.headLean || faceOnView) { fn(); return; }
      X.save();
      X.translate(humanXOffset, -11+humanYOffset);
      X.rotate(anim.headLean);
      X.translate(-humanXOffset, 11-humanYOffset);
      fn(); X.restore();
    };
    // ---- end hand-pose seam ----

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
      // One spelling of the body ellipse per view. Armor techs leave the
      // horse untouched, but every mount wears a team-color saddle blanket
      // — the always-on team tell (a mailed rider is mostly steel).
      // Clipped inside the body so the silhouette stays one piece.
      const drawHorseBody = (bx,by,brx,bry) => {
        X.fillStyle=coat;
        X.beginPath(); X.ellipse(bx,by,brx,bry,0,0,Math.PI*2); X.fill(); X.stroke();
        X.save();
        X.beginPath(); X.ellipse(bx,by,brx-0.5,bry-0.5,0,0,Math.PI*2); X.clip();
        let dx0 = bx-brx*0.55, dw = brx*1.1, dy0 = by-bry, hem = by+bry*0.7;
        // hanging cloth: the hem dips at the middle
        const drapePath = () => {
          X.beginPath();
          X.moveTo(dx0, dy0); X.lineTo(dx0+dw, dy0);
          X.lineTo(dx0+dw, hem-0.9);
          X.quadraticCurveTo(bx, hem+1.5, dx0, hem-0.9);
          X.closePath();
        };
        drapePath(); X.fillStyle=tc; X.fill();
        // volume: lit from the upper-left, curving away lower-right
        X.save(); drapePath(); X.clip();
        X.fillStyle='rgba(255,255,255,0.25)'; X.fillRect(dx0, dy0, dw, 1.5);
        X.fillStyle='rgba(255,255,255,0.10)'; X.fillRect(dx0, dy0, dw*0.3, bry*2);
        X.fillStyle='rgba(0,0,0,0.18)';       X.fillRect(dx0+dw*0.7, dy0, dw*0.3, bry*2);
        X.fillStyle='rgba(0,0,0,0.15)';       X.fillRect(dx0, by+bry*0.2, dw, bry);
        // light seam stitched above the hem
        X.strokeStyle='rgba(255,255,255,0.35)'; X.lineWidth=0.7/UNIT_SCALE;
        X.beginPath(); X.moveTo(dx0+0.6, hem-2.1); X.quadraticCurveTo(bx, hem+0.3, dx0+dw-0.6, hem-2.1); X.stroke();
        X.restore();
        // hem outline + cast shadow onto the barrel below
        X.strokeStyle='rgba(0,0,0,0.5)'; X.lineWidth=1/UNIT_SCALE;
        X.beginPath(); X.moveTo(dx0, hem-0.9); X.quadraticCurveTo(bx, hem+1.5, dx0+dw, hem-0.9); X.stroke();
        X.fillStyle='rgba(0,0,0,0.15)';
        X.beginPath();
        X.moveTo(dx0, hem-0.9); X.quadraticCurveTo(bx, hem+1.5, dx0+dw, hem-0.9);
        X.quadraticCurveTo(bx, hem+3.6, dx0, hem-0.9);
        X.closePath(); X.fill();
        X.restore();
        X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
      };

      if (useDir === 7 || useDir === 0) {
        // East profile / Southeast diagonal (same construction, SE compressed)
        // Profile k=1; diagonal k=0.72 — at 0.85 the diagonal is so close
        // to the profile that SW/W read as the same sprite. The 3/4 view is sold
        // by real foreshortening plus receding hindquarters (legs below).
        let k = useDir === 7 ? 1 : 0.72;
        // (tail drawn earlier in drawMountLayer, behind the legs)
        // Body capsule
        X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
        drawHorseBody(0,-6,7.4*k,4.9);
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
        X.strokeStyle='#000'; X.lineWidth=1.2/UNIT_SCALE;
        drawHorseBody(0,-6,6.6,4.9);
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
        drawHorseBody(0,-5.5,5.6,5.2);
        horseHeadFront = () => {
          let nod2 = (!moving) ? Math.sin(tick*0.05+e.id)*0.8 : 0;
          // the head hangs CENTERED — the sword clears it by moving to
          // the grip hand's side instead (user call)
          X.save(); X.translate(0,-1+nod2);
          X.scale(1.35, 1.35); X.translate(-4.1, 0);
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
        // North (back view): neck/head face away, CENTERED on the body
        // (they sat +3 off-center, user caught it), body and tail closest
        X.save(); X.translate(0,nod);
        X.fillStyle=coat;
        X.beginPath(); X.ellipse(0,-10,2.9,4.6,0,0,Math.PI*2); X.fill(); X.stroke(); // neck
        ear(-1.5,-15,-0.25); ear(1.7,-14.9,0.25);
        X.beginPath(); X.ellipse(0,-13.1,2.6,2.8,0,0,Math.PI*2); X.fill(); X.stroke(); // back of head
        X.fillStyle=maneC;
        X.beginPath(); X.ellipse(0,-11.8,1.3,4.2,0,0,Math.PI*2); X.fill(); // mane down the crest
        X.restore();
        // Body drawn over the neck base
        drawHorseBody(0,-5,5.8,5.3);
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
      // Human legs: they never ride the upper-body LEAN (rotation), but
      // they do follow the LUNGE below. During actions the stance spreads
      // (front foot steps out, rear braces).
      // POSE-RIG legs: hips sit ±lat on the body's lateral axis and the
      // stride swings along the FACING, both projected per dir — profile
      // walkers scissor full screen-x strides, face-on walkers read as a
      // small vertical alternation, and on diagonals the NEAR leg stands
      // slightly lower (closer to the camera) than the far one.
      let walk = moving ? Math.sin(tick*0.4+e.id)*2.5 : 0;
      let st = anim.stance || 0;
      // legs FOLLOW the attack lunge, on the SAME axis upperly translates
      // the torso (view-axis y at S/N, screen-x else): hips ride half of
      // it, the front foot steps fully with it, the rear foot stays
      // planted — the segmented torso can no longer detach from standing
      // legs. upperLunge is only set by action seams: idle/walk exact.
      let lgx = 0, lgy = 0;
      if (anim.upperLunge) {
        if (faceOnView) lgy = (e.dir === 1 ? 1 : -1)*anim.upperLunge*0.6;
        else lgx = anim.upperLunge;
      }
      // lateral screen separation, floored so profile legs don't merge
      let latX = 2.8 * R.sx, latY = 2.8 * R.sy;
      if (Math.abs(latX) < 0.6) latX = 0.6;
      const leg = (s, stride) => { // s = ±1 lateral side; stride rides the facing
        let f = stride > 0 ? 1 : 0; // the stride-forward leg does the stepping
        let hx2 = e.facing * (s * latX) + humanXOffset + lgx*0.5;
        let hy2 = -2 - bob + lgy*0.5;
        let fx2 = e.facing * (s * latX + stride * F.sx) + humanXOffset + lgx*f;
        let fy2 = 3 + s * latY + stride * F.sy + lgy*f;
        // KNEE: the elbow treatment — one quadratic, control point pushed
        // along the FACING (foreshortens at S/N for free). The forward-
        // swinging leg flexes on the walk, the front leg crouches under
        // an attack lunge; a braced rear leg stays STRAIGHT (kneeK 0 =
        // straight line, so the idle stance is bit-identical).
        let kneeK = Math.min(2, Math.max(0, stride)*0.5 + f*Math.hypot(lgx, lgy)*0.35);
        X.beginPath();
        // hip anchored INSIDE the torso (bottom edge ≈ −1; legs draw
        // behind it) so the lowered-side leg never detaches from the body
        X.moveTo(hx2, hy2);
        if (kneeK) X.quadraticCurveTo((hx2+fx2)/2 + e.facing*F.sx*kneeK,
                                      (hy2 + fy2 - bob)/2 + F.sy*kneeK, fx2, fy2 - bob);
        else X.lineTo(fx2, fy2 - bob);
        X.strokeStyle = '#000000'; X.lineWidth = 3.0/UNIT_SCALE; X.lineCap = 'round'; X.stroke();
        X.strokeStyle = '#5b3a1e'; X.lineWidth = 1.5/UNIT_SCALE; X.stroke();
        X.fillStyle = '#3a2412';
        X.beginPath(); X.arc(fx2, fy2 + 0.4 - bob, 1.4, 0, Math.PI*2); X.fill();
      };
      // far leg first, near leg over it (near side = the lateral side
      // whose depth points at the camera; equal at S/N — order moot)
      let sNear = (2.8 * R.d) >= 0 ? 1 : -1;
      leg(-sNear, -sNear * (walk + (sNear > 0 ? 0.6 : 1) * st));
      leg(sNear, sNear * (walk + (sNear > 0 ? 1 : 0.6) * st));
      X.lineCap = 'butt';
    }
    // (mounted riders stay legless — legs over the drape read as clutter
    // at this scale; the saddle cloth carries the seated silhouette)
    drawUpperBody();
    }; // end drawBodyLayer
    // Arms: shoulder→hand to the targets computed at the hand-pose seam —
    // the same values the held layer anchors its items on. One shared path,
    // one outline stroke, one skin stroke. Hoisted out of drawBodyLayer so
    // the mounted sword arm can be sequenced against the HELD layer.
    const drawArms = (which) => { // 'front'/'rear' = that hand-target's arm only; omit for both
      let hands = handTargets();
      X.beginPath();
      if (which !== 'front')
        armPath(hands.shR, hands.shRy, hands.rear.x, hands.rear.y, hands.rear.bend, hands.rear.reach);
      if (which !== 'rear')
        armPath(hands.shF, hands.shFy, hands.front.x, hands.front.y, hands.front.bend, hands.front.reach);
      // Fatter than the legs on purpose — chunky lego-limb read keeps the
      // arm legible even where it brushes the torso edge.
      X.strokeStyle='#000000';X.lineWidth=4.2/UNIT_SCALE;X.lineCap='round';X.stroke();
      X.strokeStyle='#edc9a0';X.lineWidth=2.6/UNIT_SCALE;X.stroke();
      // SHORT SLEEVE over the upper arm: the first stretch of the SAME
      // quadratic (de Casteljau split), stroked in the tunic's team
      // color — every humanoid gets clothed shoulders and the arm reads
      // as attached to the outfit, not bare from the joint.
      const sleeve = (sx0, sy0, hx2, hy2, bend, reach = 8) => {
        let dx = hx2-sx0, dy = hy2-sy0, d = Math.hypot(dx, dy) || 0.01;
        let off = bend ? bend * 2.6 * Math.max(0, 1 - d/reach) : 0;
        let cx = (sx0+hx2)/2 - dy/d*2*off, cy = (sy0+hy2)/2 + dx/d*2*off;
        const t = 0.18;
        let ax = sx0+(cx-sx0)*t, ay = sy0+(cy-sy0)*t;
        let bx2 = cx+(hx2-cx)*t, by2 = cy+(hy2-cy)*t;
        X.beginPath(); X.moveTo(sx0, sy0);
        X.quadraticCurveTo(ax, ay, ax+(bx2-ax)*t, ay+(by2-ay)*t);
        // PUFFY on purpose — slightly wider than the arm so the sleeve
        // reads as cloth over the limb (user call, after trying slim)
        X.strokeStyle='#000000';X.lineWidth=5.4/UNIT_SCALE;X.stroke();
        X.strokeStyle=tc;X.lineWidth=3.6/UNIT_SCALE;X.stroke();
      };
      if (which !== 'front')
        sleeve(hands.shR, hands.shRy, hands.rear.x, hands.rear.y, hands.rear.bend, hands.rear.reach);
      if (which !== 'rear')
        sleeve(hands.shF, hands.shFy, hands.front.x, hands.front.y, hands.front.bend, hands.front.reach);
      X.lineCap='butt';
      // Head/headwear drawing below relies on the black outline stroke —
      // restore it after the skin-colored arm pass.
      X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
    };
    const drawUpperBody = () => {
    upperly(() => {
    // (Arms are NEVER drawn inside the body layer — every humanoid's
    // arms are depth-sorted parts at the layer block.)
    // The archer's CASTLE-age quiver rides on the back: facing the camera
    // it peeks BEHIND the shoulder (drawn before the torso); facing away
    // it's strapped across the near side (drawn after, see below).
    const drawQuiver = () => {
      X.save(); X.translate(-4.2+humanXOffset,-9+humanYOffset); X.rotate(-0.3);
      X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
      // arrows peeking out: shafts + red fletchings
      X.strokeStyle='#000';X.lineWidth=1.6/UNIT_SCALE;X.lineCap='round';
      X.beginPath();X.moveTo(-0.8,-3.2);X.lineTo(-0.8,-5.4);X.moveTo(0.8,-3.2);X.lineTo(0.8,-5.6);X.stroke();
      X.lineCap='butt';
      // Bare shafts until Fletching — the tech adds LIGHT-team-color
      // feathers (matches the nocked arrow and the cap plume)
      if (eq && eq.fletched) {
        X.fillStyle=teamColorLight(e.team);
        X.beginPath();X.arc(-0.8,-5.4,0.9,0,Math.PI*2);X.fill();
        X.beginPath();X.arc(0.8,-5.6,0.9,0,Math.PI*2);X.fill();
      }
      // leather tube
      X.fillStyle='#7a5230';X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
      X.beginPath();X.rect(-1.8,-3.6,3.6,7.2);X.fill();X.stroke();
      X.restore();
    };
    let hasQuiver = !!(eq && eq.quiver);
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

    // Armor techs read on the torso (drawn before the volume pass so the
    // lighting shades the armor too, and clipped inside the tunic outline
    // so the silhouette stays one piece). Scale: metal rows over the lower
    // torso, team color keeps the shoulders. Chain: full mail under a
    // team-color tabard stripe so team identity survives.
    if (eq && eq.torso) {
      let acx = humanXOffset, acy = -6 + humanYOffset;
      X.save();
      X.beginPath();X.arc(acx,acy,4.6,0,Math.PI*2);X.clip();
      // Multiply the inherited alpha — drawUnit runs under the corpse
      // fade's globalAlpha; an absolute reset would flash the armor solid.
      let ga = X.globalAlpha;
      if (eq.torso === 'scale') {
        X.fillStyle=eq.metal;X.globalAlpha=ga*0.85;
        X.fillRect(acx-5,acy-1.2,10,6.2);X.globalAlpha=ga;
        X.strokeStyle='rgba(0,0,0,0.4)';X.lineWidth=0.9/UNIT_SCALE;
        for(let ry=0;ry<3;ry++){
          let sy2 = acy + 0.1 + ry*1.6;
          for(let rx=-2;rx<=2;rx++){
            X.beginPath();X.arc(acx+rx*2+(ry%2),sy2,1.1,0,Math.PI);X.stroke();
          }
        }
        // hard upper edge so the armor reads as a piece, not a stain
        X.strokeStyle='rgba(0,0,0,0.5)';X.lineWidth=0.9/UNIT_SCALE;
        X.beginPath();X.moveTo(acx-5,acy-1.2);X.lineTo(acx+5,acy-1.2);X.stroke();
      } else { // chain
        // Chain reuses the scale texture language — finer rows over the
        // WHOLE torso in a fixed light steel that stays brighter than any
        // forge-tier scale — so the armor tiers read as coverage +
        // brightness steps of one idea.
        X.fillStyle='#dde3ea';X.globalAlpha=ga*0.95;
        X.fillRect(acx-5,acy-5,10,10);X.globalAlpha=ga;
        X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8/UNIT_SCALE;
        for(let ry=0;ry<7;ry++){
          let sy2 = acy - 4.6 + ry*1.4;
          for(let rx=-3;rx<=3;rx++){
            X.beginPath();X.arc(acx+rx*1.6+(ry%2?0.8:0),sy2,0.9,0,Math.PI);X.stroke();
          }
        }
      }
      X.restore();
      X.strokeStyle='#000000';X.lineWidth=1/UNIT_SCALE;
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

    // (no arm draws here — arms are depth-sorted parts for every humanoid)
    // Head lateral turn on screen (0 face-on, ±.707 diagonal, ±1 profile)
    // — the helmet's face details ride it through all 8 dirs.
    let hturn = e.facing * RIG[e.dir].sx;
    headly(() => {
    if (e.facingNorth) {
      // Facing North (away from camera): Draw back of headwear/hair covering the head (no face)
      if(eq){
        drawHelmet(eq, humanXOffset, humanYOffset, true, e.team, e.id, hturn);
      } else {
        // Villager (the only hatless humanoid): back of blonde hair
        X.fillStyle = '#b58e3d';
        if(e.female){
          // Back view shares the FRONT hairdo's silhouette (one crown
          // height in EVERY view; same outer edges and shoulder-length
          // tips), solid across the back of the head, ending in a soft
          // nape curve at the shoulders so the dress reads below it.
          // POSE-RIG turn bias: on the back quarters (NW/NE) the hair
          // mass shifts toward the back-of-head side, matching the front
          // views' strand asymmetry (N stays symmetric).
          let bs = -0.5 * Math.abs(RIG[e.dir].sx), hx = humanXOffset + bs, hy = humanYOffset;
          X.beginPath();
          X.moveTo(-3.4+hx,-6.6+hy);                             // left tip at the shoulder
          X.quadraticCurveTo(-4.6+hx,-8+hy,-4.7+hx,-10.5+hy);    // left outer edge up
          X.quadraticCurveTo(-5+hx,-14+hy,-4.2+hx,-15.4+hy);     // into the crown's left end
          X.arc(hx,-15.4+hy,4.2,Math.PI,0);                      // over the top of the head
          X.quadraticCurveTo(5+hx,-14+hy,4.7+hx,-10.5+hy);       // right outer edge down
          X.quadraticCurveTo(4.6+hx,-8+hy,3.4+hx,-6.6+hy);       // right tip
          X.quadraticCurveTo(0+hx,-4.9+hy,-3.4+hx,-6.6+hy);      // soft nape curve
          X.closePath();X.fill();X.stroke();
        } else {
          X.beginPath();X.arc(humanXOffset,-14+humanYOffset,4.2,0,Math.PI*2);X.fill();X.stroke();
        }
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
      if(eq){
        drawHelmet(eq, humanXOffset, humanYOffset, false, e.team, e.id, hturn);
      } else {
        // Villager (the only hatless humanoid): natural blonde hair
        X.fillStyle = '#b58e3d';
        if(e.female){
          // The whole hairdo (crown + strands) is ONE path with a single
          // fill and stroke, so the outline traces the outer silhouette and
          // the pieces can't read as disconnected. The crown arc runs over
          // the top of the head between the strands' upper ends; the
          // hairline height matches the male cap so the face stays visible.
          // POSE-RIG hair: the hairdo anchors to the BACK of the head and
          // rides its rotation. u = |F.sx| is the head's turn off face-on
          // (0 = S, .707 = 3/4, 1 = profile); the mirrored frame keeps
          // the back of the head at −x, so ONE parametric path covers
          // every front direction: the back strand stays full while the
          // front strand recedes to a rim hugging the head edge, and the
          // face opening biases toward the facing (with the eyes).
          let u = Math.abs(RIG[e.dir].sx), hx = humanXOffset, hy = humanYOffset;
          const L = (a, b) => a + (b - a) * u;
          X.beginPath();
          X.moveTo(L(-3.4,-3.6)+hx, L(-6.6,-6.4)+hy);                                          // back strand tip
          X.quadraticCurveTo(L(-4.6,-4.7)+hx, -8+hy, L(-4.7,-4.9)+hx, -10.5+hy);               // back outer edge up
          X.quadraticCurveTo(L(-5,-5.2)+hx, -14+hy, -4.2+hx, -15.4+hy);                        // into the crown's back end
          X.arc(hx, -15.4+hy, 4.2, Math.PI, 0);                                                // over the top of the head
          X.quadraticCurveTo(L(5,4.4)+hx, L(-14,-15)+hy, L(4.7,4.3)+hx, L(-10.5,-14.6)+hy);    // front outer edge down
          X.quadraticCurveTo(L(4.6,4.2)+hx, L(-8,-14.4)+hy, L(3.4,4.1)+hx, L(-6.6,-14.5)+hy);  // front strand tip (recedes with the turn)
          X.quadraticCurveTo(L(2.9,4)+hx, L(-8.5,-14.7)+hy, L(3,4)+hx, L(-11,-14.9)+hy);       // front inner edge up
          X.quadraticCurveTo(L(3.1,3.9)+hx, L(-14,-15.1)+hy, L(2.7,3.8)+hx, -15.4+hy);
          X.lineTo(L(-2.7,-2.4)+hx, -15.4+hy);                                                 // hairline across the forehead
          X.quadraticCurveTo(L(-3.1,-2.8)+hx, L(-14,-11.5)+hy, L(-3,-2.5)+hx, L(-11,-8)+hy);   // back inner edge down
          X.quadraticCurveTo(L(-2.9,-2.6)+hx, L(-8.5,-7)+hy, L(-3.4,-3.6)+hx, L(-6.6,-6.4)+hy);
          X.closePath();
          X.fill();X.stroke();
        } else {
          X.beginPath();
          X.arc(humanXOffset, -16+humanYOffset, 3.2, Math.PI, 0);
          X.fill(); X.stroke();
        }
      }
    }

    // Head/helmet highlight: small crescent on the upper-left for volume
    X.save();
    X.beginPath();X.arc(humanXOffset,-14.5+humanYOffset,4.1,0,Math.PI*2);X.clip();
    X.fillStyle='rgba(255,255,255,0.25)';
    X.beginPath();X.arc(humanXOffset-1.8,-16.5+humanYOffset,2.6,0,Math.PI*2);X.fill();
    X.restore();
    }); // end headly

    if (hasQuiver && e.facingNorth) drawQuiver();
    }); // end upperly (torso and up)
    }; // end drawUpperBody (the front-facing horse head is deferred
    // further: it draws after the held-items layer, so the horse's head
    // is in front of the rider AND the resting sword)

    // ONE sword draw for militia + mounted (they differ only by the
    // rider offsets): pose comes entirely from the sword seam — grip
    // anchor, aim fold, face-on chop foreshorten (fwdK: 0 = edge-on
    // sliver, negative = flipped down), edge-on art selection (faceOn),
    // rest = the swing's neutral frame.
    const drawSwordHeld = (ox2, oy2) => {
      X.save();
      X.translate(anim.grip.x + ox2, anim.grip.y + oy2);
      if (anim.swinging) {
        X.rotate(anim.swordAimM);
        if (anim.fwdK !== undefined) X.scale(1, anim.fwdK);
      }
      let rot = anim.swinging ? anim.swordRot : anim.restRot;
      if (e.utype === 'spearman') drawBigSpear(rot, weaponTier, anim.spearLen || 1);
      else drawBigSword(rot, weaponTier, anim.faceOn);
      X.restore();
    };

    // Carried resource at the CARRY RIG's mount — its OWN depth-sorted
    // part (independent of the tool, so chop-while-carrying sorts the
    // axe and the load separately). Each art keeps its shape; anchors
    // are small offsets about anim.carryRest.
    const drawCarriedLoad = (part) => {
      if (!anim.carryShow && !anim.barrow && !anim.plowRig) return;
      if (part === 'farRod' && !anim.barrow && !anim.plowRig) return;
      X.save();
      // the barrow COUNTER-BOBS like the legs: the whole unit origin
      // rides the walk bob (drawUnit's translate), so without this the
      // wheel bounced off the ground (user caught it — twice). The
      // overhead carry keeps riding the bob: it's held, not wheeled.
      // bob/UNIT_SCALE: the origin bob is applied PRE-scale, this cancel
      // runs INSIDE the 1.25x art frame — unscaled it over-cancelled by
      // 25% and a sub-pixel bounce survived (user caught it)
      X.translate(anim.carryRest.x, anim.carryRest.y - (anim.barrow ? bob/UNIT_SCALE : 0));
      if (anim.barrow || anim.plowRig) {
        // the projected-box barrow rig (see drawBarrow) — the cargo art
        // draws INSIDE the tray at the slot the painter order provides,
        // shrunk and recentered (the arts keep their overhead centroids;
        // the logs hang way off the back)
        drawBarrow(e, anim.plowRig ? anim.plowOff/3.6 : moving,
                   anim.barrowTilt || 0, anim.barrow && anim.carryShow ? (p) => {
          X.save();
          // per-art seating: the tall stone stack lifts clear of the
          // tray's underside AND shrinks to the tray footprint (full
          // size overflowed the front rim and tangled with the near
          // arm at E, user call); head-on the log stack drops back
          // into the tray mouth (it floated above the rim at S)
          X.translate(p.x + (e.carryType === 'stone' ? 0.8 : 0),
                      p.y - (e.carryType === 'stone' ? 1.2 : 0)
                          + (e.carryType === 'wood' && faceOnView ? 1.7 : 0));
          if (e.carryType === 'stone') X.scale(0.8, 0.8);
          // full-size, icon-readable (0.75 made the resource illegible
          // at game zoom, user call) — the tray walls crop the base
          drawLoadArt();
          X.restore();
        } : null, part, anim.plowRig ? 'plow' : 'barrow',
                   anim.plowRig ? anim.plowOff : 0);
        X.restore(); return;
      }
      drawLoadArt();
      X.restore();
    };
    // the six per-resource load arts, drawn about the current origin —
    // the overhead carry calls this at carryRest, the barrow inside its
    // tray slot
    const drawLoadArt = () => {
        X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
        if(e.carryType==='wood'){
          if(anim.barrow){
            // BARROW cut: short fat rounds — same grain-forward idiom,
            // but squared into the tray's box footprint like the other
            // loads (the long shoulder logs overshot the tray, user
            // call: "shorter and fatter")
            // dead simple (user call): two level rounds, one exactly
            // atop the other — no tilt, no stagger
            X.save();
            const slog=(lx,ly)=>{
              X.fillStyle='#6e473b';X.beginPath();
              X.moveTo(lx+1.8,ly-1.9);X.lineTo(lx-2.2,ly-1.9);
              X.arc(lx-2.2,ly,1.9,-Math.PI/2,Math.PI/2,true);
              X.lineTo(lx+1.8,ly+1.9);X.closePath();X.fill();X.stroke();
              X.fillStyle='#ebd2b0';X.beginPath();X.ellipse(lx+1.8,ly,1.9,2.1,0,0,Math.PI*2);X.fill();X.stroke();
              X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8/UNIT_SCALE;
              X.beginPath();X.arc(lx+1.8,ly,0.95,0,Math.PI*2);X.stroke();
              X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
            };
            slog(0,1.2); slog(0,-2.6);
            X.restore();
            return;
          }
          // Two logs over the shoulder, one atop the other so BOTH round
          // end grains face the camera — side-by-side logs overlap and
          // read as one thick log with a single grain.
          X.save();X.translate(0.5,0);X.rotate(-0.18);
          const log=(lx,ly)=>{
            // body: flat at the grain end, ROUNDED cap at the far end —
            // a sawn log is blunt, not square-cut on both faces
            X.fillStyle='#6e473b';X.beginPath();
            X.moveTo(lx+0.5,ly-1.7);X.lineTo(lx-8.6,ly-1.7);
            X.arc(lx-8.6,ly,1.7,-Math.PI/2,Math.PI/2,true);
            X.lineTo(lx+0.5,ly+1.7);X.closePath();X.fill();X.stroke();
            X.fillStyle='#ebd2b0';X.beginPath();X.ellipse(lx+0.5,ly,1.8,2.0,0,0,Math.PI*2);X.fill();X.stroke();
            X.strokeStyle='rgba(0,0,0,0.35)';X.lineWidth=0.8/UNIT_SCALE;
            X.beginPath();X.arc(lx+0.5,ly,0.8,0,Math.PI*2);X.stroke();
            X.strokeStyle='#000';X.lineWidth=1/UNIT_SCALE;
          };
          log(4,1.6); log(2.2,-1.6);
          X.restore();
        } else if(e.carryType==='stone'){
          // Comically oversized haul: a big cut block with a smaller one
          // stacked on top, hoisted on the shoulder.
          X.save();X.translate(-1,-1);
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
          X.save();X.translate(0,0.5);
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
          X.save();X.translate(-0.5,1);
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
    };
    // Tools & weapons (animated swinging swings during active tasks)
    const drawHeldLayer = () => {
    if(e.utype==='villager'){
      // Work-swing phase and the at-site gate live at the hand-pose seam
      // (anim.*) — shared with the arm pass.
      let atSite = anim.atSite, working = anim.working, swing = anim.swing;
      // The tool POINTS ALONG THE FACING: art mirror = the facing's
      // frame-forward sign (a depth-sign flip inverted NW/NE, user
      // caught it); the face-on ties (S/N, no lateral forward) fall to
      // the depth sign — S ahead, N mirrored away.
      let twf = frameFwdSign();
      // One impact burst per cycle, right as the tool lands. Detected by the
      // cycle COUNTER advancing between frames, not by a frame happening to
      // land inside the narrow strike window — at 4x speed that window (7%
      // of a ~0.15s cycle ≈ 10ms) is shorter than one frame, so impacts
      // dropped nondeterministically and the work sounds/particles
      // stuttered. Tracked in workSwingCycles (js/core.js), not
      // `e._swingCyc` — entities get wholesale-replaced by every sync,
      // which would wipe that field and fire extras. Never during the
      // outline mask pass: it would consume this cycle's one impact (and
      // spawn duplicate particles) before the real draw.
      let swingCyc = Math.floor(anim.phRaw);
      let prevCyc = workSwingCycles.get(e.id);
      let impact = !window._maskDraw && working && prevCyc !== undefined && swingCyc !== prevCyc;
      if(!window._maskDraw && working) workSwingCycles.set(e.id, swingCyc);
      // work audio at the tool's VISUAL impact; every other swing at 4x
      // (at speed the full rate reads as machine-gun clatter)
      const workSound = (name, x, y) => {
        if (window.playSound && (GAME_SPEED < 4 || swingCyc % 2 === 0)) playSound(name, x, y);
      };
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
          workSound('chop', hitX, hitY);
        }
        if (anim.sawing) {
          // Bow saw: bowed wooden frame over a straight bright blade,
          // held at trunk height and stroked along the blade (sawOff —
          // the same value the hand target rides). Local +x = forward.
          // Comically OVERSIZED on purpose (same exaggeration as the
          // stone haul) — a Castle tech should read at one glance.
          X.save();X.translate(anim.toolRest.x+anim.sawOff*twf, anim.toolRest.y);X.scale(twf,1);
          X.strokeStyle='#000000';X.lineWidth=3.6/UNIT_SCALE;X.lineCap='round';X.lineJoin='round';
          X.beginPath();X.moveTo(0,4.5);X.quadraticCurveTo(0.8,-4.5,7.5,-4.5);X.quadraticCurveTo(14.2,-4.5,15,4.5);X.stroke();
          X.strokeStyle='#8B4513';X.lineWidth=2.0/UNIT_SCALE;X.stroke();
          // serrated bright blade — teeth ticks under a bold chord
          X.strokeStyle='#000000';X.lineWidth=2.8/UNIT_SCALE;
          X.beginPath();X.moveTo(-0.4,4.5);X.lineTo(15.4,4.5);X.stroke();
          X.strokeStyle='#f2f6fb';X.lineWidth=1.4/UNIT_SCALE;X.stroke();
          X.strokeStyle='#000000';X.lineWidth=0.9/UNIT_SCALE;
          X.beginPath();
          for(let tx2=1;tx2<15;tx2+=2){ X.moveTo(tx2,5.1); X.lineTo(tx2+1,6.1); X.lineTo(tx2+2,5.1); }
          X.stroke();
          X.lineCap='butt';
          X.restore();
        } else {
        X.save();X.translate(anim.toolRest.x,anim.toolRest.y);X.scale(twf,1);X.rotate(swing);
        // Long handle
        strokeShaft(0, 1, 9, -13, 3.4, 1.8);
        // Felling-axe head, authored in a shaft-aligned frame (+x along
        // the handle, +y toward the strike): socket wraps the shaft end,
        // cheeks flare into a curved cutting edge facing the swing, small
        // poll behind the shaft; bright bevel along the edge. Wood-line
        // techs read on the tool itself: Double-Bit Axe adds the LITERAL
        // second blade on the poll side; Bow Saw is the polished tier
        // (dark→bright, same language as forging).
        const axeHead = () => {
          X.beginPath();
          X.moveTo(-1.6,-1.2);X.lineTo(1.6,-1.2);
          X.quadraticCurveTo(2.8,0.8,3.3,3.4);
          X.quadraticCurveTo(3.5,4.7,3.0,5.2);
          X.quadraticCurveTo(0,6.6,-3.0,5.2);
          X.quadraticCurveTo(-3.5,4.7,-3.3,3.4);
          X.quadraticCurveTo(-2.8,0.8,-1.6,-1.2);
          X.closePath();X.fill();X.stroke();
          X.save();
          X.strokeStyle='#fff';X.lineWidth=1.4/UNIT_SCALE;
          X.beginPath();X.moveTo(-2.7,5.1);X.quadraticCurveTo(0,6.3,2.7,5.1);X.stroke();
          X.restore();
        };
        X.save();X.translate(9,-13);X.rotate(AXE_HEAD_ROT);
        X.fillStyle = hasUpgrade(e.team,'bow_saw') ? '#f2f6fb' : '#b8bfc6';
        X.strokeStyle='#000000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
        if (hasUpgrade(e.team,'double_bit_axe')) {
          // smaller mirrored bit where the poll was — main head's socket draws over the join
          X.save();X.scale(0.72,-0.72);axeHead();X.restore();
        }
        axeHead();
        X.restore();
        X.restore();
        }
      } else if((e.task==='mine_gold'||e.task==='mine_stone')&&e.path.length===0&&atSite){
        if(impact){
          spawnParticles(hitX, hitY, e.task==='mine_gold' ? '#ffd700' : '#c0c0c0', 2, 0.02, 1.3); // sparks
          workSound('mine', hitX, hitY); // synced to the pick's visual impact
        }
        X.save();X.translate(anim.toolRest.x,anim.toolRest.y);X.scale(twf,1);X.rotate(swing);
        // Long handle
        strokeShaft(0, 1, 9, -13, 3.4, 1.8);
        // Big curved pick head, points tapering both ways. Gold Mining
        // reads on the GOLD miner's pick as the polished tier (dark→
        // bright); stone mining has no tech, so its pick stays plain.
        X.strokeStyle='#000000';X.lineWidth=5/UNIT_SCALE;X.lineCap='round';
        X.beginPath();X.moveTo(2.5,-17.5);X.quadraticCurveTo(9.5,-16,15.5,-9);X.stroke();
        X.strokeStyle = (e.task==='mine_gold' && hasUpgrade(e.team,'gold_mining')) ? '#f2f6fb' : '#b8bfc6';
        X.lineWidth=2.4/UNIT_SCALE;
        X.beginPath();X.moveTo(2.5,-17.5);X.quadraticCurveTo(9.5,-16,15.5,-9);X.stroke();
        X.lineCap='butt';
        X.restore();
      } else if(e.task==='build'&&e.path.length===0&&atSite){
        if(impact){
          spawnParticles(e.x + e.facing*0.35, e.y - 0.1, '#cbbca0', 2, 0.015, 1.2); // dust
          workSound('build', e.x + e.facing*0.35, e.y - 0.1); // at the mallet's visual impact
        }
        X.save();X.translate(anim.toolRest.x,anim.toolRest.y);X.scale(twf,1);X.rotate(swing);
        // Handle
        strokeShaft(0, 1, 7.5, -11, 3.2, 1.7);
        // Two-faced wooden mallet, authored in a shaft-aligned frame so
        // the barrel stays PERPENDICULAR to the handle at every swing
        // angle: slight belly bulge, iron bands at both ends, bright
        // striking face on the impact side.
        X.save();X.translate(7.5,-11);X.rotate(MALLET_HEAD_ROT);
        X.fillStyle='#b08850';
        X.strokeStyle='#000000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
        X.beginPath();
        X.moveTo(-2.0,-4.6);X.lineTo(2.0,-4.6);
        X.quadraticCurveTo(3.0,0,2.0,4.6);
        X.lineTo(-2.0,4.6);
        X.quadraticCurveTo(-3.0,0,-2.0,-4.6);
        X.closePath();X.fill();X.stroke();
        X.strokeStyle='rgba(0,0,0,0.4)';X.lineWidth=1.0/UNIT_SCALE;
        X.beginPath();X.moveTo(-2.25,-3.2);X.lineTo(2.25,-3.2);X.moveTo(-2.25,3.2);X.lineTo(2.25,3.2);X.stroke();
        X.strokeStyle='#fff';X.lineWidth=1.3/UNIT_SCALE;
        X.beginPath();X.moveTo(-1.6,4.6);X.lineTo(1.6,4.6);X.stroke();
        X.restore();
        X.restore();
      } else if(anim.scythe){
        // Scythe: curved snath from the hands down-forward, a long bright
        // crescent blade skimming the crop; the whole tool sweeps about
        // the grip anchor (anim.sweep — the hand rides the same value).
        // OVERSIZED like the bow saw — the drama lives in the tool's
        // reach and travel, the body keeps its quiet work rock.
        X.save();X.translate(anim.toolRest.x,anim.toolRest.y+1);X.scale(twf,1);X.rotate(anim.sweep);
        X.strokeStyle='#000000';X.lineWidth=3.4/UNIT_SCALE;X.lineCap='round';X.lineJoin='round';
        X.beginPath();X.moveTo(0,-1.5);X.quadraticCurveTo(4,3.5,7,12);X.stroke();
        X.strokeStyle='#8B4513';X.lineWidth=1.9/UNIT_SCALE;X.stroke();
        // blade weight matches the pick's curved head (5 / 2.4); Horse
        // Collar reads as the POLISHED tier (dark→bright, the gold-
        // mining treatment on the farm line)
        X.strokeStyle='#000000';X.lineWidth=5/UNIT_SCALE;
        X.beginPath();X.moveTo(7,12);X.quadraticCurveTo(12.5,14,17,10);X.stroke();
        X.strokeStyle = tierSteel(hasUpgrade(e.team,'horse_collar') ? 2 : 0);
        X.lineWidth=2.4/UNIT_SCALE;X.stroke();
        X.lineCap='butt';
        X.restore();
      }
    } else if(e.utype==='militia' || e.utype==='spearman'){
      // Militia broadsword / spearman long spear — pose entirely from the
      // shared sword seam; only the art differs (a corpse has dropped its
      // weapon; the militia shield stays strapped to the arm).
      if(!e.corpseRot) drawSwordHeld(0, 0);
      // (kite shield drawn in drawShieldLayer — always on top)
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
      let swinging = anim.swinging; // gate + draw cycle from the hand-pose seam
      let justFired = anim.justFired; // string still snapping forward
      X.save(); X.translate(GRIP_REST.archer.x, GRIP_REST.archer.y+humanYOffset);
      // Un-mirror (the context is under X.scale(e.facing,1); scaling by
      // e.facing again cancels it — the translate above stays mirrored so
      // the bow remains in the correct hand), then rotate to the arc's
      // LAUNCH tangent so the nocked arrow points exactly along the real
      // arrow's initial flight line (see aimAngleBallistic above).
      if(swinging){ X.scale(e.facing,1); X.rotate(anim.theta); }
      // Recurve bow with flexing limbs: the flex rides the REAL draw
      // clock; on release the limbs snap forward while the string ctrl
      // lags near the body — the slack string catching up.
      let f = swinging ? (justFired ? -0.35*anim.snapT : anim.drawT) : 0;
      // Nocked arrow: thick shaft, steel head, fletching. Facing away we
      // see the bow's BACK, so the arrow (far side) draws first and the
      // limbs paint over it; facing the camera it rides on top.
      const drawNockedArrow = () => {
        let pull = anim.pull;
        X.strokeStyle='#000'; X.lineWidth=2.4/UNIT_SCALE; X.lineCap='round';
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull+13, 0); X.stroke();
        X.strokeStyle='#f5f2e9'; X.lineWidth=1.2/UNIT_SCALE;
        X.beginPath(); X.moveTo(pull, 0); X.lineTo(pull+13, 0); X.stroke();
        X.lineCap='butt';
        X.fillStyle='#dde3ea'; X.strokeStyle='#000'; X.lineWidth=1/UNIT_SCALE;
        X.beginPath(); X.moveTo(pull+15, 0); X.lineTo(pull+11, -2.1); X.lineTo(pull+11, 2.1); X.closePath(); X.fill(); X.stroke();
        // Fletching is LITERAL: bare shaft until the tech is researched,
        // LIGHT-team-color feather vanes after — the research adds the
        // feathers (lighter than the tunic so they pop).
        if (eq && eq.fletched) {
          X.fillStyle=teamColorLight(e.team);
          X.strokeStyle='#000'; X.lineWidth=0.9/UNIT_SCALE; X.lineJoin='round';
          const vane = (sgn) => {
            X.beginPath();
            X.moveTo(pull+4.6, sgn*0.5);   // front, hugging the shaft
            X.lineTo(pull+1.2, sgn*3.2);   // swept outer edge
            X.lineTo(pull-2.6, sgn*3.2);   // feather back edge
            X.lineTo(pull-0.6, sgn*0.5);   // notch into the nock
            X.closePath(); X.fill(); X.stroke();
          };
          vane(-1); vane(1);
        }
      };
      // the arrow rides the bow's FAR side whenever the bow itself is
      // behind the body (facing away + E profile): arrow furthest back
      let arrowBack = anim.heldD < 0;
      if (swinging && !justFired && arrowBack) drawNockedArrow();
      let bowTip = drawRecurveBow(f, weaponTier);
      let tipX = bowTip.tx, tipY = bowTip.ty;
      if(swinging && !justFired){
        // Drawn string
        X.strokeStyle='#e8e8e8'; X.lineWidth=1/UNIT_SCALE;
        X.beginPath(); X.moveTo(tipX, -tipY); X.lineTo(anim.pull, 0); X.lineTo(tipX, tipY); X.stroke();
        if (!arrowBack) drawNockedArrow();
      } else {
        // String at rest — STRAIGHT between the tips (ctrl on the chord;
        // the old ctrl-at-0 relied on tips sitting near x 0 and would sag
        // slack against the shallow bow) — vibrating briefly right after
        // the release, decaying over the first 15% of the reload window
        let vib = swinging ? Math.sin(tick*1.2)*1.8*anim.snapT : 0;
        X.strokeStyle='#e8e8e8'; X.lineWidth=1/UNIT_SCALE;
        X.beginPath(); X.moveTo(tipX, -tipY); X.quadraticCurveTo(tipX + vib, 0, tipX, tipY); X.stroke();
      }
      X.restore();
    } else if(isMountedUnit(e.utype)&&!e.corpseRot){
      // Scout/knight broadsword — same seam pose as the militia, at the
      // rider's offsets. (Corpses drop it — drawCorpse lays it down.)
      drawSwordHeld(humanXOffset, humanYOffset);
      // (knight's kite shield drawn in drawShieldLayer — always on top)
    }
    }; // end drawHeldLayer

    // Shield faces, drawn AT THE ORIGIN (drawShieldPiece places, turns
    // and scales them). Front face carries the identity art (boss /
    // team-cross heraldry — a metal shield made team ID vanish under
    // full mail); the back face is plain wood.
    // rimFill draws the bare silhouette in the rim wood — the offset
    // back copy that gives the plate its THICKNESS read; strokeC lets
    // the BRIDGE copy hide its outline (stroke = fill → seamless side
    // wall, so rim + face read as ONE cylinder, not two circles).
    const drawKiteShield = (back = false, rimFill = null, strokeC = '#000000') => {
      X.strokeStyle=strokeC;X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
      X.fillStyle = rimFill || (back ? '#a5723a' : '#f5f5f0');X.beginPath();
      X.moveTo(-4.2, -5.5);X.lineTo(4.2, -5.5);
      X.lineTo(5.6, 0);X.lineTo(0, 8.5);X.lineTo(-5.6, 0);X.closePath();X.fill();X.stroke();
      if (!back && !rimFill) {
        X.fillStyle=tc;
        X.fillRect(-4.2, -0.8, 8.4, 1.7);
        X.fillRect(-0.85, -4.5, 1.7, 9);
      }
    };
    const drawRoundShield = (back = false, rimFill = null, strokeC = '#000000') => {
      X.strokeStyle=strokeC;X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
      X.fillStyle = rimFill || '#a5723a';
      X.beginPath();X.arc(0,0,4.8,0,Math.PI*2);X.fill();X.stroke();
      if (!back && !rimFill) {
        X.fillStyle='#f5f5f0';
        X.beginPath();X.arc(0,0,1.6,0,Math.PI*2);X.fill();X.stroke();
      }
    };
    // The shield plate: position, face and width all come from the
    // SHIELD RIG at the seam (braced = on the off forearm; slung = across
    // the back) — the width scale is the plate turning with the body.
    const drawShieldPiece = () => {
      if (!anim.shieldState) return;
      X.save();
      X.translate(anim.shieldRest.x + humanXOffset, anim.shieldRest.y + humanYOffset);
      // the plate has THICKNESS (user call): a dark rim copy offset
      // along the projected plate NORMAL peeks past the face — the SAME
      // vector in every view (fully lateral at the S/N edge strips,
      // diagonal on the quarters, zero at the dead-on profiles). Seeing
      // the BACK face, the visible rim is the FRONT rim — the offset
      // flips sides with the face (user caught the inversion at NW).
      let R2 = RIG[(e.dir + 2) & 7], sd = -anim.gripS;
      let rs = anim.shieldFace === 'back' ? -1 : 1;
      let nx = rs * e.facing * sd * R2.sx * 1.7, ny = rs * sd * R2.sy * 1.7 * RIG_YK;
      if (anim.shieldEdge) {
        // edge-on (S/N): a plain slim RECTANGLE — one slab, one fill,
        // one outline, nothing else (user call)
        X.strokeStyle='#000000';X.lineWidth=1.2/UNIT_SCALE;X.lineJoin='round';
        let ky = eq.shield === 'kite' ? 1.5 : 0, ry = eq.shield === 'kite' ? 7.6 : 5.6;
        X.fillStyle='#a5723a';
        X.beginPath();X.rect(-1.1, ky-ry, 2.2, 2*ry);X.fill();X.stroke();
      } else {
        // CYLINDER read: back rim outline → strokeless bridge sweeping
        // the side wall → face on top (an outlined rim alone read as a
        // second circle, user caught it)
        const face = eq.shield === 'kite' ? drawKiteShield : drawRoundShield;
        X.save(); X.translate(-nx, -ny); X.scale(anim.shieldWK, 1);
        face(true, '#7a5230'); X.restore();
        X.save(); X.translate(-nx/2, -ny/2); X.scale(anim.shieldWK, 1);
        face(true, '#7a5230', '#7a5230'); X.restore();
        X.scale(anim.shieldWK, 1);
        face(anim.shieldFace === 'back');
      }
      X.restore();
    };
    const drawShieldLayer = () => {
      // On-top shield for branch-drawn units only — militia + mounted
      // shields are depth-sorted parts at the layer block.
      if (e.utype === 'militia' || isMountedUnit(e.utype)) return;
      drawShieldPiece();
    };

    // Facing away → held weapons/tools are on the far side of the torso,
    // so the body must paint over them; facing the camera → the reverse.
    // Facing away: held items are on the far side of BOTH the horse and
    // the rider, so they draw first and everything paints over them.
    // Global surge (mounted only — the horse steps into the charge a
    // little; foot units act through the segmented upper body instead).
    // Origin = the ground point; the facing mirror flips both. Corpses
    // never set these. S/N views surge along the view axis instead of
    // sideways.
    if (faceOnView) {
      if (anim.lunge) X.translate(0, (e.dir === 1 ? 1 : -1)*anim.lunge*0.6);
    } else {
      if (anim.lean) X.rotate(anim.lean);
      if (anim.lunge) X.translate(anim.lunge, 0);
    }

    if (isMountedUnit(e.utype)) {
      // POSE-RIG parts draw (Stage B): same sort as the militia's, with
      // the HORSE as the depth reference (0), the rider just over it,
      // and two horse-side facts kept as fixed depths — the S hanging
      // head in front of everything (nearest the camera), the shield
      // always on top (worn on the near arm, user call).
      {
        // pinned depths from the seam (mode/mount/overrides resolved there)
        let held = anim.heldD;
        // The GRIP hand's shoulder side picks the sword's side of the
        // HORSE (user calls): FAR hand (L at SE/E, R at SW/W) → sword
        // and arm swing BEHIND the horse's head/neck, arm deepest with
        // the blade over it (the blade still peeks above the silhouette
        // through the arc); NEAR hand (L at NW, R at NE) → sword in
        // FRONT of the horse and its head. No near side at S/N.
        if (anim.gripS * R.d < -0.05) held = Math.min(held, -0.2);
        else if (anim.gripS * R.d > 0.05) held = Math.max(held, 0.2);
        // shield from the SHIELD RIG — far-side braces render BEHIND the
        // horse like the far-side sword (user call at NW; edges still
        // peek past the silhouette)
        let shield = anim.shieldState ? anim.shieldD : -99;
        // the shared rule + horse riders: far grip pinned just under the
        // sword ("arm deepest with the blade over it"), the idle rein
        // arm hangs ON the flank; nearOnly strap-out (user caught NW)
        const armDepth = (s) => armDepthRule(s, { held, R, F,
          farGripPin: true, flankClamp: true, shield, shieldGap: 0.002 });
        shield = strapShieldOut(shield, armDepth, true);
        let loose = anim.swArm === 'front' ? 'rear' : 'front';
        runParts([
          [held, () => upperly(drawHeldLayer)],
          [armDepth(anim.gripS), () => upperly(() => drawArms(anim.swArm))],
          [armDepth(-anim.gripS), () => upperly(() => drawArms(loose))],
          [0, drawMountLayer],
          [0.01, drawBodyLayer],
          [8, () => { if (horseHeadFront) horseHeadFront(); }],
          [shield, () => upperly(drawShieldPiece)],
        ]);
      }
    }
    else if (e.utype === 'militia' || e.utype === 'spearman') {
      // POSE-RIG parts draw (Stage A2): every part takes a camera depth
      // from its rig anchors and the ascending sort IS the draw order —
      // the per-dir layer branches this replaces survive only as the
      // mounts' profileHeld sort pin.
      // mount/mode were resolved ONCE at the seam — the parts pass
      // reads the resolved depth (anim.heldD) + shield rig
      let held = anim.heldD;
      // single-hand grip, the mounted near/far convention: a far-side
      // grip (L at SE/E, R at SW/W) swings the cross-body sword BEHIND
      // the body, drawn right after its own arm; a near-side grip (L at
      // NW, R at NE) holds it in FRONT — body, then sword, then the
      // active arm wrapping it.
      if (!anim.twoHand) {
        if (anim.gripS * R.d < -0.05) held = Math.min(held, -0.2);
        else if (anim.gripS * R.d > 0.05) held = Math.max(held, 0.2);
      }
      // two-handed, facing away with a near side (NW/NE): same front
      // hold — body, then sword, then the near active arm + shoulder
      // wrapping it; the far active arm stays tucked behind the torso.
      else if (held < -0.05 && Math.abs(R.d) > 0.05) held = Math.max(held, 0.2);
      // shield depth from the SHIELD RIG (braced forearm mount or the
      // back sling — resolved at the seam with position/face/width)
      let shield = anim.shieldState ? anim.shieldD : -99;
      // the shared rule + the sword rider: where the sword rides behind
      // the body (N-side dirs) the far arm draws FIRST, under it too, so
      // the grip wraps the handle from the far side
      const armDepth = (s) => armDepthRule(s, { held, R, F,
        farBehindHeld: true, shield, shieldGap: 0.05 });
      shield = strapShieldOut(shield, armDepth, false);
      let loose = anim.swArm === 'front' ? 'rear' : 'front';
      runParts([
        [held, () => upperly(drawHeldLayer)],
        [armDepth(anim.gripS), () => upperly(() => drawArms(anim.swArm))],
        [armDepth(-anim.gripS), () => upperly(() => drawArms(loose))],
        [0.01, () => { drawMountLayer(); drawBodyLayer(); }],
        [shield, () => upperly(drawShieldPiece)],
      ]);
    }
    else {
      // spearman / archer / villager — the SAME depth-sorted parts pass:
      // arms are BODY sides whose depths come from their STATE (grip/
      // support span their shoulder to the held item; idle/carry arms
      // use the hanging rule — identical at all times, attacks included);
      // the held item sorts by its rig-mount depth (over the body facing
      // camera, behind it facing away, straight from the F.d sign).
      let held = anim.heldD !== undefined ? anim.heldD : 0.005;
      // the shared rule, no riders (carry arms follow the shoulder-side
      // rule inside it: near grips OVER the load, far rises behind)
      const armDepth = (s) => armDepthRule(s, { held, R, F, shieldGap: 0.05 });
      runParts([
        [held, () => upperly(drawHeldLayer)],
        [armDepth(-1), () => upperly(() => drawArms(armFrameSide(-1)))],
        [armDepth(1), () => upperly(() => drawArms(armFrameSide(1)))],
        [0.01, () => { drawMountLayer(); drawBodyLayer(); }],
        // the carried load is its OWN part, shown while hauling (or
        // pushing the post-tech barrow, loaded or empty); the barrow's
        // FAR handle rod splits out to draw behind the villager
        [(anim.barrow || anim.plowRig || anim.carryShow) ? anim.carryD : -99, () => upperly(() => drawCarriedLoad('main'))],
        // the poles STRADDLE the body (far rod behind) everywhere except
        // dead-on S, where the handles both come toward the viewer and
        // render in front (user call)
        [(anim.barrow || anim.plowRig) ? (mirroredDir(e) === 1 ? anim.carryD - 0.01
                        : anim.carryD > 0 ? 0.004 : anim.carryD - 0.03) : -99,
          () => upperly(() => drawCarriedLoad('farRod'))],
      ]);
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
      // a SELECTED grazing sheep would double-spawn them). Counter-advance
      // guard (the workSwingCycles pattern): a bare tick%N renders the
      // same tick 2-3 rAF frames in a row and fired a triple puff.
      let gcyc = Math.floor(tick / T30(24));
      if(!window._maskDraw && grazeCycles.get(e.id) !== gcyc){
        grazeCycles.set(e.id, gcyc);
        spawnParticles(e.x + (e.facing * 0.25), e.y + 0.1, '#4e8c2d', 1, 0.008, 0.9);
      }
    }
    X.restore();
  }

  X.restore(); // restore to absolute coordinates so text and UI aren't mirrored

  // Idle indicator — part of the unit's SHAPE, so it draws in the mask pass
  // too: the selection ring wraps it and the behind-building silhouette shows
  // it (spot an idle villager hidden behind a building). Keep showing while
  // walking, as long as no task/target is actually assigned (a bare move order
  // isn't "working"). Absolute coords — not under UNIT_SCALE.
  if(e.team===myTeam&&e.utype==='villager'&&!e.task&&!e.target&&!e.corpseRot){
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
    let hpTop = (isMountedUnit(e.utype)||e.utype==='tradecart') ? sy-40*UNIT_SCALE : sy-30*UNIT_SCALE;
    X.fillStyle='#000000';X.fillRect(sx-9,hpTop,18,5);
    X.fillStyle='#300';X.fillRect(sx-8,hpTop+1,16,3);
    X.fillStyle=e.hp/e.maxHp>0.5?'#0c0':'#c00';X.fillRect(sx-8,hpTop+1,16*e.hp/e.maxHp,3);
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

