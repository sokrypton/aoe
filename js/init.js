// ---- INIT ----
function init(){
  genMap();
  initFog(); // Initialize Fog of War grid
  STARTS.forEach(start=>{
    let tc=createBuilding('TC',start.x,start.y,start.team);
    tc.complete=true;
    for(let i=0;i<3;i++){
      let sp=findSpawnTile(tc.rallyX+i%2,tc.rallyY+Math.floor(i/2),5)||{x:tc.rallyX,y:tc.rallyY};
      createUnit('villager',sp.x,sp.y,start.team);
    }
    let ssp=findSpawnTile(tc.rallyX+2,tc.rallyY+1,5)||{x:tc.rallyX,y:tc.rallyY};
    createUnit('scout',ssp.x,ssp.y,start.team);
  });
  placeStartingSheep();
  let iso=toIso(STARTS[0].x+1,STARTS[0].y+1);camX=iso.ix;camY=iso.iy;
  refreshPopulationCounts();
  // Show initial help on mobile
  if(isMobile){
    let hint=document.getElementById('help-hint');
    hint.textContent='Drag to pan \u2022 Tap to select \u2022 Tap map with units to command';
    hint.style.opacity='1';
    setTimeout(()=>hint.style.opacity='0',4000);
  }
}

function placeStartingSheep(){
  let starts=STARTS.map(s=>({x:s.x+1,y:s.y+1}));
  let baseAngle=Math.atan2(starts[1].y-starts[0].y,starts[1].x-starts[0].x);
  let offsets=[
    {angle:baseAngle+0.75,dist:4},
    {angle:baseAngle-0.75,dist:4},
    {angle:baseAngle+2.35,dist:6},
    {angle:baseAngle-2.35,dist:6}
  ].map(o=>({x:Math.round(Math.cos(o.angle)*o.dist),y:Math.round(Math.sin(o.angle)*o.dist)}));
  STARTS.forEach((start,index)=>{
    let center={x:start.x+1,y:start.y+1};
    offsets.forEach(offset=>{
      let ox=index===0?offset.x:-offset.x;
      let oy=index===0?offset.y:-offset.y;
      let sp=findSpawnTile(center.x+ox,center.y+oy,3);
      if(sp)createUnit('sheep',sp.x,sp.y,2);
    });
  });
}

function startGame(difficulty){
  aiDifficulty=AI_LEVELS[difficulty]?difficulty:'standard';
  gameStarted=true;
  aiTick=0;
  window.playedGameOverSound = false; // Reset game over sound trigger
  // Initialize audio on first click
  if (window.initAudio) window.initAudio();
  
  let menu=document.getElementById('tutorial');
  if(menu)menu.style.display='none';
  showMsg('Difficulty: '+AI_LEVELS[aiDifficulty].name);
}

function gameLoop(){
  if(gameStarted)handleScroll();
  update();
  render();
  updateUI();
  if(gameOver){
    if (!window.playedGameOverSound) {
      window.playedGameOverSound = true;
      if (window.playSound) window.playSound(won ? 'victory' : 'defeat');
    }
    X.fillStyle='rgba(0,0,0,0.6)';X.fillRect(0,0,W,window.innerHeight);
    let cy=topH+H/2;
    X.fillStyle=won?'#ffd700':'#ff4444';X.font='bold 48px serif';X.textAlign='center';
    X.fillText(won?'VICTORY':'DEFEAT',W/2,cy-20);
    X.fillStyle='#fff';X.font='20px sans-serif';
    X.fillText(won?'You destroyed the enemy!':'Your Town Center fell!',W/2,cy+20);
  }
  requestAnimationFrame(gameLoop);
}

init();
gameLoop();
