// ---- ISO HELPERS ----
function toIso(x,y){return{ix:(x-y)*HALF_TW,iy:(x+y)*HALF_TH}}
function fromIso(ix,iy){
  let x=(ix/HALF_TW+iy/HALF_TH)/2;
  let y=(iy/HALF_TH-ix/HALF_TW)/2;
  return{x,y};
}
function screenToMap(sx,sy){
  let ix=(sx-W/2)/ZOOM+camX, iy=(sy-(H/2+topH))/ZOOM+camY;
  return fromIso(ix,iy);
}
function screenToTile(sx,sy){
  let p=screenToMap(sx,sy);
  return{x:Math.floor(p.x),y:Math.floor(p.y)};
}

function getMiniTransform(mw,mh){
  let pad=0;
  let scale=Math.min((mw-pad*2)/(MAP*TW),(mh-pad*2)/(MAP*TH));
  return{scale,ox:mw/2,oy:pad};
}

function mapToMini(x,y,mw,mh){
  let t=getMiniTransform(mw,mh);
  let iso=toIso(x,y);
  return{x:t.ox+iso.ix*t.scale,y:t.oy+iso.iy*t.scale};
}

function miniToMap(sx,sy,mw,mh){
  let t=getMiniTransform(mw,mh);
  return fromIso((sx-t.ox)/t.scale,(sy-t.oy)/t.scale);
}

function inMapBounds(x,y){
  return x>=0&&x<MAP&&y>=0&&y<MAP;
}
