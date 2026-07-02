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
const SIL_UNIT_SIZE = 84;  // logical px — covers any unit
const SIL_BLDG_SIZE = 300; // logical px — covers largest building (TC 3x3)
// Selected entities whose combined bounding box (all their silhouette
// extents unioned together) fits within this span get ONE merged ring
// drawn around the whole group instead of one ring per entity — see
// drawOutlines() below for why. Beyond this span there's no visual benefit
// to merging anyway (the ~2px dilation could never bridge that big a gap
// between two far-apart members, so their rings would never touch whether
// merged or not) — only cost, in the form of a much bigger shared buffer
// mostly covering empty space. Falls back to the old per-entity path there.
const SIL_MERGE_MAX_SPAN = 700; // logical px

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
  return dpr * Math.max(1, Math.ceil(ZOOM*4)/4);
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
  const anchorX = isUnit ? 42 : cssPx/2;
  const anchorY = isUnit ? 58 : cssPx*0.72;

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
  try{
    infos.forEach(info=>{
      const {e,isUnit,anchorX,anchorY,sx,sy}=info;
      // Where this entity's own anchor point lands inside the shared
      // buffer — same idea as the old single-entity anchor, just offset by
      // the buffer's screen origin instead of always (anchorX,anchorY).
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
  // doesn't bridge the gap at all, leaving a thin transparent notch. 24
  // samples (vs. an earlier 8) makes the approximation close enough to a
  // true circle that neither is visible in practice, for a cheap linear
  // cost increase (each sample is one drawImage call) — and since this now
  // runs ONCE per group instead of once per entity, merging several units
  // together is actually CHEAPER than outlining them separately, not more
  // expensive, on top of looking right.
  const R=2*ss;
  const DIRS=24;
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
// group instead of two individually-dilated rings meeting at a visible
// seam. Far-apart entities (beyond SIL_MERGE_MAX_SPAN) fall back to their
// own individual buffer — merging them would cost a much bigger mostly-
// empty buffer for zero visual benefit, since the dilation could never
// bridge that big a gap anyway.
function drawOutlines(){
  if(!selected.length) return;
  let infos = selected.map(_outlineExtent).filter(Boolean);
  if(infos.length===0) return;

  let minLeft=Math.min(...infos.map(i=>i.left)), minTop=Math.min(...infos.map(i=>i.top));
  let maxRight=Math.max(...infos.map(i=>i.right)), maxBottom=Math.max(...infos.map(i=>i.bottom));
  let spanW=maxRight-minLeft, spanH=maxBottom-minTop;

  if(infos.length===1 || spanW>SIL_MERGE_MAX_SPAN || spanH>SIL_MERGE_MAX_SPAN){
    infos.forEach(info=>_renderRingGroup([info], info.left, info.top, info.cssPx, info.cssPx));
  } else {
    _renderRingGroup(infos, minLeft, minTop, spanW, spanH);
  }
}


