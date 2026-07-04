function drawGhost(){
  if(!placing)return;
  let tile=screenToTile(mouseX,mouseY);

  // Wall drag: show the actual wall pillars/links along the drag line
  // (same ghost style as a single hovered wall), not just flat tint tiles.
  if (placing === 'WALL' && window.isDraggingWall && window.wallDragStart && window.wallDragEnd) {
    let line = getWallElbowTiles(window.wallDragStart, window.wallDragCorner || window.wallDragEnd, window.wallDragEnd);
    let pillarH = 22, wallH = 14;
    let toScr = (tx, ty) => {
      let iso = toIso(tx + 0.5, ty + 0.5);
      return { x: iso.ix - camX + W/2, y: iso.iy - camY + topH + H/2 - HALF_TH };
    };
    X.globalAlpha = 0.55;
    window._ghostDraw = true;
    line.forEach((t, i) => {
      let p = toScr(t.x, t.y);
      let linkY = p.y + 16;
      drawBuildingBlock(p.x, p.y+11, 9, 4.5, pillarH, '#cfc8b6', '#aca392', 'flat', 0, '#b7ad97', '#b7ad97', false);
      let next = line[i+1];
      if (next) {
        let ddx = next.x - t.x, ddy = next.y - t.y;
        let off = toIso(ddx, ddy);
        drawWallLink(p.x, linkY, off.ix, off.iy, wallH, false);
      }
    });
    window._ghostDraw = false;
    X.globalAlpha = 1;

    // Tint each tile green (valid) or red (invalid)
    line.forEach(t => {
      let ok = canPlace('WALL', t.x, t.y, 0);
      let iso = toIso(t.x, t.y);
      let sx = iso.ix - camX + W/2, sy = iso.iy - camY + topH + H/2;
      X.fillStyle = ok ? 'rgba(0,200,0,0.28)' : 'rgba(200,0,0,0.28)';
      X.beginPath();
      X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
      X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
      X.closePath();X.fill();
    });
    return;
  }

  let b=BLDGS[placing];
  let bw=b.w, bh_=b.h;
  let ox=tile.x, oy=tile.y;
  if(placing==='GATE'){
    let isWall = (tx, ty) => !!entities.find(en=>en.type==='building'&&en.x===tx&&en.y===ty&&en.btype==='WALL'&&en.team===0);
    if (isWall(tile.x, tile.y) && isWall(tile.x+1, tile.y)) {
      ox=tile.x; oy=tile.y; bw=2; bh_=1;
    } else if (isWall(tile.x-1, tile.y) && isWall(tile.x, tile.y)) {
      ox=tile.x-1; oy=tile.y; bw=2; bh_=1;
    } else if (isWall(tile.x, tile.y) && isWall(tile.x, tile.y+1)) {
      ox=tile.x; oy=tile.y; bw=1; bh_=2;
    } else if (isWall(tile.x, tile.y-1) && isWall(tile.x, tile.y)) {
      ox=tile.x; oy=tile.y-1; bw=1; bh_=2;
    } else {
      bw=1; bh_=2;
    }
  }
  let ok=canPlace(placing,tile.x,tile.y,0);

  // Draw ghost: actual building rendered semi-transparently
  let fakeE={
    type:'building', btype:placing, x:ox, y:oy, team:0,
    hp:b.hp, maxHp:b.hp, complete:true,
    buildProgress:0, buildTime:200, queue:[],
    w:bw, h:bh_, rallyX:ox, rallyY:oy, gateProgress:0
  };
  X.globalAlpha=0.55;
  window._ghostDraw=true;
  drawBuilding(fakeE);
  window._ghostDraw=false;
  X.globalAlpha=1;

  // Tint footprint tiles green (valid) or red (invalid)
  X.fillStyle=ok?'rgba(0,200,80,0.28)':'rgba(220,30,0,0.28)';
  for(let dy=0;dy<bh_;dy++)for(let dx=0;dx<bw;dx++){
    let iso=toIso(ox+dx,oy+dy);
    let sx=iso.ix-camX+W/2, sy=iso.iy-camY+topH+H/2;
    X.beginPath();
    X.moveTo(sx,sy);X.lineTo(sx+HALF_TW,sy+HALF_TH);
    X.lineTo(sx,sy+TH);X.lineTo(sx-HALF_TW,sy+HALF_TH);
    X.closePath();X.fill();
  }
}

function drawSelection(){
  if(!dragStart||!dragEnd)return;
  X.strokeStyle='#0f0';X.lineWidth=1;
  X.setLineDash([4,4]);
  let x1=Math.min(dragStart.x,dragEnd.x), y1=Math.min(dragStart.y,dragEnd.y);
  let x2=Math.max(dragStart.x,dragEnd.x), y2=Math.max(dragStart.y,dragEnd.y);
  X.strokeRect(x1,y1,x2-x1,y2-y1);
  X.setLineDash([]);
}

function drawMinimap(){
  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let mw=MC.parentElement.clientWidth||160,mh=MC.parentElement.clientHeight||160;
  MC.width=mw*dpr;MC.height=mh*dpr;
  MC.style.width=mw+'px';MC.style.height=mh+'px';
  MX.scale(dpr,dpr);
  let mt=getMiniTransform(mw,mh);
  let miniPoint=(x,y)=>{
    let iso=toIso(x,y);
    return{x:mt.ox+iso.ix*mt.scale,y:mt.oy+iso.iy*mt.scale};
  };
  let fillDiamond=(points,color)=>{
    MX.fillStyle=color;
    MX.beginPath();
    MX.moveTo(points[0].x,points[0].y);
    for(let i=1;i<points.length;i++)MX.lineTo(points[i].x,points[i].y);
    MX.closePath();
    MX.fill();
  };
  MX.clearRect(0,0,mw,mh);
  for(let y=0;y<MAP;y++)for(let x=0;x<MAP;x++){
    let f = fog[y] && fog[y][x];
    let c = '#000000'; // unexplored is black
    if (f === 1) {
      let t=map[y][x];
      c=t.t===TERRAIN.GRASS?'#254615':t.t===TERRAIN.FOREST?'#0d2008':
        t.t===TERRAIN.GOLD?'#6d5210':t.t===TERRAIN.STONE?'#404040':
        t.t===TERRAIN.WATER?'#224c6e':t.t===TERRAIN.FARM?'#453d28':'#254615';
    } else if (f === 2) {
      let t=map[y][x];
      c=t.t===TERRAIN.GRASS?'#4a8c2a':t.t===TERRAIN.FOREST?'#1a4010':
        t.t===TERRAIN.GOLD?'#daa520':t.t===TERRAIN.STONE?'#808080':
        t.t===TERRAIN.WATER?'#4499dd':t.t===TERRAIN.FARM?'#8a7a50':'#4a8c2a';
    }
    // Inflate each tile slightly so neighbors overlap — without this,
    // anti-aliased edges leave hairline transparent seams that show the
    // battlefield through the (semi-transparent) minimap as cracks.
    fillDiamond([miniPoint(x-0.06,y-0.06),miniPoint(x+1.06,y-0.06),miniPoint(x+1.06,y+1.06),miniPoint(x-0.06,y+1.06)],c);
  }
  // (ornamental frame is drawn last, on top of entities/viewport — see below)
  // Selected objects draw white (AoE2-style) so the current selection is
  // findable on the minimap at a glance.
  let selectedIds=new Set(selected.map(s=>s.id));
  entities.forEach(e=>{
    if(e.type==='unit'&&e.garrisonedIn)return; // hidden inside a building
    let ex = Math.round(e.x), ey = Math.round(e.y);
    let f = e.type === 'building' ? buildingFogLevel(e) : ((fog[ey] && fog[ey][ex]) || 0);
    if (f === 0) return; // completely unexplored — hide everything
    if (f === 1 && e.team !== myTeam && e.type !== 'building') return; // hide enemy units in shroud (buildings remembered)
    // Enemy buildings in shroud are only "remembered" if they were actually
    // seen at some point — same scoutedByMe rule as the main map (js/core.js),
    // so the two views never disagree (and buildings put up after we left
    // aren't leaked).
    if (f === 1 && e.team !== myTeam && e.type === 'building' && !scoutedByMe.has(e.id)) return;

    let isSel=selectedIds.has(e.id);
    // Under-attack blink (AoE2): a player object hit in the last ~4 game-s
    // pulses white on the minimap so raids are spottable at a glance.
    // 60-tick cycle ≈ 1 blink per real second at 2x speed — slow enough to
    // read as a deliberate alert rather than a flicker.
    let recentlyHit=e.team===myTeam&&e.lastHitTick!==undefined&&tick-e.lastHitTick<120;
    let blinkOn=recentlyHit&&(tick-e.lastHitTick)%60<30;
    let color=(isSel||blinkOn)?'#ffffff':TEAM_COLORS[e.team];
    if(e.type==='building'){
      let w=e.w||1,h=e.h||1;
      fillDiamond([miniPoint(e.x,e.y),miniPoint(e.x+w,e.y),miniPoint(e.x+w,e.y+h),miniPoint(e.x,e.y+h)],color);
    } else {
      let p=miniPoint(e.x+0.5,e.y+0.5);
      // Dot scales with the minimap's zoom (≈ half a tile), so units stay
      // visible when the map is expanded instead of staying 2px specks.
      let dot=Math.max(2,HALF_TW*mt.scale);
      if(isSel)dot+=1; // selected dots read slightly bigger, like AoE2
      MX.fillStyle=color;
      MX.fillRect(p.x-dot/2,p.y-dot/2,dot,dot);
    }
  });
  let bottomY=window.innerHeight-bottomH;
  let vp=[
    screenToMap(0,topH),
    screenToMap(W,topH),
    screenToMap(W,bottomY),
    screenToMap(0,bottomY)
  ].map(p=>miniPoint(p.x,p.y));
  MX.strokeStyle='#fff';MX.lineWidth=1;
  MX.beginPath();
  MX.moveTo(vp[0].x,vp[0].y);
  for(let i=1;i<vp.length;i++)MX.lineTo(vp[i].x,vp[i].y);
  MX.closePath();
  MX.stroke();

  // Simple thin border around the diamond
  let corners=[miniPoint(0,0),miniPoint(MAP,0),miniPoint(MAP,MAP),miniPoint(0,MAP)];
  MX.strokeStyle='#d8c878';MX.lineWidth=1.5;MX.lineJoin='round';
  MX.beginPath();
  MX.moveTo(corners[0].x,corners[0].y);
  for(let i=1;i<corners.length;i++)MX.lineTo(corners[i].x,corners[i].y);
  MX.closePath();MX.stroke();
}

function drawParticles() {
  X.save();
  particles.forEach(p => {
    let px = Math.round(p.x), ppy = Math.round(p.y);
    if (ppy < 0 || ppy >= MAP || px < 0 || px >= MAP || fog[ppy][px] !== 2) return;
    
    let iso = toIso(p.x, p.y);
    let sx = iso.ix - camX + W/2;
    let sy = iso.iy - camY + topH + H/2 + HALF_TH;
    
    let pz = p.z || 0;
    sy -= pz * 35;

    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) return;

    X.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
    
    if (p.type === 'fire') {
      let pct = p.life / p.maxLife;
      let col = '#e02200';
      if (pct > 0.65) col = '#ffff80';
      else if (pct > 0.35) col = '#ff9d21';
      
      let curSize = p.size * (0.3 + pct * 0.9);
      
      X.fillStyle = col;
      X.beginPath();
      X.arc(sx, sy, curSize * 2.0, 0, Math.PI * 2);
      X.globalAlpha = Math.max(0, Math.min(1, (p.life / p.maxLife) * 0.25));
      X.fill();
      
      X.globalAlpha = Math.max(0, Math.min(1, p.life / p.maxLife));
      X.beginPath();
      X.arc(sx, sy, curSize, 0, Math.PI * 2);
      X.fill();
    } 
    else if (p.type === 'smoke') {
      let pct = p.life / p.maxLife;
      let curSize = p.size * (1.0 + (1.0 - pct) * 1.5);
      X.fillStyle = 'rgba(100, 100, 100, 0.4)';
      X.beginPath();
      X.arc(sx, sy, curSize, 0, Math.PI * 2);
      X.fill();
    } 
    else if (p.type === 'blood') {
      X.fillStyle = p.color;
      if (pz <= 0.01) {
        X.beginPath();
        X.ellipse(sx, sy, p.size * 1.6, p.size * 0.8, 0, 0, Math.PI * 2);
        X.fill();
      } else {
        X.beginPath();
        X.arc(sx, sy, p.size, 0, Math.PI * 2);
        X.fill();
      }
    } 
    else {
      X.fillStyle = p.color;
      X.beginPath();
      X.arc(sx, sy, p.size, 0, Math.PI * 2);
      X.fill();
    }
  });
  X.restore();
}

function drawProjectiles() {
  X.save();
  projectiles.forEach(p => {
    let ppx = Math.round(p.x), ppy = Math.round(p.y);
    if (ppy < 0 || ppy >= MAP || ppx < 0 || ppx >= MAP || fog[ppy][ppx] !== 2) return;
    // Arrows fly to a fixed aim point (p.tx/p.ty), not a tracked entity.
    let targetX = p.tx, targetY = p.ty;
    let dCurrent = Math.hypot(p.x - targetX, p.y - targetY);
    let progress = p.totalDist > 0.1 ? Math.max(0, Math.min(1, 1 - dCurrent / p.totalDist)) : 1;

    let iso = toIso(p.x, p.y);
    let sx = iso.ix - camX + W/2;
    let sy = iso.iy - camY + topH + H/2 + HALF_TH;
    // Height along the flight: launch height (bow / battlements) blends to
    // impact height at the target's body, plus the ballistic arc.
    let startH = p.startH || 12;
    let endH = 8;
    let A = 35 * (p.totalDist / 5);
    let arcH = Math.sin(progress * Math.PI) * A;
    let lift = startH + (endH - startH) * progress + arcH;
    sy -= lift;

    // Analytic flight tangent in screen space: iso ground motion plus the
    // derivative of arc+height blend, so the arrow always points along its
    // actual path — including right at launch and impact.
    let isoS = toIso(p.startX, p.startY), isoT = toIso(targetX, targetY);
    let vx = isoT.ix - isoS.ix;
    let vy = (isoT.iy - isoS.iy) - (Math.cos(progress*Math.PI)*Math.PI*A + (endH - startH));
    let screenAngle = Math.atan2(vy, vx);

    let L = 14;
    let ca = Math.cos(screenAngle), sa = Math.sin(screenAngle);
    let px2 = -sa, py2 = ca;
    // Motion streak trailing the arrow
    X.strokeStyle = 'rgba(255,255,255,0.3)';
    X.lineWidth = 2; X.lineCap='round';
    X.beginPath();
    X.moveTo(sx - ca*(L+2), sy - sa*(L+2));
    X.lineTo(sx - ca*(L+11), sy - sa*(L+11));
    X.stroke();
    // Thick shaft
    X.strokeStyle = '#000'; X.lineWidth = 3.2;
    X.beginPath(); X.moveTo(sx - ca*L, sy - sa*L); X.lineTo(sx, sy); X.stroke();
    X.strokeStyle = '#f5f2e9'; X.lineWidth = 1.4;
    X.beginPath(); X.moveTo(sx - ca*L, sy - sa*L); X.lineTo(sx, sy); X.stroke();
    X.lineCap='butt';
    // Big steel head
    X.fillStyle = '#dde3ea'; X.strokeStyle='#000'; X.lineWidth=1;
    X.beginPath();
    X.moveTo(sx + ca*3.4, sy + sa*3.4);
    X.lineTo(sx - ca*1.5 + px2*2.3, sy - sa*1.5 + py2*2.3);
    X.lineTo(sx - ca*1.5 - px2*2.3, sy - sa*1.5 - py2*2.3);
    X.closePath(); X.fill(); X.stroke();
    // Red fletching fins
    let tx2 = sx - ca*L, ty2 = sy - sa*L;
    X.fillStyle = '#cc4444';
    X.beginPath();
    X.moveTo(tx2 + ca*2, ty2 + sa*2);
    X.lineTo(tx2 - ca*3 + px2*2.8, ty2 - sa*3 + py2*2.8);
    X.lineTo(tx2, ty2);
    X.closePath(); X.fill();
    X.beginPath();
    X.moveTo(tx2 + ca*2, ty2 + sa*2);
    X.lineTo(tx2 - ca*3 - px2*2.8, ty2 - sa*3 - py2*2.8);
    X.lineTo(tx2, ty2);
    X.closePath(); X.fill();
  });
  X.restore();
}

