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
  window.targetCamX=camX;window.targetCamY=camY;
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
  gamePaused=false;
  aiTick=0;
  window.playedGameOverSound = false; // Reset game over sound trigger
  // Initialize audio on first click
  if (window.initAudio) window.initAudio();
  
  let menu=document.getElementById('tutorial');
  if(menu)menu.style.display='none';
  showMsg('Difficulty: '+AI_LEVELS[aiDifficulty].name);
}

function onStartClicked(){
  let selected = document.querySelector('input[name="difficulty"]:checked');
  let diff = selected ? selected.value : 'standard';
  let sizeSelected = document.querySelector('input[name="mapsize"]:checked');
  setMapSize(sizeSelected ? sizeSelected.value : 'medium');

  window.fogDisabled = false;

  // Always regenerate the map (even on a fresh load) so the chosen size takes effect,
  // since init() already ran once at script load with the default size.
  restartGame(diff);
}

function restartGame(difficulty){
  gameOver = false;
  won = false;
  gameStarted = false;
  entities = [];
  entitiesById.clear();
  corpses = [];
  selected = [];
  tick = 0;
  
  // Reset resources to defaults
  res = {food:200, wood:200, gold:100, stone:200, prepaidFarms:0};
  aiRes = {food:100, wood:100, gold:100, stone:100, prepaidFarms:0};
  window.aiWallPlan = null;
  window.aiGateBuilt = false;
  window.aiGateTile = null;
  window.aiIntel = null;

  // Re-generate map and spawn starts
  init();
  
  startGame(difficulty);
}

function toggleCameraFollow(){
  if(selected.length===0 || selected[0].type!=='unit' || selected[0].team!==0)return;
  let id=selected[0].id;
  window.cameraFollowId = (window.cameraFollowId===id) ? null : id;
  updateUI();
}

function toggleMenu(){
  let menu = document.getElementById('tutorial');
  if (menu) {
    if (menu.style.display === 'none' || menu.style.display === '') {
      menu.style.display = 'flex';
      gamePaused = true;
      let resumeBtn = document.getElementById('resume-game-btn');
      if (resumeBtn) {
        resumeBtn.style.display = entities.length > 0 ? 'inline-block' : 'none';
      }
    } else {
      menu.style.display = 'none';
      gamePaused = false;
    }
  }
}

function gameLoop(){
  if(gameStarted && !gamePaused) {
    handleScroll();
    update();
  }
  render();
  updateUI();
  if(gameOver){
    if (!window.playedGameOverSound) {
      window.playedGameOverSound = true;
      if (window.playSound) window.playSound(won ? 'victory' : 'defeat');
    }
    X.fillStyle='rgba(0,0,0,0.65)';X.fillRect(0,0,W,window.innerHeight);
    let cy=topH+H/2;

    // Draw gold banner background
    X.fillStyle='rgba(40,20,5,0.85)';
    X.fillRect(0,cy-80,W,140);
    X.strokeStyle='#bfa054';X.lineWidth=3;
    X.beginPath();X.moveTo(0,cy-80);X.lineTo(W,cy-80);X.stroke();
    X.beginPath();X.moveTo(0,cy+60);X.lineTo(W,cy+60);X.stroke();

    // Main text using Cinzel
    X.fillStyle=won?'#ffd700':'#ff4444';X.font="bold 44px 'Cinzel', serif";X.textAlign='center';
    X.shadowColor='rgba(0,0,0,0.8)';X.shadowBlur=6;X.shadowOffsetX=2;X.shadowOffsetY=2;
    X.fillText(won?'VICTORY':'DEFEAT',W/2,cy-15);

    // Subtext using Georgia
    X.fillStyle='#ffebad';X.font="italic 16px Georgia, serif";
    X.shadowBlur=3;X.shadowOffsetX=1;X.shadowOffsetY=1;
    X.fillText(won?'Your empire has triumphed! The enemy town lies in ruins.':'Your forces have been vanquished. Your empire falls to dust.',W/2,cy+25);
    X.shadowBlur=0;X.shadowOffsetX=0;X.shadowOffsetY=0; // Reset shadow
  }
  requestAnimationFrame(gameLoop);
}

init();
gameLoop();

if (typeof window !== 'undefined' && window.location && window.location.search.includes('autostart')) {
  setMapSize('medium');
  window.fogDisabled = true;
  restartGame('standard');
}
