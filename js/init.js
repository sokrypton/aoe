// ---- INIT ----
function init(){
  window.bellActive=false;
  window.aiBellActive=false;
  window.lastUnderAttackTick=undefined;
  // Music mood / AI-garrison damage-signals must reset with the tick
  // counter, or a stale large value from the previous match reads as
  // "combat right now".
  window.lastDangerTick=undefined;
  window.lastWarTick=undefined;
  genMap();
  initFog(); // Initialize Fog of War grid
  STARTS.forEach(start=>{
    let tc=createBuilding('TC',start.x,start.y,start.team);
    tc.complete=true;
    // Alternate the starting trio's sex from a random seed so every match
    // opens with a visible mix (a pure coin flip makes all-same 25% likely).
    let firstFemale=Math.random()<0.5;
    for(let i=0;i<3;i++){
      let sp=findSpawnTile(tc.rallyX+i%2,tc.rallyY+Math.floor(i/2),5)||{x:tc.rallyX,y:tc.rallyY};
      createUnit('villager',sp.x,sp.y,start.team).female = (i%2===0)===firstFemale;
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
  // AoE2 Arabia herdables: 4 sheep near the TC, plus 2 far PAIRS the player
  // has to scout to find (8 per player total).
  let nearOffsets=[
    {angle:baseAngle+0.75,dist:4},
    {angle:baseAngle-0.75,dist:4},
    {angle:baseAngle+2.35,dist:6},
    {angle:baseAngle-2.35,dist:6}
  ];
  let farPairs=[
    {angle:baseAngle+1.6+Math.random()*0.4,dist:9},
    {angle:baseAngle-1.6-Math.random()*0.4,dist:9}
  ];
  STARTS.forEach((start,index)=>{
    let center={x:start.x+1,y:start.y+1};
    let place=(o,count)=>{
      let ox=Math.round(Math.cos(o.angle)*o.dist)*(index===0?1:-1);
      let oy=Math.round(Math.sin(o.angle)*o.dist)*(index===0?1:-1);
      for(let i=0;i<count;i++){
        let sp=findSpawnTile(center.x+ox+i,center.y+oy,3);
        if(sp)createUnit('sheep',sp.x,sp.y,2);
      }
    };
    nearOffsets.forEach(o=>place(o,1));
    farPairs.forEach(o=>place(o,2));
  });
}

function startGame(difficulty){
  aiDifficulty=AI_LEVELS[difficulty]?difficulty:'standard';
  gameStarted=true;
  gamePaused=false;
  aiTick=0;
  window.playedGameOverSound = false; // Reset game over sound trigger
  if (window.stopGameOverMusic) window.stopGameOverMusic();
  // Initialize audio on first click. Music must never be able to block the
  // game from starting — a scheduling error here is logged, not fatal.
  try {
    if (window.initAudio) window.initAudio();
    if (window.startAmbientMusic) window.startAmbientMusic();
  } catch (err) {
    console.warn('Music failed to start:', err);
  }
  
  let menu=document.getElementById('tutorial');
  if(menu)menu.style.display='none';
  showMsg('Difficulty: '+AI_LEVELS[aiDifficulty].name);
}

function applyAudioSettings(){
  let sm = document.querySelector('input[name="soundmode"]:checked');
  let mu = document.querySelector('input[name="music"]:checked');
  window.soundMode = sm ? sm.value : 'all';
  window.musicEnabled = mu ? mu.value === 'on' : true;
  try {
    localStorage.setItem('aoeSoundMode', window.soundMode);
    localStorage.setItem('aoeMusic', window.musicEnabled ? 'on' : 'off');
  } catch (e) {}
  // Apply immediately if a match is running (menu can be reopened mid-game)
  if (window.musicEnabled === false) { if (window.stopAmbientMusic) stopAmbientMusic(); }
  else if (gameStarted && !gameOver && window.startAmbientMusic) startAmbientMusic();
}

// Restore saved audio prefs into the menu controls on load
(function restoreAudioSettings(){
  try {
    let sm = localStorage.getItem('aoeSoundMode');
    let mu = localStorage.getItem('aoeMusic');
    if (sm) {
      let el = document.querySelector('input[name="soundmode"][value="'+sm+'"]');
      if (el) el.checked = true;
      window.soundMode = sm;
    }
    if (mu) {
      let el = document.querySelector('input[name="music"][value="'+mu+'"]');
      if (el) el.checked = true;
      window.musicEnabled = mu === 'on';
    }
  } catch (e) {}
})();

function onStartClicked(){
  let selected = document.querySelector('input[name="difficulty"]:checked');
  let diff = selected ? selected.value : 'standard';
  let sizeSelected = document.querySelector('input[name="mapsize"]:checked');
  setMapSize(sizeSelected ? sizeSelected.value : 'medium');
  let speedSelected = document.querySelector('input[name="gamespeed"]:checked');
  setGameSpeed(speedSelected ? parseFloat(speedSelected.value) : 2);
  applyAudioSettings();

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
  window.aiWaveCount = 0;
  window.aiLastWaveTick = null;

  // Reset UI cache to prevent stale HUD panels on restart
  window.lastUIState = null;
  window.lastSelListKey = null;
  window.lastSelGridDetails = null;
  window.lastSelKey = null;

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

function toggleHelp(){
  let o=document.getElementById('help-overlay');
  if(o)o.style.display=(o.style.display==='none'||o.style.display==='')?'flex':'none';
}

function toggleMenu(){
  let menu = document.getElementById('tutorial');
  if (menu) {
    if (menu.style.display === 'none' || menu.style.display === '') {
      menu.style.display = 'flex';
      gamePaused = true;
      let inMatch = entities.length > 0 && gameStarted;
      let resumeBtn = document.getElementById('resume-game-btn');
      if (resumeBtn) {
        // No resuming a finished match — only Restart makes sense then
        resumeBtn.style.display = (inMatch && !gameOver) ? 'flex' : 'none';
      }
      let startBtn = document.getElementById('start-game-btn');
      if (startBtn) {
        startBtn.textContent = inMatch ? 'Restart' : 'Start';
      }
    } else {
      menu.style.display = 'none';
      // Unpause BEFORE applying audio settings: playAmbientChord skips
      // scheduling while gamePaused, so starting music against a still-paused
      // game would silently defer it to the next phrase (~6s later).
      gamePaused = false;
      applyAudioSettings();
      // Apply the other menu settings mid-match too (map size is the one
      // exception — it needs a map regen, so it only takes effect on Restart).
      let speedSel = document.querySelector('input[name="gamespeed"]:checked');
      if (speedSel) setGameSpeed(parseFloat(speedSel.value));
      let diffSel = document.querySelector('input[name="difficulty"]:checked');
      if (diffSel && AI_LEVELS[diffSel.value]) aiDifficulty = diffSel.value;
    }
  }
}

let lastTime = performance.now();
// Simulation runs at 30 ticks per game-second (all tick-count constants in
// core.js/logic.js are authored against that), scaled by GAME_SPEED — like
// AoE2, where "1.7x speed" just runs more game-seconds per real second.
let timeStep = 1000 / (30 * GAME_SPEED);
function setGameSpeed(speed){
  GAME_SPEED = speed;
  timeStep = 1000 / (30 * GAME_SPEED);
}
let accumulator = 0;

function gameLoop(){
  let now = performance.now();
  let elapsed = now - lastTime;
  lastTime = now;

  if (elapsed > 250) elapsed = 250; // prevent spiral of death

  if(gameStarted && !gamePaused) {
    handleScroll(elapsed);
    accumulator += elapsed;
    while (accumulator >= timeStep) {
      update();
      accumulator -= timeStep;
    }
  }
  render();
  updateUI();
  if(gameOver){
    if (!window.playedGameOverSound) {
      window.playedGameOverSound = true;
      if (window.stopAmbientMusic) window.stopAmbientMusic(); // cut ambient so the ending piece stands alone
      if (window.startGameOverMusic) window.startGameOverMusic(won);
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
