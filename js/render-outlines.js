// ---- True-silhouette selection outline ----
// Renders the entity's exact silhouette into an offscreen buffer, dilates it
// by 2px in 8 directions, then subtracts the original — leaving a clean
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

  // mapToScreen (js/iso.js), never inline camera math: the anchors must
  // round through the SAME quantized display camera drawUnit/drawBuilding
  // used, or the ring sits 1px off its sprite at some pan offsets.
  let sx, sy;
  if(isUnit){
    const p=mapToScreen(e.x,e.y);
    sx=Math.round(p.sx);
    sy=Math.round(p.sy+HALF_TH);
    const {ox,oy}=getUnitGroupOffset(e.id);
    sx+=ox; sy+=oy;
  } else {
    const b=BLDGS[e.btype];
    const p=mapToScreen(e.x+b.w/2, e.y+b.h/2);
    const bhh=(e.h||b.h)*HALF_TH;
    sx=Math.round(p.sx);
    sy=Math.round(p.sy-bhh);
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
// Default color WHITE for selection: the behind-building path passes a bright
// team color, and a yellow selection ring collided with the yellow team's.
function _renderRingGroup(infos, originLeft, originTop, bufW, bufH, color='#ffffff', clipC=null){
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
  window._selOutline=true; // this pass IS a selection/behind outline — buildings drawn here skip their wall-link stubs (drawsWallStubs)
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
    window._selOutline=false;
    X=sv.X; camX=sv.camX; camY=sv.camY;
    W=sv.W; H=sv.H; topH=sv.topH; ZOOM=sv.ZOOM;
  }

  // ── Step 2: flatten mask to a solid-color silhouette ──────────────────
  _silFlatX.clearRect(0,0,physW,physH);
  _silFlatX.globalCompositeOperation='source-over';
  _silFlatX.fillStyle=color;
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

  // ── Step 3.5 (behind-building outline only): clip the ring to the
  // occluder mask, so it shows ONLY where the unit is actually behind a
  // building (not the parts hanging out over open ground). clipC is a
  // viewport-space, ss=1 mask of the occluding buildings' pixels; the source
  // rect is this buffer's screen region, upscaled to the ring's resolution.
  if(clipC){
    // clipC's (0,0) is logical (_occMaskOffX,_occMaskOffY), not (0,0) — subtract
    // that anchor so the sampled region lines up with this ring's screen origin.
    _silRingX.globalCompositeOperation='destination-in';
    _silRingX.drawImage(clipC, originLeft-_occMaskOffX, originTop-_occMaskOffY, bufW, bufH, 0,0, physW, physH);
    _silRingX.globalCompositeOperation='source-over';
  }

  // ── Step 4: blit ring to screen at its logical-pixel size ─────────────
  // Destination is bufW×bufH logical pixels — the SAME units drawUnit/
  // drawBuilding draw in — so the active X.scale(ZOOM,ZOOM) transform
  // (still in effect; we're inside it) scales this identically to the
  // real sprites. No manual ZOOM multiplication needed here at all.
  X.drawImage(_silRingC,0,0,physW,physH, originLeft, originTop, bufW, bufH);
}

// Viewport-space mask (ss=1) of the pixels of the occluders that are actually
// hiding a unit this frame — clips the behind-building outline
// (drawBehindBuildingOutlines) to the regions really behind an occluder. Drawn
// at ZOOM=1 in logical screen coords (matching _renderRingGroup's buffers), real
// camera so occluders land where they render. `occs` is the candidate-driven
// active set, so this is a handful of redraws even on a dense map — never all
// on-screen occluders.
let _occMaskC=null, _occMaskX=null, _occMaskW=0, _occMaskH=0, _occMaskOffX=0, _occMaskOffY=0;

// ---- Cached SOLID-building occluder silhouettes ----
// Buildings don't move, and the occluder mask is drawn at ZOOM=1 (logical
// screen coords, upscaled by the clip step) so a building's silhouette is
// zoom-invariant — bake it once and blit thereafter instead of re-rasterizing
// its vector art per occluder-group every frame. Only the ALPHA SHAPE feeds
// the clip, so team color / age tint / fog darken / build-progress alpha don't
// vary it (build-progress alpha and the floating HP/progress UI are already
// suppressed under _maskDraw). WALL-LIKE pieces (walls/gates/towers) are NOT
// cached: their outline includes neighbour-dependent link stubs (instance
// state not in the key) — they stay on the live drawBuilding path.
// Key axes that DO change the shape: btype, depth-split part, footprint w/h,
// the h override, owner age (materials/keep geometry), and complete (some
// body geometry only draws when finished). Follows _treeArtCache; render-only,
// no determinism impact.
const _bldgSilCache = new Map();
function _bldgSil(en, part){
  const b = BLDGS[en.btype];
  const age = (typeof teamAge!=='undefined' && teamAge && isPlayerTeam(en.team)) ? (teamAge[en.team]||0) : 0;
  const key = en.btype+'|'+(part||'')+'|'+b.w+'|'+b.h+'|'+(en.h===undefined?'':en.h)+'|'+age+'|'+(en.complete?1:0);
  let a = _bldgSilCache.get(key);
  if(a) return a;
  // Extents about the footprint-top corner — same generous box the candidate
  // sweep uses (_bsilFillOccBox), so the whole silhouette always fits.
  const halfW = (b.w+b.h)/2*HALF_TW + 14;
  const above = 60 + 18*Math.max(b.w,b.h);
  const below = (b.h + (b.w+b.h)/2)*HALF_TH + 16;
  const ax = Math.ceil(halfW), ay = Math.ceil(above);
  const cv = document.createElement('canvas');
  cv.width = ax + Math.ceil(halfW); cv.height = ay + Math.ceil(below);
  const cx = cv.getContext('2d');
  // Position a synthetic camera so drawBuilding's footprint-top corner lands
  // at (ax,ay) in the buffer. Big W/H keep isOffscreen (drawBuilding's early
  // bail) from tripping on the far-from-centre anchor.
  const isoC = toIso(en.x+b.w/2, en.y+b.h/2);
  const sv={X,camX,camY,W,H,topH,ZOOM}, svMask=window._maskDraw;
  X=cx; W=4000;H=4000;topH=0;ZOOM=1;
  camX = isoC.ix + W/2 - ax;
  camY = isoC.iy + H/2 - (ay + b.h*HALF_TH);
  window._maskDraw=true;
  try { drawBuilding(en, part); }
  finally { window._maskDraw=svMask; X=sv.X;camX=sv.camX;camY=sv.camY;W=sv.W;H=sv.H;topH=sv.topH;ZOOM=sv.ZOOM; }
  a = { canvas: cv, ax, ay };
  _bldgSilCache.set(key, a);
  return a;
}

function _buildOccMask(occs){
  // Occluders are drawn at ZOOM=1 LOGICAL coords, but the transform scales
  // around screen-center (render.js), so when zoomed OUT the visible logical
  // rect extends past [0,W]×[0,H] — even NEGATIVE near the top-left. A mask
  // anchored at logical (0,0) with size W×H would drop those pixels, so a unit
  // in the left/top of the screen loses its clip and the outline flickers as it
  // crosses the x=0 boundary. Anchor the mask at the visible rect's top-left
  // (same bounds drawBehindBuildingOutlines clamps groups to) and record the
  // offset so the clip step samples the right region.
  const hw=(W/2)/ZOOM, hh=(H/2)/ZOOM, cyv=H/2+topH, M=48;
  const offX=Math.floor(W/2-hw-M), offY=Math.floor(cyv-hh-M);
  const needW=Math.ceil(2*(hw+M)), needH=Math.ceil(2*(hh+M));
  _occMaskOffX=offX; _occMaskOffY=offY;
  if(!_occMaskC || _occMaskW<needW || _occMaskH<needH){
    _occMaskC=document.createElement('canvas');
    _occMaskC.width=Math.max(needW,_occMaskW); _occMaskC.height=Math.max(needH,_occMaskH);
    _occMaskX=_occMaskC.getContext('2d'); _occMaskW=_occMaskC.width; _occMaskH=_occMaskC.height;
  }
  _occMaskX.setTransform(1,0,0,1,0,0);
  _occMaskX.clearRect(0,0,needW,needH);
  _occMaskX.setTransform(1,0,0,1,-offX,-offY); // logical (offX,offY) -> canvas (0,0)
  const sv={X,ZOOM}; X=_occMaskX; ZOOM=1; window._maskDraw=true;
  try{
    for(const d of occs){
      if(d.type==='tree'){ drawTreeEntity(d.x, d.y); continue; }
      const en = d.type==='building' ? d : d.entity;
      const part = (d.type==='gate_back'||d.type==='tc_back') ? 'back'
                 : (d.type==='gate_front'||d.type==='tc_front') ? 'front'
                 : (d.type==='gate_door') ? 'door' : (d.part||null);
      // Wall-like pieces (neighbour-dependent stubs) can't be cached — draw
      // live. Everything else blits its baked silhouette at the same
      // footprint-top corner drawBuilding would have drawn it at (real camera,
      // ZOOM=1 — the offX/offY shift is already on _occMaskX's transform).
      if(isWallLike(en)){ drawBuilding(en, part); continue; }
      const sil = _bldgSil(en, part);
      const b = BLDGS[en.btype];
      // mapToScreen, matching drawBuilding's rounding exactly — the live
      // wall-like branch above draws through it, so the baked blits must
      // quantize through the same display camera.
      const p = mapToScreen(en.x+b.w/2, en.y+b.h/2);
      const rsx = Math.round(p.sx);
      const rsy = Math.round(p.sy) - b.h*HALF_TH;
      X.drawImage(sil.canvas, rsx-sil.ax, rsy-sil.ay);
    }
  } finally { window._maskDraw=false; X=sv.X; ZOOM=sv.ZOOM; }
  return _occMaskC;
}

// AoE2-style white silhouette ring for selected units and buildings. Call
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

// ---- Behind-occluder team-color OUTLINES ----
// A unit whose sortVal loses to an occluder (building OR tree) is hidden by it;
// like AoE2, show a team-color OUTLINE of the occluded unit through it. Candidate
// units + occluders are collected by render()'s dispatch loop at the draw call
// sites, so fog/scouted/garrison rules are inherited. Reuses the selection-ring
// path (render shape -> dilate -> ring) clipped to the occluder pixels — no
// per-unit intersection, no per-group offscreen compositing. Must run inside
// render()'s active ZOOM transform (same round-then-scale contract as the ring).
const _bsilOccBoxes = [];      // pooled occluder bbox records, refilled each frame
const _bsilGroups = new Map(); // key (team|occluder-set) -> pooled group record
const _bsilGroupPool = [];     // reused {team,occIdx[],infos[]} records across frames
const _bsilActive = [];        // one group's occluders — rebuilt per group (mask input)
const _occIdxScratch = [];     // indices of occluders in front of the current unit

// Screen bbox of an occluder drawable (building/gate/market part proxy, or a
// tree) — deliberately generous: sortVal decides "in front", pixels decide
// overlap (the clip mask trims the ring to real occluder pixels), so a false
// positive costs nothing. The candidate sweep reads only sortVal + the box; the
// exact draw is re-derived in _buildOccMask.
function _bsilFillOccBox(rec, d){
  rec.sortVal = d.sortVal;
  if(d.type==='tree'){
    // 1-tile canopy; box from the tile's screen anchor (mapToScreen, same as
    // drawTreeEntity), padded up for the canopy and down to the trunk base.
    const p = mapToScreen(d.x, d.y);
    const ax = Math.round(p.sx), ay = Math.round(p.sy);
    rec.left = ax-(HALF_TW+10); rec.right = ax+(HALF_TW+10);
    rec.top = ay-64; rec.bottom = ay+TH+8;
    return;
  }
  const en = d.type==='building' ? d : d.entity;
  const b = BLDGS[en.btype];
  const fw = en.w||b.w, fh = en.h||b.h;
  const p = mapToScreen(en.x+fw/2, en.y+fh/2);
  const ax = Math.round(p.sx);
  const ay = Math.round(p.sy) - fh*HALF_TH; // footprint-top anchor, same as drawBuilding
  const halfW = (fw+fh)/2*HALF_TW + 14;
  rec.left = ax-halfW; rec.right = ax+halfW;
  rec.top = ay - (60 + 18*Math.max(fw,fh)); // conservative art-height pad
  rec.bottom = ay + (fh + (fw+fh)/2)*HALF_TH + 16; // footprint bottom + below-hang slack
}
// Draw a team-color OUTLINE of each occluded unit (AoE2's mechanism for units
// behind buildings/trees), reusing the selection-ring path. A unit is a
// candidate if any occluder sorts in front of it and overlaps its box. Units are
// grouped by team + the EXACT set of occluders in front of them; each group is
// outlined in one dilate pass, clipped to a mask of ONLY that group's occluders.
// The per-group (not global) clip is load-bearing: an occluder a unit sorts IN
// FRONT of must not contribute pixels to that unit's ring, or its art leaks a
// stray outline onto a unit standing at its edge (the front-corner artifact).
function drawBehindBuildingOutlines(units, occs){
  if(!units.length || !occs.length) return;
  for(let i=0;i<occs.length;i++){
    if(!_bsilOccBoxes[i]) _bsilOccBoxes[i]={sortVal:0,left:0,right:0,top:0,bottom:0};
    _bsilFillOccBox(_bsilOccBoxes[i], occs[i]);
  }
  const nOcc=occs.length;
  // A selected unit already shows through the occluder via its white selection
  // ring (drawOutlines blits on top of everything after this) — skip it here so
  // it doesn't get a doubled team-color + white ring.
  const sel = selected.length ? new Set(selected) : null;
  _bsilGroups.clear();
  let nGroup=0;
  for(const e of units){
    if(sel && sel.has(e)) continue;
    const ext=_outlineExtent(e); if(!ext) continue;
    _occIdxScratch.length=0;
    for(let j=0;j<nOcc;j++){
      const o=_bsilOccBoxes[j];
      if(o.sortVal<=e.sortVal) continue;
      if(o.right<ext.left||o.left>ext.right||o.bottom<ext.top||o.top>ext.bottom) continue;
      _occIdxScratch.push(j); // ascending j → key is order-stable without sorting
    }
    if(!_occIdxScratch.length) continue; // in front of everything overlapping it → visible
    const key=e.team+'|'+_occIdxScratch.join(',');
    let g=_bsilGroups.get(key);
    if(!g){
      g = nGroup<_bsilGroupPool.length ? _bsilGroupPool[nGroup] : (_bsilGroupPool[nGroup]={team:0,occIdx:[],infos:[]});
      nGroup++;
      g.team=e.team; g.occIdx.length=0; g.infos.length=0;
      for(let k=0;k<_occIdxScratch.length;k++) g.occIdx.push(_occIdxScratch[k]);
      _bsilGroups.set(key,g);
    }
    g.infos.push(ext);
  }
  if(!_bsilGroups.size) return;
  const M=4, hw=(W/2)/ZOOM, hh=(H/2)/ZOOM, cyv=H/2+topH;
  _bsilGroups.forEach(g=>{
    let minL=Infinity,minT=Infinity,maxR=-Infinity,maxB=-Infinity;
    for(const inf of g.infos){
      if(inf.left<minL)minL=inf.left; if(inf.top<minT)minT=inf.top;
      if(inf.right>maxR)maxR=inf.right; if(inf.bottom>maxB)maxB=inf.bottom;
    }
    minL=Math.max(minL,W/2-hw-M); maxR=Math.min(maxR,W/2+hw+M);
    minT=Math.max(minT,cyv-hh-M); maxB=Math.min(maxB,cyv+hh+M);
    const spanW=maxR-minL, spanH=maxB-minT;
    if(spanW<=0 || spanH<=0) return;
    _bsilActive.length=0;
    for(let k=0;k<g.occIdx.length;k++) _bsilActive.push(occs[g.occIdx[k]]);
    const clip=_buildOccMask(_bsilActive); // ONLY this group's occluders
    _renderRingGroup(g.infos, minL, minT, spanW, spanH, teamColorMinimap(g.team), clip);
  });
}


// ---- Every-other-frame cache for the behind-occluder pass ----
// The outline layer is decorative (units hidden behind buildings/trees) and
// by far the most expensive render pass (~85% of a dense frame, profiled).
// Recompute it on alternate frames into an offscreen layer; skip frames blit
// the cached layer shifted by the camera delta (same ZOOM), so panning never
// ghosts and the one-frame content lag is invisible behind occluders.
let _bsilFrameNo=0, _bsilLayer=null;
const _bsilCam={x:0,y:0,zoom:0,topH:0,empty:true};
function drawBehindBuildingOutlinesCached(units,occs){
  _bsilFrameNo++;
  const cv=X.canvas, dpr=window.devicePixelRatio||1;
  if(!_bsilLayer||_bsilLayer.width!==cv.width||_bsilLayer.height!==cv.height){
    _bsilLayer=document.createElement('canvas');
    _bsilLayer.width=cv.width; _bsilLayer.height=cv.height;
    _bsilCam.empty=true;
  }
  // zoom/layout changes can't be delta-blitted — recompute those frames
  if(_bsilFrameNo%2===1||_bsilCam.zoom!==ZOOM||_bsilCam.topH!==topH||_bsilCam.empty){
    const lc=_bsilLayer.getContext('2d');
    lc.setTransform(1,0,0,1,0,0); lc.clearRect(0,0,_bsilLayer.width,_bsilLayer.height);
    lc.setTransform(X.getTransform()); // the caller's dpr+ZOOM transform, verbatim
    const sv=X; X=lc;
    try{ drawBehindBuildingOutlines(units,occs); } finally{ X=sv; }
    _bsilCam.x=camDX(); _bsilCam.y=camDY(); _bsilCam.zoom=ZOOM; _bsilCam.topH=topH; _bsilCam.empty=false;
  }
  // blit in device space, shifted by the camera pan since the layer was
  // built. The layer's content was positioned through the quantized display
  // camera (camDX/camDY, js/iso.js), so the shift is measured in the same
  // currency — whole logical pixels; ·ZOOM·dpr is then exact in device px
  // whenever ZOOM·dpr is integral (no resample shimmer).
  const dx=Math.round((_bsilCam.x-camDX())*ZOOM*dpr), dy=Math.round((_bsilCam.y-camDY())*ZOOM*dpr);
  X.save(); X.setTransform(1,0,0,1,0,0); X.drawImage(_bsilLayer,dx,dy); X.restore();
}
