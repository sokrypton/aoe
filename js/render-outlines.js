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
    _silRingX.globalCompositeOperation='destination-in';
    _silRingX.drawImage(clipC, originLeft, originTop, bufW, bufH, 0,0, physW, physH);
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
let _occMaskC=null, _occMaskX=null, _occMaskW=0, _occMaskH=0;
function _buildOccMask(occs){
  const needW=Math.ceil(W), needH=Math.ceil(H);
  if(!_occMaskC || _occMaskW<needW || _occMaskH<needH){
    _occMaskC=document.createElement('canvas');
    _occMaskC.width=Math.max(needW,_occMaskW); _occMaskC.height=Math.max(needH,_occMaskH);
    _occMaskX=_occMaskC.getContext('2d'); _occMaskW=_occMaskC.width; _occMaskH=_occMaskC.height;
  }
  _occMaskX.setTransform(1,0,0,1,0,0);
  _occMaskX.clearRect(0,0,_occMaskW,_occMaskH);
  const sv={X,ZOOM}; X=_occMaskX; ZOOM=1; window._maskDraw=true;
  try{
    for(const d of occs){
      if(d.type==='tree'){ drawTreeEntity(d.x, d.y); continue; }
      const en = d.type==='building' ? d : d.entity;
      const part = (d.type==='gate_back'||d.type==='tc_back') ? 'back'
                 : (d.type==='gate_front'||d.type==='tc_front') ? 'front'
                 : (d.type==='gate_door') ? 'door' : (d.part||null);
      drawBuilding(en, part);
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
const _bsilByTeam = new Map(); // team -> extent infos of its occluded units
const _bsilActive = [];        // occluders actually hiding a unit THIS frame (mask input)

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
  const iso = toIso(en.x+fw/2, en.y+fh/2);
  const ax = Math.round(iso.ix-camX+W/2);
  const ay = Math.round(iso.iy-camY+topH+H/2) - fh*HALF_TH; // footprint-top anchor, same as drawBuilding
  const halfW = (fw+fh)/2*HALF_TW + 14;
  rec.left = ax-halfW; rec.right = ax+halfW;
  rec.top = ay - (60 + 18*Math.max(fw,fh)); // conservative art-height pad
  rec.bottom = ay + (fh + (fw+fh)/2)*HALF_TH + 16; // footprint bottom + below-hang slack
}
// Draw a team-color OUTLINE of each occluded unit (AoE2's mechanism for units
// behind buildings/trees), reusing the selection-ring path. A unit is a
// candidate if any building sorts in front of it and overlaps its box;
// candidates are grouped by team and each team's set is outlined in one pass
// (render shapes -> dilate -> ring), clipped to the occluder pixels so the ring
// only shows where the unit is actually hidden. One dilate pass per team, no
// per-unit occluder intersection — cheap enough for 200+ unit scenes.
function drawBehindBuildingOutlines(units, occs){
  if(!units.length || !occs.length) return;
  for(let i=0;i<occs.length;i++){
    if(!_bsilOccBoxes[i]) _bsilOccBoxes[i]={sortVal:0,left:0,right:0,top:0,bottom:0,active:false};
    _bsilOccBoxes[i].active=false;
    _bsilFillOccBox(_bsilOccBoxes[i], occs[i]);
  }
  const nOcc=occs.length;
  // A selected unit already shows through the occluder via its white selection
  // ring (drawOutlines blits on top of everything after this) — skip it here so
  // it doesn't get a doubled team-color + white ring.
  const sel = selected.length ? new Set(selected) : null;
  _bsilByTeam.forEach(a=>a.length=0);
  _bsilActive.length=0;
  for(const e of units){
    if(sel && sel.has(e)) continue;
    const ext=_outlineExtent(e); if(!ext) continue;
    let occluded=false;
    for(let j=0;j<nOcc;j++){
      const o=_bsilOccBoxes[j];
      if(o.sortVal<=e.sortVal) continue;
      if(o.right<ext.left||o.left>ext.right||o.bottom<ext.top||o.top>ext.bottom) continue;
      occluded=true;
      // Candidate-driven: the clip mask redraws ONLY occluders that are actually
      // hiding a unit this frame — a handful, whether the map holds 30 buildings
      // or a forest of trees — not every occluder on screen. (No early break:
      // a unit can be behind several occluders and the mask needs them all.)
      if(!o.active){ o.active=true; _bsilActive.push(occs[j]); }
    }
    if(!occluded) continue;
    let arr=_bsilByTeam.get(e.team); if(!arr){ arr=[]; _bsilByTeam.set(e.team,arr); }
    arr.push(ext);
  }
  let any=false; _bsilByTeam.forEach(a=>{ if(a.length) any=true; });
  if(!any) return;
  const clip=_buildOccMask(_bsilActive); // occluder pixels — clips each ring to the occluded regions
  const M=4, hw=(W/2)/ZOOM, hh=(H/2)/ZOOM, cyv=H/2+topH;
  _bsilByTeam.forEach((infos, team)=>{
    if(!infos.length) return;
    let minL=Infinity,minT=Infinity,maxR=-Infinity,maxB=-Infinity;
    for(const inf of infos){
      if(inf.left<minL)minL=inf.left; if(inf.top<minT)minT=inf.top;
      if(inf.right>maxR)maxR=inf.right; if(inf.bottom>maxB)maxB=inf.bottom;
    }
    minL=Math.max(minL,W/2-hw-M); maxR=Math.min(maxR,W/2+hw+M);
    minT=Math.max(minT,cyv-hh-M); maxB=Math.min(maxB,cyv+hh+M);
    const spanW=maxR-minL, spanH=maxB-minT;
    if(spanW>0 && spanH>0) _renderRingGroup(infos, minL, minT, spanW, spanH, teamColorMinimap(team), clip);
  });
}

