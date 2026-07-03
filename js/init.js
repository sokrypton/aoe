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
  placeWildBears();
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

// AoE2 Arabia wolves, reskinned as bears: a handful of lone predators in
// the no-man's-land between the two towns. Kept well away from both TCs so
// the starting economy is safe — they punish careless scouting and lone
// villagers sent to far resources, not the opening build order.
function placeWildBears(){
  let starts=STARTS.map(s=>({x:s.x+1,y:s.y+1}));
  let placed=0, attempts=0;
  while(placed<5 && attempts<400){
    attempts++;
    let x=randInt(4,MAP-5), y=randInt(4,MAP-5);
    if(!walkable(x,y))continue;
    if(starts.some(s=>Math.sqrt((s.x-x)**2+(s.y-y)**2)<16))continue;
    let bear=createUnit('bear',x,y,2);
    // Den anchor: the bear leashes back here after a chase (see logic.js)
    bear.homeX=x; bear.homeY=y;
    placed++;
  }
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

// ---- MULTIPLAYER: host/join UI glue (see js/net.js for the actual PeerJS
// connection plumbing this calls into) ----
function showMpStatus(text, link){
  let panel = document.getElementById('mp-status-panel');
  let textEl = document.getElementById('mp-status-text');
  let linkRow = document.getElementById('mp-link-row');
  let linkBox = document.getElementById('mp-link-box');
  if (!panel) return;
  panel.style.display = 'block';
  if (textEl) textEl.textContent = text;
  if (link) {
    if (linkRow) linkRow.style.display = 'flex';
    if (linkBox) linkBox.value = link;
  } else if (linkRow) {
    linkRow.style.display = 'none';
  }
}

// The full-screen mid-match blocking overlay — distinct from showMpStatus's
// panel, which lives inside the #tutorial setup menu and is hidden for the
// whole match. Shared by two unrelated triggers: a dropped connection (see
// onNetConnectionClosed/onNetConnectionOpen above) and the host opening
// their menu (see toggleMenu()/the 'host-menu' handler below) — same
// look, different title/text, and the spinner only makes sense for the
// "trying to reconnect" case.
function showMpOverlay(title, text, spinner){
  let el = document.getElementById('mp-disconnect-overlay');
  let titleEl = document.getElementById('mp-disconnect-title');
  let textEl = document.getElementById('mp-disconnect-text');
  let spinnerEl = document.getElementById('mp-disconnect-spinner');
  if (!el) return;
  if (titleEl) titleEl.textContent = title;
  if (textEl) textEl.textContent = text;
  if (spinnerEl) spinnerEl.style.display = spinner ? '' : 'none';
  el.style.display = 'flex';
}
function hideMpOverlay(){
  let el = document.getElementById('mp-disconnect-overlay');
  if (el) el.style.display = 'none';
}
function showDisconnectOverlay(text){
  showMpOverlay('Connection Lost', text, true);
}
function hideDisconnectOverlay(){
  hideMpOverlay();
}

function copyMpLink(){
  let box = document.getElementById('mp-link-box');
  if (!box) return;
  box.select();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(box.value)
      .then(() => { if (window.showMsg) showMsg('Link copied!'); })
      .catch(() => {});
  }
}

// Captured the instant Host is clicked — a match already in progress at
// that moment (gameStarted, not just-finished) means the user loaded a
// save file first and wants to host FROM that state, not start fresh.
// Read by onNetConnectionOpen below to decide whether to restartGame().
let mpHostingFromExistingGame = false;

function onHostClicked(){
  mpHostingFromExistingGame = gameStarted && !gameOver && entities.length > 0;
  if (!mpHostingFromExistingGame) {
    // Only apply the setup screen's map size/speed pickers when actually
    // starting fresh — hosting from an already-loaded save must keep
    // exactly what was in that file, not silently override it with
    // whatever the (irrelevant, in that case) setup controls happen to
    // be set to.
    let sizeSelected = document.querySelector('input[name="mapsize"]:checked');
    setMapSize(sizeSelected ? sizeSelected.value : 'medium');
    let speedSelected = document.querySelector('input[name="gamespeed"]:checked');
    setGameSpeed(speedSelected ? parseFloat(speedSelected.value) : 2);
    window.fogDisabled = false;
  }
  applyAudioSettings();

  let hostBtn = document.getElementById('host-game-btn');
  if (hostBtn) hostBtn.disabled = true;
  showMpStatus('Starting host session…');

  // The menu box has a fixed max-height with no scrolling (intentional,
  // AoE2-style compact layout) — the setup controls plus Start/Save/Load
  // already fill it, so the status panel/link box need room made for them
  // by hiding what's no longer relevant once hosting starts (map size and
  // speed are already locked in above; difficulty doesn't apply without an
  // AI opponent).
  let menu = document.getElementById('tutorial');
  if (menu) {
    menu.querySelectorAll('.setup-grid, #save-load-row, #start-row').forEach(el => { el.style.display = 'none'; });
  }

  hostSession().then(peerId => {
    let link = location.origin + location.pathname + '?join=' + encodeURIComponent(peerId);
    // Deliberately do NOT start the match yet — restartGame() calls
    // startGame(), which hides this very menu (and the link/status panel
    // along with it), so a real host would never get the chance to
    // actually see/copy the link they just generated. The match starts
    // once a guest actually connects (see onNetConnectionOpen below).
    showMpStatus('Waiting for opponent to join…', link);
  }).catch(err => {
    console.error('Failed to host:', err);
    showMpStatus('Could not start hosting — see console for details.');
    if (hostBtn) hostBtn.disabled = false;
  });
}

// Set once the match actually starts (host's first restartGame() call) —
// distinguishes the FIRST connection (which should start/join the match)
// from a later reconnect mid-match (which must resume in place instead of
// re-running restartGame() and wiping out the game in progress).
let mpMatchStarted = false;
let mpReconnectTimer = null;

// Fired by js/net.js once the DataConnection actually opens (both host and
// guest reach this — role-specific handling below).
window.onNetConnectionOpen = function(){
  if (mpReconnectTimer) { clearTimeout(mpReconnectTimer); mpReconnectTimer = null; }
  if (netRole === 'host') {
    // Every fresh connection (first join, or a reconnect) needs a complete
    // map to apply deltas onto — never assume a (re)connecting guest
    // already has current state. See js/net-sync.js.
    guestNeedsFullSync = true;
    if (!mpMatchStarted) {
      mpMatchStarted = true;
      // Fog-of-war vision (updateFog() in core.js) is hardcoded to only
      // track team 0's units/buildings — a single-player assumption, since
      // there's only ever been one human perspective to compute it for.
      // Making it properly per-team is a real architectural change out of
      // scope here; disabling fog entirely for multiplayer (reusing the
      // existing fogDisabled toggle, same one the ?autostart debug flow
      // uses) is the pragmatic v1 trade-off instead — both players just
      // see the whole map. Only needs setting on the HOST: the guest never
      // runs updateFog() itself, it just inherits whatever fog array the
      // host computes as part of each sync payload.
      window.fogDisabled = true;
      if (mpHostingFromExistingGame) {
        // Hosting from a save loaded before Host was clicked — keep that
        // exact state rather than wiping it with a fresh restartGame().
        // The forced full sync above is what actually gets the guest
        // caught up on it, same mechanism a reconnect uses. Getting here
        // means the pause menu was open (that's how Host got clicked),
        // which set gamePaused=true — restartGame() would have implicitly
        // cleared that for the fresh-start path, so it must be done
        // explicitly here too, or the host's own update()/hostSyncTick()
        // never run and the guest never receives anything.
        showMpStatus('Opponent connected! Resuming match…');
        let menu = document.getElementById('tutorial');
        if (menu) menu.style.display = 'none';
        gamePaused = false;
      } else {
        showMpStatus('Opponent connected! Starting match…');
        restartGame('standard');
      }
      // Re-enable Save/Load for the rest of the match — onHostClicked()
      // hid this row to make room for the waiting-for-opponent link panel,
      // but the host (only the host — a guest never reaches this branch)
      // should be able to save an in-progress match, or have already used
      // Load to get here in the first place.
      let saveLoadRow = document.getElementById('save-load-row');
      if (saveLoadRow) saveLoadRow.style.display = '';
    } else {
      // Reconnect: resume exactly where the match was paused, don't touch
      // anything else — the guest gets caught back up by the forced full
      // sync above, same mechanism a first join uses.
      hideDisconnectOverlay();
      gamePaused = false;
    }
  } else if (netRole === 'guest') {
    if (!mpMatchStarted) {
      mpMatchStarted = true;
      showMpStatus('Connected! Waiting for game state…');
    } else {
      hideDisconnectOverlay();
      gamePaused = false;
    }
  }
};

window.onNetConnectionClosed = function(){
  // A drop before the match ever started, or after it's already over, is
  // someone else's flow (the pre-game "waiting to join" status panel, or
  // just a post-game teardown) — not this mid-match pause/reconnect one.
  if (!mpMatchStarted || gameOver) return;
  gamePaused = true;
  showDisconnectOverlay(netRole === 'host'
    ? 'Your opponent disconnected. Waiting for them to reconnect…'
    : 'Connection to host lost. Attempting to reconnect…');
  if (netRole === 'guest') attemptReconnect();
};

// Guest-only: retries joinSession() against the same host peer id every
// few seconds until it succeeds (onNetConnectionOpen above clears the
// timer and resumes the match) or the match ends some other way. The host
// doesn't need an equivalent loop — its own Peer stays alive the whole
// time, passively waiting on the `connection` listener already registered
// in hostSession() (js/net.js), same as it did for the original join.
function attemptReconnect(){
  if (netConnected || gameOver) return;
  joinSession(window.__mpHostPeerId).catch(() => {
    mpReconnectTimer = setTimeout(attemptReconnect, 3000);
  });
}

// Guest-only: whether the HOST currently has their menu open — set by the
// 'host-menu' message below (broadcast from toggleMenu() whenever the host
// opens/closes it). Tracked separately from gamePaused so the guest's own
// local Resume click (toggleMenu()'s close branch, further down) doesn't
// un-pause out from under a host menu that's still open — see the guard
// there.
let hostMenuOpenForGuest = false;

onNetMessage((msg) => {
  if (msg.type !== 'host-menu' || netRole !== 'guest') return;
  hostMenuOpenForGuest = !!msg.open;
  if (hostMenuOpenForGuest) {
    gamePaused = true;
    showMpOverlay('Game Paused', 'The host has paused the game.', false);
  } else {
    gamePaused = false;
    hideMpOverlay();
  }
});

// Guest entry point: called once at boot (see the bottom of this file) if
// the page was opened via a host's shareable ?join= link. Skips the normal
// single-player Start flow — the guest is about to receive the host's
// whole world over the network (Phase 2/net-sync.js), not generate its own
// via init()'s local genMap()/STARTS spawn.
function enterGuestJoinMode(hostPeerId){
  myTeam = 1;
  window.__mpHostPeerId = hostPeerId; // remembered for attemptReconnect() above
  let menu = document.getElementById('tutorial');
  // Hide the normal setup UI (difficulty/map size/start button etc.) —
  // none of it applies to a guest, who inherits the host's match settings.
  if (menu) {
    menu.querySelectorAll('.setup-grid, .menu-button-container, #save-load-row, #mp-row, .menu-divider')
      .forEach(el => { el.style.display = 'none'; });
  }
  showMpStatus('Connecting to host…');
  joinSession(hostPeerId).catch(err => {
    console.error('Failed to join:', err);
    showMpStatus('Could not connect — the link may be invalid or expired.');
  });
}

function handleStartButton(){
  if (window.menuMode === 'restart-ready') {
    onStartClicked();
    return;
  }
  let inMatch = gameStarted && !gameOver && entities.length > 0;
  if (inMatch) {
    openRestartMenu();
  } else {
    onStartClicked();
  }
}

function applyMenuMode(mode){
  let menu = document.getElementById('tutorial');
  let difficultyRow = menu ? menu.querySelector('.setup-grid .setup-row:first-child') : null;
  let startBtn = document.getElementById('start-game-btn');
  let resumeBtn = document.getElementById('resume-game-btn');
  if (!menu) return;
  window.menuMode = mode;

  if (mode === 'ingame') {
    if (difficultyRow) difficultyRow.style.display = 'none';
    if (startBtn) startBtn.textContent = 'Restart';
    if (resumeBtn) resumeBtn.style.display = 'flex';
  } else if (mode === 'restart-ready') {
    if (difficultyRow) difficultyRow.style.display = '';
    if (startBtn) startBtn.textContent = 'Start';
    if (resumeBtn) resumeBtn.style.display = 'none';
  } else {
    if (difficultyRow) difficultyRow.style.display = '';
    if (startBtn) startBtn.textContent = 'Start';
    if (resumeBtn) resumeBtn.style.display = 'none';
  }
}

function openRestartMenu(){
  let menu = document.getElementById('tutorial');
  if (!menu) return;
  menu.style.display = 'flex';
  gamePaused = true;
  applyMenuMode('restart-ready');
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

function isFullscreen(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}

async function toggleFullscreen(){
  let el = document.documentElement;
  try {
    if (isFullscreen()) {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) await document.mozCancelFullScreen();
      else if (document.msExitFullscreen) document.msExitFullscreen();
    } else {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      else if (el.mozRequestFullScreen) await el.mozRequestFullScreen();
      else if (el.msRequestFullscreen) el.msRequestFullscreen();
    }
  } catch (err) {
    console.warn('Fullscreen toggle failed:', err);
  }
}

window.addEventListener('fullscreenchange', ()=>{
  let btn = document.getElementById('fs-btn');
  if (btn) btn.dataset.tipDesc = isFullscreen()
    ? 'Exit fullscreen mode.'
    : 'Enter fullscreen mode.';
});

function toggleMenu(){
  let menu = document.getElementById('tutorial');
  if (menu) {
    if (menu.style.display === 'none' || menu.style.display === '') {
      menu.style.display = 'flex';
      gamePaused = true;
      let inMatch = entities.length > 0 && gameStarted;
      applyMenuMode((inMatch && !gameOver) ? 'ingame' : 'prestart');
      // Pause the GUEST too, with an explanatory overlay — otherwise the
      // match keeps running live on their screen (and the host keeps
      // receiving their commands) while the host can't see or respond to
      // any of it.
      if (netRole === 'host' && netConnected) broadcastToGuest({ type: 'host-menu', open: true });
    } else {
      menu.style.display = 'none';
      // Unpause BEFORE applying audio settings: playAmbientChord skips
      // scheduling while gamePaused, so starting music against a still-paused
      // game would silently defer it to the next phrase (~6s later).
      // Guest-only guard: hostMenuOpenForGuest is only ever true here if
      // the HOST's menu is still open — don't resume out from under that
      // just because the guest's own (separate, local) menu closed.
      if (!hostMenuOpenForGuest) gamePaused = false;
      if (netRole === 'host' && netConnected) broadcastToGuest({ type: 'host-menu', open: false });
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
    // A multiplayer guest never runs its own simulation tick — its
    // `entities`/`map`/etc. get wholesale-overwritten by the host's next
    // sync payload anyway (see net-sync.js), so locally advancing a copy
    // that's about to be discarded is wasted work and can look glitchy
    // (e.g. a cooldown ticking down locally then snapping back on sync).
    // Camera scroll above stays local either way — that's pure UI.
    if (netRole !== 'guest') {
      accumulator += elapsed;
      while (accumulator >= timeStep) {
        update();
        accumulator -= timeStep;
      }
    } else {
      // Nearly every limb/leg/tool/breathing animation in render-units.js
      // is a direct function of the global `tick` (e.g. Math.sin(tick*0.45
      // +e.id) for a walk cycle) — since the guest otherwise only ever
      // gets `tick` overwritten by a sync (applyNetSync), all of that
      // animation was frozen mid-pose between syncs even after position
      // itself started gliding smoothly (advanceGuestUnits below). Nudging
      // `tick` forward by the same real-time-to-tick-equivalent conversion
      // used everywhere else in this branch keeps those animations playing;
      // it's purely a rendering input on the guest (nothing here re-runs
      // gameplay logic keyed on tick), and the next sync's authoritative
      // integer `tick` corrects any drift, same as everything else.
      tick += elapsed / timeStep;

      // Projectiles and unit movement both get smoothed locally between
      // syncs (see advanceGuestProjectiles/advanceGuestUnits in
      // js/loop.js) — purely cosmetic position-only replays of the host's
      // own stepping math, never touching combat/task/hp resolution (that
      // already happened on the host); the next sync's authoritative
      // entities/projectiles lists correct/remove them regardless.
      advanceGuestProjectiles(elapsed);
      advanceGuestUnits(elapsed);
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

// A guest arriving via a host's ?join= link skips the normal local
// init() entirely — it's about to receive the host's whole world over
// the network instead of generating (and briefly showing) its own.
let joinHostId = (typeof window !== 'undefined' && window.location)
  ? new URLSearchParams(window.location.search).get('join') : null;

if (!joinHostId) {
  init();
}
gameLoop();

if (typeof window !== 'undefined' && window.location && window.location.search.includes('autostart')) {
  setMapSize('medium');
  window.fogDisabled = true;
  restartGame('standard');
}

if (joinHostId) {
  enterGuestJoinMode(joinHostId);
}
