// ---- True-silhouette selection outline ----
// Renders the entity's exact silhouette into an offscreen buffer, dilates it
// by 2px in 8 directions, then subtracts the original — leaving a clean gold
// ring, which is blit onto the main canvas on top of everything drawn so far.
//
// This MUST be called from inside render()'s own X.save()/scale(ZOOM)/
// X.restore() block — i.e. call sites, drawUnit/drawBuilding themselves, and
// this function all need to agree on which side of that transform they're
// operating on. Every position here is computed exactly the way drawUnit/
// drawBuilding compute theirs: logical (unscaled) pixels, ZOOM never
// multiplied in manually. That's deliberate, not an oversight — an earlier
// version of this drew the ring AFTER X.restore() (outside the transform)
// and re-applied ZOOM by hand, which sounds equivalent but isn't: the real
// sprite's position gets Math.round()'ed BEFORE the canvas scales it by
// ZOOM (round-then-scale, since it's drawn inside the transform), while the
// manual version rounded AFTER multiplying by ZOOM (scale-then-round).
// Those two only agree when camX/camY land on exact integers, which is
// rare during scrolling/following — the rest of the time the ring would
// drift up to half a zoom-level's worth of pixels off the sprite, in a
// different direction every frame as the camera moves. That drift is what
// "glitchy" was: not a buffer-management bug, a coordinate-space mismatch.
// Once both the sprite and its ring are positioned by the SAME transform,
// they can't disagree — so this needs no manual ZOOM math at all, only
// dpr (device pixel ratio, for crisp buffers on retina screens), which is
// an orthogonal concern from gameplay zoom.
const SIL_UNIT_SIZE = 112; // logical px — covers any unit (widest: the trade cart's RECENTERED wagon+ox composite, ~±42)
// Covers the largest building's full drawn silhouette. Measured extents of the
// 4x4 Town Center from its anchor (footprint-top): ~129px each side, ~102px
// above, ~94px below (the annex posts hang below the footprint). 340 with the
// 0.62 anchor split below gives ±170 / 211 above / 129 below — margin on all
// sides. (Was 300 at a 0.72 split → only 84px below, which clipped the posts.)
const SIL_BLDG_SIZE = 340;

let _silMaskC=null,_silMaskX=null; // logical-pixel user space (scale(_silSS) applied)
let _silFlatC=null,_silFlatX=null; // physical px, no extra scale
let _silRingC=null,_silRingX=null;
let _silSS=0,_silAllocW=0,_silAllocH=0; // tracks what the buffers were last built for

// Every other shape in this renderer is drawn with vector calls (arc/lineTo/
// etc.) directly under the active X.scale(ZOOM,ZOOM) transform, so it's
// re-evaluated at whatever the current zoom is and never blurs. This ring
// is the one raster bitmap in the pipeline — captured once into an offscreen
// buffer, then composited through that same ZOOM transform — so if the
// buffer's own pixel density doesn't keep up with ZOOM, the browser ends up
// stretching a low-res bitmap and it visibly softens at higher zoom. The
// supersample factor is dpr * ZOOM (not just dpr) so the buffer always has
// enough physical pixels for however zoomed-in the game currently is.
//
// ZOOM is quantized up to the nearest quarter-step before feeding into this,
// so a smooth mouse-wheel zoom doesn't force a buffer reallocation on every
// single frame — only when crossing a quarter-zoom boundary. (Buffers are
// also grow-only/reused across frames when the requested size already fits,
// same as before — this is purely about how many physical pixels a given
// requested size actually gets.)
function _silSuperSample(){
  // dpr capped at 2: the ring is a soft 2px glow, so dpr-3 phones gain no
  // visible sharpness from the extra pixels — only 2.25x the fill cost.
  return Math.min(dpr,2) * Math.max(1, Math.ceil(ZOOM*4)/4);
}

function _silEnsure(cssW,cssH){
  let ss=_silSuperSample();
  let needW=Math.max(_silAllocW,cssW), needH=Math.max(_silAllocH,cssH);
  // Rebuild if the supersample factor changed OR we need a bigger canvas in
  // either dimension (only grow each dimension independently, never shrink
  // — same reuse-across-calls logic as before, just 2D now: a merged
  // group's bounding box is rarely square).
  if(_silMaskC && _silSS===ss && _silAllocW>=needW && _silAllocH>=needH) return;
  _silSS=ss; _silAllocW=needW; _silAllocH=needH;
  let physW=Math.ceil(needW*ss), physH=Math.ceil(needH*ss);
  function mk(){ let c=document.createElement('canvas');c.width=physW;c.height=physH;return c; }
  _silMaskC=mk(); _silMaskX=_silMaskC.getContext('2d');
  _silMaskX.scale(ss,ss);           // logical-pixel user space on the mask
  _silFlatC=mk(); _silFlatX=_silFlatC.getContext('2d'); // physical px
  _silRingC=mk(); _silRingX=_silRingC.getContext('2d'); // physical px
}

// Where a selected entity's silhouette sits on screen, in the same
// logical-pixel space drawUnit/drawBuilding themselves draw in — used both
// to union a bounding box across a whole selection and to know where to
// place this one entity within a shared buffer. Returns null if the entity
// isn't eligible for an outline at all (garrisoned, wrong type, fogged, or
// scrolled off-screen) so callers can filter with a plain .filter(Boolean).
function _outlineExtent(e){
  if(!e||e.garrisonedIn) return null;
  const isUnit=e.type==='unit', isBldg=e.type==='building';
  if(!isUnit&&!isBldg) return null;

  let f = isBldg ? buildingFogLevel(e) : (()=>{
    let ex=Math.round(e.x),ey=Math.round(e.y);
    return (fog[ey]&&fog[ey][ex]!==undefined)?fog[ey][ex]:0;
  })();
  if(f!==2) return null;

  const cssPx  = isUnit ? SIL_UNIT_SIZE : SIL_BLDG_SIZE;
  const anchorX = isUnit ? SIL_UNIT_SIZE/2 : cssPx/2;
  const anchorY = isUnit ? 66 : cssPx*0.62; // 211px above / 129px below the footprint top

  let sx, sy;
  if(isUnit){
    const iso=toIso(e.x,e.y);
    sx=Math.round(iso.ix-camX+W/2);
    sy=Math.round(iso.iy-camY+topH+H/2+HALF_TH);
    const {ox,oy}=getUnitGroupOffset(e.id);
    sx+=ox; sy+=oy;
  } else {
    const b=BLDGS[e.btype];
    const cx=e.x+b.w/2, cy=e.y+b.h/2;
    const iso=toIso(cx,cy);
    const bhh=(e.h||b.h)*HALF_TH;
    sx=Math.round(iso.ix-camX+W/2);
    sy=Math.round(iso.iy-camY+topH+H/2-bhh);
  }
  if(isOffscreen(sx,sy,cssPx)) return null;

  return {
    e, isUnit, cssPx, anchorX, anchorY, sx, sy,
    left: sx-anchorX, top: sy-anchorY,
    right: sx+(cssPx-anchorX), bottom: sy+(cssPx-anchorY)
  };
}

// Renders every entity in `infos` into ONE shared buffer (each at its own
// offset within it), flattens+dilates+subtracts ONCE for the whole group,
// then blits the result — this is what makes touching/adjacent selected
// entities merge into a single continuous outline instead of showing a
// visible seam where two individually-dilated rings overlap. `bufW`/`bufH`
// is the buffer size (logical px); `originLeft`/`originTop` is where that
// buffer's (0,0) sits on screen.
function _renderRingGroup(infos, originLeft, originTop, bufW, bufH){
  _silEnsure(bufW,bufH);
  const ss = _silSuperSample();
  const physW = Math.ceil(bufW*ss), physH = Math.ceil(bufH*ss);

  // ── Step 1: render every entity's exact shape into the shared mask,
  // each positioned at its own offset within the group's buffer. ──────────
  _silMaskX.clearRect(0,0,bufW,bufH);
  const sv={X,camX,camY,W,H,topH,ZOOM};
  X=_silMaskX; W=2000; H=2000; topH=0; ZOOM=1;
  // Flag the re-invocation of the REAL drawUnit/drawBuilding below as a
  // mask pass: drawUnit checks this to suppress its side effects (facing
  // hysteresis advancement, particle spawns, swing-cycle bookkeeping) and
  // its floating overlays (HP bar, idle "?"), which would otherwise run
  // twice per frame for selected entities / be rasterized into the outline.
  window._maskDraw=true;
  try{
    infos.forEach(info=>{
      const {e,isUnit,anchorX,anchorY,sx,sy}=info;
      // Where this entity's own anchor point lands inside the shared
      // buffer — its anchor offset by the buffer's screen origin instead
      // of always (anchorX,anchorY).
      const bufAnchorX = sx-originLeft, bufAnchorY = sy-originTop;
      if(isUnit){
        const {ox,oy}=getUnitGroupOffset(e.id);
        const iso=toIso(e.x,e.y);
        camX=iso.ix+W/2-(bufAnchorX-ox);
        camY=iso.iy+H/2+HALF_TH-(bufAnchorY-oy);
        drawUnit(e);
      } else {
        const b=BLDGS[e.btype];
        const iso=toIso(e.x+b.w/2, e.y+b.h/2);
        const bhh=(e.h||b.h)*HALF_TH;
        camX=iso.ix+W/2-bufAnchorX;
        camY=iso.iy+H/2-bhh-bufAnchorY;
        drawBuilding(e);
      }
    });
  } finally {
    window._maskDraw=false;
    X=sv.X; camX=sv.camX; camY=sv.camY;
    W=sv.W; H=sv.H; topH=sv.topH; ZOOM=sv.ZOOM;
  }

  // ── Step 2: flatten mask to a solid gold silhouette ───────────────────
  _silFlatX.clearRect(0,0,physW,physH);
  _silFlatX.globalCompositeOperation='source-over';
  _silFlatX.fillStyle='#ffd700';
  _silFlatX.fillRect(0,0,physW,physH);
  _silFlatX.globalCompositeOperation='destination-in';
  // 9-arg drawImage: copy only the first physW×physH pixels of the mask
  // (the buffer may be larger than needed if a bigger group/building was
  // previously selected — grow-only reuse).
  _silFlatX.drawImage(_silMaskC,0,0,physW,physH, 0,0,physW,physH);
  _silFlatX.globalCompositeOperation='source-over';

  // ── Step 3: dilate by ~2 logical px, subtract original → ring ─────────
  // The offset is in PHYSICAL pixels (this buffer's own space), so it's
  // scaled by `ss` too — otherwise the ring would visibly get THINNER as
  // ss grows with zoom (2 physical px is a smaller and smaller logical
  // distance at higher resolution). This keeps the ring's on-screen
  // thickness constant regardless of zoom or dpr.
  //
  // The "dilate" is approximated by stamping the silhouette at several
  // points around a circle and taking their union — a real circular
  // dilation would need every point on that circle, so a small sample
  // count leaves visible seams: at a CONVEX/pointy feature (top of the
  // head, a weapon tip, the dot of the question mark), the union of a few
  // shifted copies of that point doesn't blend into a smooth cap — it
  // shows as a cluster of small facet "peaks", one per sample direction.
  // At a CONCAVE dip between features, a sparse sample set sometimes
  // doesn't bridge the gap at all, leaving a thin transparent notch. 8
  // samples is much cheaper, but can expose those notches on sharper
  // silhouettes. Since this now runs ONCE per group instead of once per
  // entity, merging several units together is still cheaper than outlining
  // them separately.
  const R=2*ss;
  const DIRS=4; // perf test: was 8 — right/down/left/up wraps the whole shape
  _silRingX.clearRect(0,0,physW,physH);
  _silRingX.globalCompositeOperation='source-over';
  for(let i=0;i<DIRS;i++){
    let a=i/DIRS*Math.PI*2;
    _silRingX.drawImage(_silFlatC,0,0,physW,physH, Math.cos(a)*R,Math.sin(a)*R,physW,physH);
  }
  _silRingX.globalCompositeOperation='destination-out';
  _silRingX.drawImage(_silFlatC,0,0,physW,physH, 0,0,physW,physH);
  _silRingX.globalCompositeOperation='source-over';

  // ── Step 4: blit ring to screen at its logical-pixel size ─────────────
  // Destination is bufW×bufH logical pixels — the SAME units drawUnit/
  // drawBuilding draw in — so the active X.scale(ZOOM,ZOOM) transform
  // (still in effect; we're inside it) scales this identically to the
  // real sprites. No manual ZOOM multiplication needed here at all.
  X.drawImage(_silRingC,0,0,physW,physH, originLeft, originTop, bufW, bufH);
}

// AoE2-style gold silhouette ring for selected units and buildings. Call
// from inside render()'s active ZOOM transform (see the big comment above
// _silSuperSample for why) — right after the main entity loop is the
// natural spot, matching where the ring needs to land relative to
// everything else painted that frame.
//
// Entities whose silhouettes are close together share ONE buffer and get
// dilated as a single unioned shape (_renderRingGroup), so touching or
// overlapping selected units read as one continuous outline around the
// group instead of two individually-dilated rings meeting at a visible seam.
//
// One shared buffer is used for ANY multi-entity selection, clamped to the
// visible viewport. The buffer cost is bounded by the screen (one flatten +
// dilate pass), not by the number selected — so selecting a 400-unit army
// costs the same as selecting a screenful of anything else. (Per-entity
// buffers would be O(N) offscreen churn; every member is already on-screen
// — _outlineExtent drops off-screen ones — so clamping the union box to
// the viewport loses nothing, and far-apart rings still don't touch.)
function drawOutlines(){
  if(!selected.length) return;
  let infos = selected.map(_outlineExtent).filter(Boolean);
  if(infos.length===0) return;

  if(infos.length===1){
    let info=infos[0];
    _renderRingGroup([info], info.left, info.top, info.cssPx, info.cssPx);
    return;
  }

  let minLeft=Math.min(...infos.map(i=>i.left)), minTop=Math.min(...infos.map(i=>i.top));
  let maxRight=Math.max(...infos.map(i=>i.right)), maxBottom=Math.max(...infos.map(i=>i.bottom));

  // Clamp the union box to the visible region (same bounds isOffscreen uses),
  // plus a little slack for the dilation ring. Keeps the shared buffer at most
  // viewport-sized no matter how far apart the members are.
  const M = 4;
  const hw=(W/2)/ZOOM, hh=(H/2)/ZOOM, cyv=H/2+topH;
  minLeft   = Math.max(minLeft,   W/2 - hw - M);
  maxRight  = Math.min(maxRight,  W/2 + hw + M);
  minTop    = Math.max(minTop,    cyv - hh - M);
  maxBottom = Math.min(maxBottom, cyv + hh + M);
  let spanW=maxRight-minLeft, spanH=maxBottom-minTop;
  if(spanW<=0 || spanH<=0) return;

  _renderRingGroup(infos, minLeft, minTop, spanW, spanH);
}

// ---- Behind-building team-color silhouettes ----
// A unit whose sortVal loses to a building gets overpainted by it; AoE2 shows
// a flat team-color silhouette of the unit through the building. Candidates
// (units + occluders) are collected by render()'s dispatch loop AT the draw
// call sites, so fog/scouted/garrison rules are inherited — anything not
// drawn this frame can't silhouette or occlude.
//
// Buffer strategy: candidates are grouped by (team, exact occluder set); each
// group shares one union-bbox buffer pair, so its occluding buildings re-draw
// ONCE per group no matter how many units cluster behind them (a per-unit
// scheme would re-run a Town Center's hundreds of vector calls per unit; a
// shared screen-sized buffer can't be correct, since a building in front of
// unit A may be behind unit B). Compositing only — no getImageData in the
// frame path. Must be called inside render()'s active ZOOM transform (same
// round-then-scale contract as the ring, see the top-of-file comment).
const BSIL_ALPHA = 0.45;

let _bsilAC=null,_bsilAX=null; // unit mask (logical space, scale(ss) applied)
let _bsilBC=null,_bsilBX=null; // occluder mask (same space)
let _bsilCC=null,_bsilCX=null; // foreground-unit mask (punched out of the silhouette)
let _bsilSS=0,_bsilAllocW=0,_bsilAllocH=0;

function _bsilEnsure(cssW,cssH){
  // ss is dpr-only, NO ZOOM factor (unlike _silSuperSample): a flat translucent
  // fill has no fine detail to keep crisp, and dropping ZOOM cuts mobile fill
  // cost ~2.25x. Separate buffers from _sil* — different scale, same frame.
  const ss=Math.min(dpr,2);
  const needW=Math.max(_bsilAllocW,cssW), needH=Math.max(_bsilAllocH,cssH);
  if(_bsilAC && _bsilSS===ss && _bsilAllocW>=needW && _bsilAllocH>=needH) return;
  _bsilSS=ss; _bsilAllocW=needW; _bsilAllocH=needH;
  const physW=Math.ceil(needW*ss), physH=Math.ceil(needH*ss);
  function mk(){ let c=document.createElement('canvas'); c.width=physW; c.height=physH;
    let x=c.getContext('2d'); x.scale(ss,ss); return [c,x]; }
  [_bsilAC,_bsilAX]=mk(); [_bsilBC,_bsilBX]=mk(); [_bsilCC,_bsilCX]=mk();
}

// Frame scratch (grow-only pool / reused containers, render.js discipline).
const _bsilOccBoxes = [];   // pooled bbox records, refilled each frame
const _bsilGroups = new Map(); // "team|occIdxs" -> group record
const _bsilIdxScratch = []; // per-unit matched-occluder indices
const _bsilUnitInfo = [];   // pooled per-drawn-unit {e,sortVal,sx,sy,uL,uR,uT,uB}
let _bsilNU = 0;            // live count in _bsilUnitInfo this frame
const _bsilFrontScratch = []; // per-group foreground-unit infos to punch out

// Screen bbox of an occluder drawable (building or gate/market part proxy),
// from the ENTITY footprint — deliberately generous: sortVal decides "in
// front", pixels decide overlap, so a false positive only costs one building
// draw whose intersection blits nothing.
function _bsilFillOccBox(rec, d){
  const en = d.type==='building' ? d : d.entity;
  const b = BLDGS[en.btype];
  const fw = en.w||b.w, fh = en.h||b.h;
  const iso = toIso(en.x+fw/2, en.y+fh/2);
  const ax = Math.round(iso.ix-camX+W/2);
  const ay = Math.round(iso.iy-camY+topH+H/2) - fh*HALF_TH; // footprint-top anchor, same as drawBuilding
  const halfW = (fw+fh)/2*HALF_TW + 14;
  rec.en = en;
  // Map each proxy type to the drawBuilding() part it paints, so mask B is
  // JUST that part — not the whole building. Missing tc_back/tc_front here
  // made them fall to null (whole TC), tinting a unit that was only in front
  // of the keep but behind the roof.
  rec.part = (d.type==='gate_back'||d.type==='tc_back') ? 'back'
           : (d.type==='gate_front'||d.type==='tc_front') ? 'front'
           : (d.type==='gate_door') ? 'door'
           : (d.part||null);
  rec.sortVal = d.sortVal;
  rec.ax = ax; rec.ay = ay;
  rec.left = ax-halfW; rec.right = ax+halfW;
  rec.top = ay - (60 + 18*Math.max(fw,fh)); // conservative art-height pad
  rec.bottom = ay + (fh + (fw+fh)/2)*HALF_TH + 16; // footprint bottom + below-hang slack
}

function _bsilRenderGroup(g){
  // Clamp the union of the group's UNIT boxes (the intersection can't exist
  // outside them) to the viewport, like drawOutlines.
  const M=2, hw=(W/2)/ZOOM, hh=(H/2)/ZOOM, cyv=H/2+topH;
  const left = Math.max(g.minL, W/2-hw-M), right = Math.min(g.maxR, W/2+hw+M);
  const top  = Math.max(g.minT, cyv-hh-M), bottom = Math.min(g.maxB, cyv+hh+M);
  const bufW = right-left, bufH = bottom-top;
  if(bufW<=0 || bufH<=0) return;
  _bsilEnsure(bufW,bufH);
  const ss=_bsilSS, physW=Math.ceil(bufW*ss), physH=Math.ceil(bufH*ss);

  // Foreground units to punch out: anything drawn IN FRONT of ALL this
  // group's occluders (sortVal past the frontmost) that overlaps the buffer.
  // Without this, a nearer unit that legitimately occludes the building gets
  // this group's ghost painted over it. Collected into _bsilCX below.
  _bsilFrontScratch.length=0;
  for(let i=0;i<_bsilNU;i++){
    const info=_bsilUnitInfo[i];
    if(info.sortVal<=g.frontSort) continue;
    if(info.uR<left||info.uL>right||info.uB<top||info.uT>bottom) continue;
    _bsilFrontScratch.push(info);
  }
  const hasFront=_bsilFrontScratch.length>0;

  _bsilAX.clearRect(0,0,bufW,bufH);
  _bsilBX.clearRect(0,0,bufW,bufH);
  if(hasFront) _bsilCX.clearRect(0,0,bufW,bufH);
  const sv={X,camX,camY,W,H,topH,ZOOM};
  window._maskDraw=true; // suppress drawUnit/drawBuilding side effects + overlays
  try{
    W=2000; H=2000; topH=0; ZOOM=1;
    const placeUnit=(e,sx,sy)=>{
      const {ox,oy}=getUnitGroupOffset(e.id);
      const iso=toIso(e.x,e.y);
      camX=iso.ix+W/2-((sx-left)-ox);
      camY=iso.iy+H/2+HALF_TH-((sy-top)-oy);
      drawUnit(e);
    };
    // Units -> mask A (union). Same camera-fake placement as _renderRingGroup.
    X=_bsilAX;
    for(const u of g.units) placeUnit(u.e, u.sx, u.sy);
    // Occluders -> mask B (union), each drawn ONCE for the whole group.
    X=_bsilBX;
    for(const idx of g.occIdxs){
      const o=_bsilOccBoxes[idx];
      const b=BLDGS[o.en.btype];
      const fw=o.en.w||b.w, fh=o.en.h||b.h;
      const iso=toIso(o.en.x+fw/2, o.en.y+fh/2);
      camX=iso.ix+W/2-(o.ax-left);
      camY=iso.iy+H/2-fh*HALF_TH-(o.ay-top);
      drawBuilding(o.en, o.part);
    }
    // Foreground units -> mask C (union).
    if(hasFront){ X=_bsilCX; for(const f of _bsilFrontScratch) placeUnit(f.e, f.sx, f.sy); }
  } finally {
    window._maskDraw=false;
    X=sv.X; camX=sv.camX; camY=sv.camY;
    W=sv.W; H=sv.H; topH=sv.topH; ZOOM=sv.ZOOM;
  }

  // unit ∩ buildings-in-front, minus foreground units, tinted. Each op clears
  // pixels outside the painted region, so stale content from a previously-
  // larger group is moot.
  _bsilAX.globalCompositeOperation='destination-in';
  _bsilAX.drawImage(_bsilBC,0,0,physW,physH, 0,0,bufW,bufH);
  if(hasFront){
    _bsilAX.globalCompositeOperation='destination-out';
    _bsilAX.drawImage(_bsilCC,0,0,physW,physH, 0,0,bufW,bufH);
  }
  _bsilAX.globalCompositeOperation='source-in';
  // Bright minimap palette, not the softer unit color: the silhouette is a
  // "unit hiding here" cue like a minimap dot, so it needs max contrast (and
  // the soft green ghost was muddy). See teamColorMinimap (js/core.js).
  _bsilAX.fillStyle=teamColorMinimap(g.team);
  _bsilAX.fillRect(0,0,bufW,bufH);
  _bsilAX.globalCompositeOperation='source-over';

  X.globalAlpha=BSIL_ALPHA;
  X.drawImage(_bsilAC,0,0,physW,physH, left, top, bufW, bufH);
  X.globalAlpha=1;
}

function drawBehindBuildingSilhouettes(units, occs){
  if(!units.length || !occs.length) return; // common case: zero cost

  for(let i=0;i<occs.length;i++){
    if(!_bsilOccBoxes[i]) _bsilOccBoxes[i]={en:null,part:null,sortVal:0,ax:0,ay:0,left:0,right:0,top:0,bottom:0};
    _bsilFillOccBox(_bsilOccBoxes[i], occs[i]);
  }
  const nOcc=occs.length;

  // Precompute every drawn unit's screen anchor + bbox once (same math/extents
  // as _outlineExtent's unit branch — SIL_UNIT_SIZE box, group offset included
  // or silhouettes drift). Reused for grouping AND the foreground punch-out.
  _bsilNU=units.length;
  for(let i=0;i<_bsilNU;i++){
    const e=units[i];
    if(!_bsilUnitInfo[i]) _bsilUnitInfo[i]={};
    const info=_bsilUnitInfo[i];
    const iso=toIso(e.x,e.y);
    let sx=Math.round(iso.ix-camX+W/2);
    let sy=Math.round(iso.iy-camY+topH+H/2+HALF_TH);
    const {ox,oy}=getUnitGroupOffset(e.id);
    sx+=ox; sy+=oy;
    info.e=e; info.sortVal=e.sortVal; info.sx=sx; info.sy=sy;
    info.uL=sx-SIL_UNIT_SIZE/2; info.uR=sx+SIL_UNIT_SIZE/2;
    info.uT=sy-66; info.uB=sy+(SIL_UNIT_SIZE-66);
  }

  _bsilGroups.clear();
  for(let i=0;i<_bsilNU;i++){
    const info=_bsilUnitInfo[i];
    _bsilIdxScratch.length=0;
    let frontSort=-Infinity;
    for(let j=0;j<nOcc;j++){
      const o=_bsilOccBoxes[j];
      if(o.sortVal<=info.sortVal) continue;       // behind or same layer as the unit
      if(o.right<info.uL || o.left>info.uR || o.bottom<info.uT || o.top>info.uB) continue;
      _bsilIdxScratch.push(j);                     // ascending j — key is canonical without sorting
      if(o.sortVal>frontSort) frontSort=o.sortVal;
    }
    if(!_bsilIdxScratch.length) continue;

    const key=info.e.team+'|'+_bsilIdxScratch.join(',');
    let g=_bsilGroups.get(key);
    if(!g){
      g={team:info.e.team, occIdxs:_bsilIdxScratch.slice(), units:[], frontSort,
         minL:info.uL, minT:info.uT, maxR:info.uR, maxB:info.uB};
      _bsilGroups.set(key,g);
    } else {
      if(info.uL<g.minL)g.minL=info.uL; if(info.uT<g.minT)g.minT=info.uT;
      if(info.uR>g.maxR)g.maxR=info.uR; if(info.uB>g.maxB)g.maxB=info.uB;
    }
    g.units.push({e:info.e, sx:info.sx, sy:info.sy});
  }

  _bsilGroups.forEach(_bsilRenderGroup);
}

