// ---- ISO HELPERS ----
function toIso(x,y){return{ix:(x-y)*HALF_TW,iy:(x+y)*HALF_TH}}
function fromIso(ix,iy){
  let x=(ix/HALF_TW+iy/HALF_TH)/2;
  let y=(iy/HALF_TH-ix/HALF_TW)/2;
  return{x,y};
}
function screenToMap(sx,sy){
  // Exact inverse of render()'s zoom transform, which scales about the
  // ROUNDED viewport center — inverting about the unrounded center left a
  // constant sub-pixel click-vs-visual offset at ZOOM != 1 (odd W / a
  // fractional topH). At ZOOM 1 this reduces to the old expression.
  const ax=Math.round(W/2), ay=Math.round(H/2+topH);
  let ix=ax+(sx-ax)/ZOOM - W/2 + camX;
  let iy=ay+(sy-ay)/ZOOM - (H/2+topH) + camY;
  return fromIso(ix,iy);
}
// Inverse of screenToMap for the RENDER pass, which draws into a context
// already scaled by ZOOM — hence no ZOOM term here (input-side code keeps
// screenToMap). THE one place the world->screen camera math lives; renderers
// must not re-spell `iso.ix - camX + W/2` inline.
function mapToScreen(x,y){
  let iso=toIso(x,y);
  return{sx:iso.ix-camX+W/2, sy:iso.iy-camY+H/2+topH};
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
