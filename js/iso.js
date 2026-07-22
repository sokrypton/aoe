// ---- ISO HELPERS ----
function toIso(x,y){return{ix:(x-y)*HALF_TW,iy:(x+y)*HALF_TH}}
function fromIso(ix,iy){
  let x=(ix/HALF_TW+iy/HALF_TH)/2;
  let y=(iy/HALF_TH-ix/HALF_TW)/2;
  return{x,y};
}
// DISPLAY CAMERA: the authoritative camera (camX/camY) stays FRACTIONAL —
// pan accumulation and pinch-zoom anchoring need the precision — but the
// screen only ever sees it quantized to whole logical pixels. Every
// drawable rounds its own screen position (Math.round(mapToScreen)), each
// with its own fractional phase; against a fractional camera those
// roundings flip at different pan offsets, so stationary units visibly
// vibrate ±1px against the ground while scrolling. Quantizing HERE — the
// single world<->screen seam — keeps the whole scene rigid under pans and
// makes hit-tests agree exactly with what was drawn.
function camDX(){return Math.round(camX);}
function camDY(){return Math.round(camY);}
// THE zoom/scale anchor: the rounded viewport center every ZOOM transform
// scales about. render()'s transform, screenToMap's inverse and
// setZoomAroundPoint's solve must all use THIS — two spellings disagreeing
// by a sub-pixel is exactly the class of bug that made clicks miss at
// ZOOM!=1 and the zoom focal point drift.
function zoomAnchor(){return{ax:Math.round(W/2),ay:Math.round(H/2+topH)};}
function screenToMap(sx,sy){
  // Exact inverse of render()'s zoom transform. At ZOOM 1 this reduces to
  // the plain translate.
  const {ax,ay}=zoomAnchor();
  let ix=ax+(sx-ax)/ZOOM - W/2 + camDX();
  let iy=ay+(sy-ay)/ZOOM - (H/2+topH) + camDY();
  return fromIso(ix,iy);
}
// Inverse of screenToMap for the RENDER pass, which draws into a context
// already scaled by ZOOM — hence no ZOOM term here (input-side code keeps
// screenToMap). THE one place the world->screen camera math lives; renderers
// must not re-spell `iso.ix - camX + W/2` inline.
function mapToScreen(x,y){
  let iso=toIso(x,y);
  return{sx:iso.ix-camDX()+W/2, sy:iso.iy-camDY()+H/2+topH};
}
function screenToTile(sx,sy){
  let p=screenToMap(sx,sy);
  return{x:Math.floor(p.x),y:Math.floor(p.y)};
}

function getMiniTransform(mw,mh){
  // Small padding just keeps the thin border stroke from clipping.
  let pad=4;
  let scale=Math.min((mw-pad*2)/(MAP*TW),(mh-pad*2)/(MAP*TH));
  // Center the diamond vertically whenever the box is taller than the
  // drawn diamond (a no-op — same oy as top-anchoring — whenever height is
  // the binding constraint, i.e. the mobile skin's wide 2:1 boxes).
  // Matters for the boxes where height IS loose: classic's taller square
  // and the mobile landscape mode's tall right-panel minimap, both of
  // which would otherwise show the diamond pinned to the top of a mostly
  // empty strip. Renderer (drawMinimap) and hit-testing (isPointOnMinimap/
  // minimapJump) both come through here, so they can't disagree.
  let diamondH = MAP * TH * scale;
  let oy = Math.max(pad, (mh - diamondH) / 2);
  return{scale,ox:mw/2,oy};
}

function miniToMap(sx,sy,mw,mh){
  let t=getMiniTransform(mw,mh);
  return fromIso((sx-t.ox)/t.scale,(sy-t.oy)/t.scale);
}

function inMapBounds(x,y){
  return x>=0&&x<MAP&&y>=0&&y<MAP;
}
