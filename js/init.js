// ---- INIT ----
function init(){
  window.bellRinging=Array.from({length:NUM_TEAMS},()=>false); // per-team town-bell state, indexed by team
  window.lastUnderAttackTick=undefined;
  // Music mood / AI-garrison damage-signals must reset with the tick
  // counter, or a stale large value from the previous match reads as
  // "combat right now".
  window.lastDangerTick=undefined;
  window.lastWarTick=undefined;
  genMap();
  initFog(); // Initialize Fog of War grid
  // Scenario loader (js/scenario.js) provides its OWN entities on the blank
  // base — skip the default starting town + wildlife.
  if(!window.__scenarioMode){
  STARTS.forEach(start=>{
    let tc=createBuilding('TC',start.x,start.y,start.team);
    tc.complete=true;
    // Alternate the starting trio's sex from a random seed so every match
    // opens with a visible mix (a pure coin flip makes all-same 25% likely).
    let firstFemale=simRandom()<0.5;
    for(let i=0;i<3;i++){
      let sp=findSpawnTile(tc.rallyX+i%2,tc.rallyY+Math.floor(i/2),5)||{x:tc.rallyX,y:tc.rallyY};
      createUnit('villager',sp.x,sp.y,start.team).female = (i%2===0)===firstFemale;
    }
    let ssp=findSpawnTile(tc.rallyX+2,tc.rallyY+1,5)||{x:tc.rallyX,y:tc.rallyY};
    createUnit('scout',ssp.x,ssp.y,start.team);
  });
  placeStartingSheep();
  placeWildBears();
  }
  let iso=toIso(STARTS[0].x+1,STARTS[0].y+1);camX=iso.ix;camY=iso.iy;
  window.targetCamX=camX;window.targetCamY=camY;
  refreshPopulationCounts();
  // (The old "Drag to pan \u2022 Tap to select" mobile hint that used to show
  // here was removed \u2014 it re-fired on every init(), i.e. every restart and
  // rematch, not just first launch; the \u2753 Help overlay documents the same
  // gestures. #help-hint itself stays: showMsg() still coordinates with it.)
}

function placeStartingSheep(){
  let starts=STARTS.map(s=>({x:s.x+1,y:s.y+1}));
  // AoE2 Arabia herdables: 4 sheep near the TC, plus 2 far PAIRS the player
  // has to scout to find (8 per player total). TWO starts keep the original
  // shared-axis + sign-flip layout verbatim (exact sim-RNG order, 1v1 maps
  // bit-identical); more starts orient each base's kit toward the map
  // center, each with its own far-pair jitter draws.
  let buildOffsets=angle=>({
    near:[
      {angle:angle+0.75,dist:4},
      {angle:angle-0.75,dist:4},
      {angle:angle+2.35,dist:6},
      {angle:angle-2.35,dist:6}
    ],
    far:[
      {angle:angle+1.6+simRandom()*0.4,dist:9},
      {angle:angle-1.6-simRandom()*0.4,dist:9}
    ]
  });
  let placeKit=(center,offs,sign)=>{
    let place=(o,count)=>{
      let ox=Math.round(simCos(o.angle)*o.dist)*sign;
      let oy=Math.round(simSin(o.angle)*o.dist)*sign;
      for(let i=0;i<count;i++){
        let sp=findSpawnTile(center.x+ox+i,center.y+oy,3);
        if(sp)createUnit('sheep',sp.x,sp.y,GAIA_TEAM);
      }
    };
    offs.near.forEach(o=>place(o,1));
    offs.far.forEach(o=>place(o,2));
  };
  if(STARTS.length===2){
    let baseAngle=simAtan2(starts[1].y-starts[0].y,starts[1].x-starts[0].x);
    let offs=buildOffsets(baseAngle); // one shared kit, mirrored by the sign flip
    STARTS.forEach((start,index)=>{
      placeKit({x:start.x+1,y:start.y+1},offs,index===0?1:-1);
    });
  } else {
    STARTS.forEach(start=>{
      let center={x:start.x+1,y:start.y+1};
      placeKit(center,buildOffsets(simAtan2(MAP/2-center.y,MAP/2-center.x)),1);
    });
  }
}

// AoE2 Arabia wolves, reskinned as bears: a handful of lone predators in
// the no-man's-land between the two towns. Kept well away from both TCs so
// the starting economy is safe — they punish careless scouting and lone
// villagers sent to far resources, not the opening build order.
function placeWildBears(){
  if(window.__noBears)return; // headless-sim opt-out (tools/sim.html 'bears=0') — never set by the real game
  let starts=STARTS.map(s=>({x:s.x+1,y:s.y+1}));
  let placed=0, attempts=0;
  while(placed<5 && attempts<400){
    attempts++;
    let x=simRandInt(4,MAP-5), y=simRandInt(4,MAP-5);
    if(!walkable(x,y))continue;
    if(starts.some(s=>{let bdx=s.x-x,bdy=s.y-y;return Math.sqrt(bdx*bdx+bdy*bdy)<16}))continue;
    let bear=createUnit('bear',x,y,GAIA_TEAM);
    // Den anchor: the bear leashes back here after a chase (see logic.js)
    bear.homeX=x; bear.homeY=y;
    placed++;
  }
}

function startGame(difficulty){
  aiDifficulty=AI_LEVELS[difficulty]?difficulty:'standard';
  // Sync the AI slots' difficulty to the menu pick (per-team difficulty is
  // what the AI actually reads — aiProfileFor, js/core.js).
  teamControllers.forEach(c => { if (c && c.type === 'ai') c.difficulty = aiDifficulty; });
  gameStarted=true;
  gamePaused=false;
  // A genuine fresh start — no other pause reason should carry over from
  // whatever came before (see recomputeGamePaused()/the flags it reads,
  // further down this file).
  localMenuOpen = false;
  remoteMenuOpen = false;
  disconnectedPause = false;
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

// Non-audio settings, same live-apply-and-persist idea as
// applyAudioSettings above. Speed and difficulty take effect immediately
// (both are safe to change mid-match); map size only matters at the next
// restart, but its choice is persisted here all the same. A guest never
// applies speed locally — GAME_SPEED is host-authoritative and arrives via
// sync (js/net-sync.js); writing it here would just fight the next sync.
function applyGameSettings(){
  let speedSel = document.querySelector('input[name="gamespeed"]:checked');
  if (speedSel && netRole !== 'guest') {
    let v = parseFloat(speedSel.value);
    if (typeof lockstepEnabled === 'function' && lockstepEnabled()) {
      // Lockstep: pacing must change on BOTH peers at the same tick — a
      // host-only setGameSpeed just makes the host outrun the gating window
      // and stall right back to the guest's old rate (looks like "speed
      // can't be changed"). Routed through the command queue instead.
      if (v !== GAME_SPEED) submitCommand({ kind: 'set-speed', v });
    } else {
      setGameSpeed(v);
    }
  }
  let diffSel = document.querySelector('input[name="difficulty"]:checked');
  if (diffSel && AI_LEVELS[diffSel.value]) aiDifficulty = diffSel.value;
  let sizeSel = document.querySelector('input[name="mapsize"]:checked');
  let playersSel = document.querySelector('input[name="players"]:checked');
  try {
    if (diffSel) localStorage.setItem('aoeDifficulty', diffSel.value);
    if (sizeSel) localStorage.setItem('aoeMapSize', sizeSel.value);
    if (speedSel) localStorage.setItem('aoeGameSpeed', speedSel.value);
    if (playersSel) localStorage.setItem('aoePlayers', playersSel.value);
  } catch (e) {}
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

// Same restore for difficulty/map size/speed. Only the radio gets checked —
// no globals are written here: everything that consumes these reads the
// checked radio at start time (onStartClicked/onHostClicked), so the radios
// are the single source of truth and there's no ordering dependency on
// core.js having initialized.
(function restoreGameSettings(){
  try {
    [['aoeDifficulty','difficulty'], ['aoeMapSize','mapsize'], ['aoeGameSpeed','gamespeed'], ['aoePlayers','players']]
      .forEach(([key, name]) => {
        let v = localStorage.getItem(key);
        if (!v) return;
        let el = document.querySelector('input[name="'+name+'"][value="'+v+'"]');
        if (el) el.checked = true;
      });
    // The player's chosen lobby name (js/lobby.js persists it here). A plain
    // global — the lobby seeds its own seat's name input from it.
    let nm = localStorage.getItem('aoePlayerName');
    if (nm) localPlayerName = nm;
  } catch (e) {}
})();

// ---- Two-level menu: 'main' (big actions) vs 'options' (settings grid) ----
// Orthogonal to applyMenuMode()'s menuMode — menuMode decides WHICH actions
// are visible for the current game state; menuPanel decides which of the
// two panels is showing. Every path that opens the menu resets to 'main'.
function showMenuPanel(which){
  let main = document.getElementById('menu-panel-main');
  let opts = document.getElementById('menu-panel-options');
  let lobby = document.getElementById('menu-panel-lobby');
  if (main) main.style.display = which === 'main' ? '' : 'none';
  if (opts) opts.style.display = which === 'options' ? '' : 'none';
  if (lobby) lobby.style.display = which === 'lobby' ? '' : 'none';
  updateUiSwitchVisibility();
  scaleMenuToFit();
}

// The menu is authored at two FIXED design sizes (see the fixed-size menu
// block in styles.css) and scaled uniformly to fit the viewport — a game
// splash screen, not a fluid layout. Measured from layout size (transform
// doesn't affect offsetWidth/Height), so it must re-run whenever the
// menu's content changes height (panel switch, host status/QR, menu mode).
function scaleMenuToFit(){
  let wrap = document.getElementById('menu-scale-wrap');
  if (!wrap) return;
  wrap.style.transform = 'none';
  let w = wrap.offsetWidth, h = wrap.offsetHeight;
  if (!w || !h) return;
  let s = Math.min((window.innerWidth - 12) / w, (window.innerHeight - 12) / h, 1.15);
  wrap.style.transform = s === 1 ? 'none' : 'scale(' + s + ')';
}
window.addEventListener('resize', scaleMenuToFit);
window.addEventListener('orientationchange', scaleMenuToFit);

// The "Switch to Classic/Mobile UI" link below the menu box only belongs
// on the pristine pre-game MAIN menu: switching pages mid-match would
// discard a running (or paused) game, and during any multiplayer flow the
// page navigation would tear down the live connection. Everything that
// changes menu state funnels through showMenuPanel/applyMenuMode, plus the
// explicit MP entry points below.
function updateUiSwitchVisibility(){
  let row = document.getElementById('ui-switch-row');
  if (!row) return;
  let preGame = (window.menuMode === undefined || window.menuMode === 'prestart')
    && !netRole && !gameStarted && menuPanelIsMain();
  // A touch-device user on the mobile page has no business being offered
  // the desktop-oriented classic skin — hide the link entirely for them.
  // The reverse direction stays: a phone user who lands on classic.html
  // very much wants the escape hatch back to the mobile UI.
  let wrongAudience = isMobile && !(typeof isClassicUI !== 'undefined' && isClassicUI);
  row.style.display = (preGame && !wrongAudience) ? '' : 'none';
}
function menuPanelIsMain(){
  let opts = document.getElementById('menu-panel-options');
  return !opts || opts.style.display === 'none';
}

// Back button: settings take effect the moment you leave Options, not only
// when the whole menu closes — otherwise "changed music off, hit Back,
// resumed" would surprisingly keep playing until the next menu visit.
function closeOptionsPanel(){
  applyAudioSettings();
  applyGameSettings();
  showMenuPanel('main');
}

function onStartClicked(){
  // "Rematch" — the HOST restarting after a finished MP match whose
  // connection is still alive: a fresh lockstep match over the same
  // session, exactly the way onNetConnectionOpen starts the first one
  // (the guest's game-over menu dismisses in its lockstep-start handler).
  if (netRole === 'host' && netConnected && gameOver) {
    let speedSel = document.querySelector('input[name="gamespeed"]:checked');
    // Set GAME_SPEED directly (not via applyGameSettings): hostStartLockstepMatch
    // below reads GAME_SPEED into its start payload, and applyGameSettings's
    // lockstep branch only ENQUEUES a set-speed command (executes ticks later)
    // without updating GAME_SPEED now — so the payload would ship a stale speed.
    // The set-speed command applyGameSettings then skips (v===GAME_SPEED) is
    // intentional: this is a fresh-match start, not a mid-match speed change.
    setGameSpeed(speedSel ? parseFloat(speedSel.value) : 2);
    applyAudioSettings();
    applyGameSettings();
    hostStartLockstepMatch(); // reads the mapsize radio itself
    window.__mpSession.cameraCentered = false;
    restoreMenuForMatch();
    showMsg('Rematch! A new battle begins');
    return;
  }
  // "Play Again" from a finished multiplayer match with a DEAD connection
  // starts a fresh LOCAL game — tear the session remnants down first so
  // netRole/myTeam don't leak multiplayer behavior (guest never
  // simulating, host broadcasting syncs) into the single-player match.
  if (netRole && gameOver) leaveMpSession();
  let selected = document.querySelector('input[name="difficulty"]:checked');
  let diff = selected ? selected.value : 'standard';
  // Match shape (single-player only — MP paths force 2). Must be set
  // BEFORE setMapSize (which builds STARTS and draws sim RNG) and before
  // restartGame (which sizes every per-team structure from NUM_TEAMS).
  let playersSelected = document.querySelector('input[name="players"]:checked');
  NUM_TEAMS = playersSelected && playersSelected.value === '4' ? 4 : 2;
  let sizeSelected = document.querySelector('input[name="mapsize"]:checked');
  setMapSize(sizeSelected ? sizeSelected.value : 'medium');
  let speedSelected = document.querySelector('input[name="gamespeed"]:checked');
  setGameSpeed(speedSelected ? parseFloat(speedSelected.value) : 2);
  applyAudioSettings();
  applyGameSettings();

  window.fogDisabled = false;

  // Always regenerate the map (even on a fresh load) so the chosen size takes effect,
  // since init() already ran once at script load with the default size.
  restartGame(diff);
}

// ---- MULTIPLAYER: host/join UI glue (see js/net.js for the actual PeerJS
// connection plumbing this calls into) ----
// Defer one frame so the DOM the rescale measures includes this update.
function scheduleMenuRescale(){
  requestAnimationFrame(() => { if (typeof scaleMenuToFit === 'function') scaleMenuToFit(); });
}

function showMpStatus(text, link){
  let panel = document.getElementById('mp-status-panel');
  let textEl = document.getElementById('mp-status-text');
  let linkRow = document.getElementById('mp-link-row');
  let linkBox = document.getElementById('mp-link-box');
  let qrEl = document.getElementById('mp-qr');
  let noteEl = document.getElementById('mp-share-note');
  if (!panel) return;
  panel.style.display = 'block';
  if (textEl) textEl.textContent = text;
  // The 1v1 warning travels with the link: there's deliberately NO code
  // guarding against a second person joining (a token-based seat guard was
  // tried and reverted — it kept kicking the legitimate guest), so the
  // protection is social: tell the host to share with exactly one person.
  if (noteEl) noteEl.style.display = link ? '' : 'none';
  scheduleMenuRescale();
  if (link) {
    if (linkRow) linkRow.style.display = 'flex';
    if (linkBox) linkBox.value = link;
    // QR of the join link, for the sitting-across-the-table case — the
    // guest points their phone camera at the host's screen instead of
    // anyone typing/sending a URL. qrcode-generator is loaded from unpkg
    // like PeerJS; if the CDN is unreachable the link box still works, so
    // this degrades silently. Error level M, auto type — a localhost or
    // github.io join URL fits comfortably.
    if (qrEl) {
      try {
        if (typeof qrcode !== 'undefined') {
          let qr = qrcode(0, 'M');
          qr.addData(link);
          qr.make();
          qrEl.innerHTML = qr.createImgTag(4, 8);
          qrEl.style.display = 'flex';
        }
      } catch (err) {
        console.warn('QR generation failed:', err);
        qrEl.style.display = 'none';
      }
    }
  } else {
    if (linkRow) linkRow.style.display = 'none';
    if (qrEl) { qrEl.style.display = 'none'; qrEl.innerHTML = ''; }
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
  // Safety hatch on a genuine DISCONNECT (the spinner case — not the
  // opponent-paused overlay): either side can bank the match to a file
  // right there while waiting, in case the reconnect never comes. A guest
  // save is just as valid as a host one (see js/save.js).
  let saveBtn = document.getElementById('mp-disconnect-save');
  if (saveBtn) saveBtn.style.display = (spinner && gameStarted && entities.length > 0 && netRole !== 'guest') ? '' : 'none';
  el.style.display = 'flex';
}
function hideMpOverlay(){
  let el = document.getElementById('mp-disconnect-overlay');
  if (el) el.style.display = 'none';
}
function showDisconnectOverlay(text, showKick){
  showMpOverlay('Connection Lost', text, true);
  let kickBtn = document.getElementById('mp-disconnect-kick');
  if (kickBtn) kickBtn.style.display = showKick ? '' : 'none';
}
function hideDisconnectOverlay(){
  let kickBtn = document.getElementById('mp-disconnect-kick');
  if (kickBtn) kickBtn.style.display = 'none';
  hideMpOverlay();
}

// HOST: recompute the "waiting for a disconnected player" pause and tell
// every guest. One authority, one verdict — each guest mirrors it rather
// than tracking connectivity it can't see. Also drives the host's own
// overlay, with the kick option once someone is actually missing.
function hostBroadcastDcPause(){
  if (netRole !== 'host' || !mpMatchStarted || gameOver) return;
  let missing = (typeof lockstepExpectedSeatsMissing === 'function') ? lockstepExpectedSeatsMissing() : [];
  let waiting = missing.map(t => (typeof teamNames !== 'undefined' && teamNames && teamNames[t]) || ('Player ' + (t + 1)));
  broadcastToGuests({ type: 'match-pause', kind: 'dc', paused: missing.length > 0, waiting });
  disconnectedPause = missing.length > 0;
  if (missing.length > 0) {
    showDisconnectOverlay('Waiting for ' + waiting.join(', ') + ' to reconnect…', true);
  } else if (!remoteMenuOpen) {
    hideDisconnectOverlay();
  }
  recomputeGamePaused();
}

// HOST: the overlay's "Continue without them" button — every missing seat
// is closed for good (kicked=true keeps its hello denied) and handed to
// the AI via the deterministic set-controller command; then the pause
// verdict is recomputed (nobody missing anymore -> everyone resumes, and
// the command executes a few ticks later on every peer alike).
function kickDisconnectedPlayers(){
  if (netRole !== 'host') return;
  let missing = (typeof lockstepExpectedSeatsMissing === 'function') ? lockstepExpectedSeatsMissing() : [];
  for (const seat of missing) {
    if (typeof netCloseGuest === 'function') netCloseGuest(seat, 'kicked', true);
    guestMenuOpenBySeat.delete(seat);
    // Stamp the host's authoritative difficulty into the payload so the new
    // AI brain is identical on every peer (commands.js set-controller).
    submitCommand({ kind: 'set-controller', t: seat, diff: (typeof aiDifficulty !== 'undefined' ? aiDifficulty : 'standard') });
  }
  hostBroadcastDcPause();
}

// Once the match has genuinely started, the pre-match setup/connecting UI
// needs to stop showing forever, not just while #tutorial happens to be
// hidden — otherwise reopening the menu mid-match (the pause menu) shows
// the stale "Connected!"/"Opponent connected! Starting match…" status text.
// The multiplayer mid-match menu is also deliberately minimal — Resume and
// Save Game only, for BOTH roles:
//   - No Restart: regenerating the whole match isn't something a live 1v1
//     should support mid-game (single-player's menu still has it —
//     see the untouched applyMenuMode()).
//   - No Load: loading a file mid-connected-match would just get
//     overwritten by the host's own next sync (on the host) or corrupt
//     the guest's mirror of it (on the guest) — the intended reload flow
//     is save now, close, load-and-host fresh later (see
//     saveGameToFile()'s wasMultiplayerGame tag).
//   - No difficulty/map/speed/sound/music pickers, no Help, no re-showing
//     the "Host Multiplayer Game" button (already mid-match).
//   - Save Game IS shown for both roles: the guest's entities/map are a
//     live mirror of the host's (js/net-sync.js), so a save taken from
//     either side is an equally valid snapshot.
function restoreMenuForMatch(){
  showMenuPanel('main');
  updateUiSwitchVisibility();
  let startRow = document.getElementById('start-row');
  if (startRow) startRow.style.display = '';
  let statusPanel = document.getElementById('mp-status-panel');
  if (statusPanel) statusPanel.style.display = 'none';
  let startBtn = document.getElementById('start-game-btn');
  if (startBtn) startBtn.style.display = 'none';
  let menu = document.getElementById('tutorial');
  // Options + Help ARE available mid-match now (unlike the pre-two-level
  // menu, which dropped Help to keep the single panel small). Explicitly
  // re-shown — a guest's enterGuestJoinMode broad-hid every
  // .menu-button-container, including the ones inside #misc-row.
  if (menu) {
    menu.querySelectorAll('#misc-row, #misc-row .menu-button-container, #options-back-row')
      .forEach(el => { el.style.display = ''; });
    // The settings grid lives in the (hidden) options panel; what's
    // restart-scoped or host-authoritative gets hidden INSIDE it rather
    // than hiding the grid wholesale: difficulty/map size need a fresh
    // match, and speed is the host's call — a guest's GAME_SPEED arrives
    // via sync (js/net-sync.js), so showing the picker would be a lie.
    let grid = menu.querySelector('.setup-grid');
    if (grid) grid.style.display = '';
    let firstRow = menu.querySelector('.setup-grid .setup-row:first-child');
    if (firstRow) firstRow.style.display = 'none';
    let speedCol = menu.querySelector('.setup-col-speed');
    if (speedCol) speedCol.style.display = netRole === 'guest' ? 'none' : '';
    menu.querySelectorAll('.menu-divider').forEach(el => { el.style.display = 'none'; });
  }
  let mpRow = document.getElementById('mp-row');
  if (mpRow) mpRow.style.display = 'none';
  let saveLoadRow = document.getElementById('save-load-row');
  if (saveLoadRow) saveLoadRow.style.display = '';
  // Save Game is hidden by default in the HTML (no match exists yet on the
  // pre-game screen) — now that one genuinely does, show it back. HOST
  // only in multiplayer: a guest can't reload+re-host a save (it rejoins
  // the host's reload by token instead), so offering it would be a lie.
  let saveBtn = document.getElementById('save-game-btn');
  if (saveBtn) saveBtn.style.display = netRole === 'guest' ? 'none' : '';
  let loadBtn = document.getElementById('load-game-btn');
  if (loadBtn) loadBtn.style.display = 'none';
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
  // Slot 1 becomes a (future) human guest the instant Host is clicked —
  // NOT when the guest connects — so the AI can't make irreversible
  // decisions (spend resources, queue units) during the waiting-for-
  // opponent window. This is the data-driven successor to the old
  // `netRole == null` gate around updateAI (js/loop.js). AI_STATES[1] is
  // deliberately left in place: cancelHosting() flips the slot back and
  // the AI resumes its plans exactly where it stopped.
  // Hosting from an in-progress game: a loaded MP save already carries the
  // real human/AI seat layout — keep it verbatim (its guests rejoin their
  // own seats by token). Hosting a single-player game as MP is the one
  // case with no human guest seat yet: seat 1 flips to human for the guest
  // (its AI plan state is kept — cancelHosting flips it back and the AI
  // resumes exactly where it stopped). AI slots always keep their
  // controllers, or those teams freeze forever (isAITeam false → their
  // brains never run).
  teamControllers = mpHostingFromExistingGame
    ? (teamControllers.some((c, t) => t > 0 && c && c.type === 'human')
        ? teamControllers
        : teamControllers.map((c, t) => t === 1 ? {type:'human'} : c))
    : defaultControllers(true);
  if (!mpHostingFromExistingGame) {
    // Only apply the setup screen's map size/speed pickers when actually
    // starting fresh — hosting from an already-loaded save must keep
    // exactly what was in that file, not silently override it with
    // whatever the (irrelevant, in that case) setup controls happen to
    // be set to.
    NUM_TEAMS = 2; // placeholder while waiting in the lobby (SP Players picker doesn't apply); hostStartLockstepMatch re-derives the real count from the lobby seats
    let sizeSelected = document.querySelector('input[name="mapsize"]:checked');
    setMapSize(sizeSelected ? sizeSelected.value : 'medium');
    let speedSelected = document.querySelector('input[name="gamespeed"]:checked');
    setGameSpeed(speedSelected ? parseFloat(speedSelected.value) : 2);
    applyGameSettings();
    window.fogDisabled = false;
  }
  applyAudioSettings();

  let hostBtn = document.getElementById('host-game-btn');
  if (hostBtn) hostBtn.disabled = true;
  showMpStatus('Starting host session…');
  let cancelBtn = document.getElementById('mp-cancel-btn');
  if (cancelBtn) cancelBtn.style.display = '';

  // Hide the action rows so the "waiting for opponent" status/link panel
  // stands alone (the settings grid needs no hiding anymore — it lives in
  // the separate options panel). #mp-row (this very button) is included
  // too — disabling it alone still left it sitting there grayed out, which
  // reads as "you could still click this," not "you're already hosting."
  // Everything hidden here is restored by cancelHosting() below.
  let menu = document.getElementById('tutorial');
  if (menu) {
    menu.querySelectorAll('#save-load-row, #start-row, #mp-row, #misc-row').forEach(el => { el.style.display = 'none'; });
  }

  // Only meaningful right after loading a multiplayer save (js/save.js sets
  // this one-shot flag) — read-then-clear so it never leaks into a later,
  // unrelated "Host" button click that has nothing to do with a load.
  let desiredPeerId = window.__mpSession.loadedHostPeerId || null;
  window.__mpSession.loadedHostPeerId = null;

  let hostPromise = hostSession(desiredPeerId);
  updateUiSwitchVisibility(); // netRole is 'host' from here — hide the page-switch link
  hostPromise.then(peerId => {
    // Cancelled while the signaling server was still assigning an id
    // (cancelHosting → teardownNet nulls netRole) — don't resurrect the
    // "waiting" panel the user just dismissed, and destroy the
    // just-created peer (hostSession assigned it to netPeer in finish(),
    // AFTER teardownNet already ran) so no one can still join it.
    if (netRole !== 'host') {
      if (netPeer) { try { netPeer.destroy(); } catch (e) {} netPeer = null; }
      return;
    }
    // NOTE: the HOST's own ?host=<id> resume URL is deliberately NOT written
    // here anymore — only once the match actually starts (setHostResumeUrl,
    // called from hostStartLockstepMatch / the save-resume path). Otherwise a
    // host refreshing during the LOBBY would boot straight into
    // enterHostResumeMode and try to auto-recover a match that never began.
    let link = location.origin + location.pathname + '?join=' + encodeURIComponent(peerId);
    // The host waits here with just the shareable link/QR — the PRE-MATCH LOBBY
    // (js/lobby.js) only appears once a human guest actually connects (see
    // onNetConnectionOpen → hostEnterLobby). Remember the link so a guest
    // leaving the lobby drops the host back onto this same waiting screen.
    if (typeof lobbyShareLink !== 'undefined') lobbyShareLink = link;
    showMpStatus('Waiting for opponent to join…', link);
  }).catch(err => {
    console.error('Failed to host:', err);
    showMpStatus('Could not start hosting — see console for details.');
    if (hostBtn) hostBtn.disabled = false;
  });
}

// Write the HOST's own ?host=<id> resume URL — but ONLY once the match has
// actually started (called from hostStartLockstepMatch and the save-resume
// path). If this page later dies mid-match, reopening it from history/tab-
// restore re-enters the match via enterHostResumeMode (reclaim the same peer
// id, let the guest's retry loop reconnect, recover the world from the guest's
// live mirror). Deliberately NOT set during the lobby: a host refreshing
// before Start should get a clean menu, not an auto-resume attempt.
function setHostResumeUrl(){
  try {
    if (typeof netPeer !== 'undefined' && netPeer && netPeer.id) {
      history.replaceState(null, '', location.pathname + '?host=' + encodeURIComponent(netPeer.id));
    }
  } catch (e) {}
}

// Set once the match actually starts (host's first restartGame() call) —
// distinguishes the FIRST connection (which should start/join the match)
// from a later reconnect mid-match (which must resume in place instead of
// re-running restartGame() and wiping out the game in progress).
let mpMatchStarted = false;
let mpReconnectTimer = null;

// Fully leave multiplayer: transport teardown (teardownNet, js/net.js) plus
// all the session-level state that lives HERE rather than in net.js — the
// reconnect retry timer especially: left armed, it would re-join the old
// host seconds after the user deliberately walked away.
function leaveMpSession(){
  if (mpReconnectTimer) { clearTimeout(mpReconnectTimer); mpReconnectTimer = null; }
  teardownNet();
  myTeam = 0;
  localHumanTeam = 0;
  guestMenuOpenBySeat.clear();
  window.__mpSession.mySeat = null;
  mpMatchStarted = false;
  mpHostingFromExistingGame = false;
  disconnectedPause = false;
  window.__mpSession.loadedHostPeerId = null;
  window.__mpSession.awaitingStateFromGuest = false;
  // Tear down any pre-match lobby (js/lobby.js) too — a stale lobbyState /
  // inLobby flag would confuse the next host/join attempt.
  window.__mpSession.inLobby = false;
  lobbyState = null;
  lobbyShareLink = null;
  // The ?host= resume URL points at a session that no longer exists —
  // leaving it in place would make a later reload silently re-enter the
  // (dead) resume flow instead of the normal menu.
  try {
    if (new URLSearchParams(location.search).has('host')) history.replaceState(null, '', location.pathname);
  } catch (e) {}
  recomputeGamePaused();
}

// Wired to #mp-cancel-btn on the "Waiting for opponent…" screen — before
// this, clicking Host was irreversible: the setup UI was hidden and the
// only way back was a page refresh.
function cancelHosting(){
  let wasMidMatch = mpHostingFromExistingGame;
  leaveMpSession();
  // Back to single-player: slot 1 reverts to the AI (onHostClicked flipped
  // it to 'human' so the AI would sit out the waiting window). Its plan
  // state was kept, so a match resumed behind the menu continues seamlessly.
  teamControllers = defaultControllers(false);
  if (AI_STATES && !AI_STATES[1]) AI_STATES[1] = freshAIState(1);
  let panel = document.getElementById('mp-status-panel');
  if (panel) panel.style.display = 'none';
  let cancelBtn = document.getElementById('mp-cancel-btn');
  if (cancelBtn) cancelBtn.style.display = 'none';
  let qrEl = document.getElementById('mp-qr');
  if (qrEl) { qrEl.style.display = 'none'; qrEl.innerHTML = ''; }
  let hostBtn = document.getElementById('host-game-btn');
  if (hostBtn) hostBtn.disabled = false;
  // Restore exactly the rows onHostClicked hid, then let applyMenuMode
  // re-derive per-button visibility for wherever we actually are (hosting
  // from a loaded save means a match is live behind the menu → 'ingame').
  ['save-load-row', 'start-row', 'mp-row', 'misc-row'].forEach(id => {
    let el = document.getElementById(id);
    if (el) el.style.display = '';
  });
  showMenuPanel('main');
  applyMenuMode(wasMidMatch && gameStarted && !gameOver && entities.length > 0 ? 'ingame' : 'prestart');
}

// Fired by js/net.js when a connection becomes usable. On a GUEST that's
// the DataConnection to the host opening; on the HOST it fires once per
// guest, AFTER that guest's hello has bound it to a seat (`seat` is only
// passed on the host).
window.onNetConnectionOpen = function(seat){
  if (mpReconnectTimer) { clearTimeout(mpReconnectTimer); mpReconnectTimer = null; }
  if (netRole === 'guest') {
    // Version handshake — announce our wire-format version the moment the
    // channel opens (the host sends its own from wireHostConnection); the
    // mismatch handler below tells BOTH players to refresh instead of
    // letting a stale cached build surface as mystery desync. The hello
    // right after it is what earns this connection a seat: the persistent
    // token lets a reconnect land back on the same seat.
    sendToHost({ type: 'proto', v: NET_PROTOCOL_VERSION });
    sendToHost({ type: 'hello', token: mpClientToken(), tab: mpTabId(), name: (localPlayerName || '').trim() });
  }
  if (netRole === 'host') {
    // ?host= resume: this rehosted page has NO world of its own — the only
    // current copy is the guest's live mirror. Ask for it instead of
    // wiping the match with a fresh restartGame(); the 'state-snapshot'
    // reply (js/net-sync.js) applies it and finishes match setup. Repeat
    // the request every 5s until one lands (same belt-and-suspenders idea
    // as requestFullSync) — the interval self-clears once the flag drops.
    if (window.__mpSession.awaitingStateFromGuest) {
      showMpStatus('Opponent reconnected! Recovering match…');
      broadcastToGuests({ type: 'request-state' });
      if (!window.__mpSession.stateRequestTimer) {
        window.__mpSession.stateRequestTimer = setInterval(() => {
          if (!window.__mpSession.awaitingStateFromGuest || !netConnected) {
            clearInterval(window.__mpSession.stateRequestTimer);
            window.__mpSession.stateRequestTimer = null;
            return;
          }
          broadcastToGuests({ type: 'request-state' });
        }, 5000);
      }
      return;
    }
    if (!mpMatchStarted) {
      // Real per-team fog now (updateFog() in js/core.js computes vision
      // for `myTeam` — 0 on the host, 1 on the guest — instead of a
      // hardcoded team 0). Force it on explicitly regardless of whatever
      // a loaded save's own fogDisabled flag was — a live multiplayer
      // match should always use real fog, not a leftover "reveal map"
      // setting from single-player. The guest forces it too on its own
      // start path (js/lockstep.js), and resync state carries the flag
      // (it gates sim-visible checks), so both peers agree.
      window.fogDisabled = false;
      if (mpHostingFromExistingGame) {
        // Hosting from a save loaded before Host was clicked — keep that
        // exact state: hand it to the guest and enter lockstep from it
        // (same machinery as desync recovery). Getting here means the
        // pause menu was open (that's how Host got clicked), which set
        // gamePaused=true — clear it so the loop resumes. This flow skips
        // the lobby (it resumes an existing world, doesn't negotiate).
        mpMatchStarted = true;
        setHostResumeUrl(); // match is live now → arm the ?host= resume URL
        showMpStatus('Opponent connected! Resuming match…');
        lockstepActive = true;
        lockstepResetState();
        DET.enabled = true;
        lockstepResumeGuest(seat);
        let menu = document.getElementById('tutorial');
        if (menu) menu.style.display = 'none';
        localMenuOpen = false;
        recomputeGamePaused();
        // Re-show the (now minimal) mid-match menu — see restoreMenuForMatch.
        restoreMenuForMatch();
      } else {
        // Fresh match: a human guest just connected to a host waiting on the
        // invite screen. Enter the PRE-MATCH LOBBY (js/lobby.js) — the match
        // does NOT start until the host clicks Start. Do NOT set mpMatchStarted
        // here: it gates every reconnect/resume branch and must only flip when
        // the match actually begins (hostStartLockstepMatch).
        if (typeof hostEnterLobby === 'function') hostEnterLobby(seat);
      }
    } else {
      // Reconnect: resume exactly where the match was paused. Hand the
      // (possibly brand-new) guest page the full sim state and re-enter
      // lockstep — same machinery as desync recovery; the OTHER guests get
      // the same state as a resync so everyone stays bit-identical. Only
      // clears the pause when no other guest is still out —
      // recomputeGamePaused() also keeps the game paused if e.g. this
      // host's own menu happens to be open at the exact moment of the
      // reconnect.
      if (lockstepEnabled()) lockstepResumeGuest(seat);
      hostBroadcastDcPause(); // clears the pause once nobody is missing
    }
    // Re-broadcast the aggregate pause verdict regardless of which branch
    // above ran. A (re)connecting guest's own remoteMenuOpen is a mirrored
    // copy of whatever the LAST 'match-pause' it ever received said — if
    // the previous host session died (crash/reload) while a menu happened
    // to be open, the matching open:false can never arrive (the whole page
    // is gone), permanently stranding that guest paused with nothing on
    // screen to explain why (confirmed by an actual test in the 1v1 era).
    // The freshly recomputed verdict is always known-correct here. Only
    // meaningful once the match is live — during the lobby there's no sim
    // to pause, and a lobby panel isn't a "menu" the host should mirror.
    if (mpMatchStarted) hostBroadcastPauseState();
  } else if (netRole === 'guest') {
    if (!mpMatchStarted) {
      // First connect → wait for the host's lobby-open (js/lobby.js), which
      // swaps in the lobby panel. Do NOT set mpMatchStarted here: it gates
      // reconnect/resume and must only flip when the match actually starts
      // (the guest's lockstep-start handler, js/lockstep.js).
      showMpStatus('Connected! Entering lobby…');
    } else {
      hideDisconnectOverlay();
      disconnectedPause = false;
      recomputeGamePaused();
    }
  }
};

// GUEST-only (js/net.js's handleConnectionLost): the single link to the
// host died. The host's per-guest equivalent is onGuestConnectionClosed
// below.
window.onNetConnectionClosed = function(){
  // A drop while in the PRE-MATCH LOBBY (before mpMatchStarted) is its own
  // case — the mid-match disconnect overlay/reconnect below assumes a live
  // match. Handle the lobby here and return.
  if (window.__mpSession.inLobby) {
    // Host left/closed the lobby: there's no match to resume, so tell the
    // guest plainly instead of silently spinning. Drop the lobby, show the
    // status, and offer a manual Retry (in case it was a transient blip and
    // the host is still up) — onNetConnectionOpen re-enters the lobby if a
    // reconnect lands.
    window.__mpSession.inLobby = false;
    lobbyState = null;
    if (typeof showMenuPanel === 'function') showMenuPanel('main');
    let menu = document.getElementById('tutorial');
    if (menu) menu.style.display = 'flex';
    showMpStatus('The host has disconnected.');
    let retryBtn = document.getElementById('mp-retry-btn');
    if (retryBtn) retryBtn.style.display = '';
    if (typeof showMsg === 'function') showMsg('Host disconnected');
    return;
  }
  // A drop before the match ever started, or after it's already over, is
  // someone else's flow (the pre-game "waiting to join" status panel, or
  // just a post-game teardown) — not this mid-match pause/reconnect one.
  if (!mpMatchStarted || gameOver) return;
  disconnectedPause = true;
  recomputeGamePaused();
  showDisconnectOverlay('Connection to host lost. Attempting to reconnect…');
  attemptReconnect();
};

// HOST-only (js/net.js's handleGuestConnectionLost): ONE guest's
// connection died; its registry record (token → seat) survives so the
// same browser can reconnect into its seat.
window.onGuestConnectionClosed = function(seat){
  // A dropped guest's open menu must not keep everyone else paused after
  // it's gone — the disconnect pause takes over as the reason.
  if (guestMenuOpenBySeat.get(seat)) {
    guestMenuOpenBySeat.delete(seat);
    hostBroadcastPauseState();
  }
  if (window.__mpSession.inLobby) {
    // Guest left the lobby: free their seat, disable Start (js/lobby.js).
    // The host's Peer stays alive, so anyone reopening the link re-enters
    // onNetConnectionOpen and gets re-seated.
    if (typeof onGuestLeftLobby === 'function') onGuestLeftLobby(seat);
    return;
  }
  if (!mpMatchStarted || gameOver) return;
  hostBroadcastDcPause();
};

// Guest-only: retries joinSession() against the same host peer id every
// few seconds until it succeeds (onNetConnectionOpen above clears the
// timer and resumes the match) or the match ends some other way. The host
// doesn't need an equivalent loop — its own Peer stays alive the whole
// time, passively waiting on the `connection` listener already registered
// in hostSession() (js/net.js), same as it did for the original join.
function attemptReconnect(){
  if (netConnected || gameOver) return;
  joinSession(window.__mpSession.hostPeerId).catch(() => {
    mpReconnectTimer = setTimeout(attemptReconnect, 3000);
  });
}

// gamePaused has three independent reasons it can be true, any of which
// can be active at once (e.g. this client opens its own local menu WHILE
// the connection is also mid-reconnect): this client's own #tutorial menu
// being open, the OTHER peer's menu being open (either direction — see
// the message handler below), and a disconnect/reconnect in progress. A
// bug this exact shape already bit once (in the deleted snapshot-sync
// code — a different unconditional overwrite): any
// code path that just sets `gamePaused = false` directly, without
// checking whether some OTHER reason is still active, will incorrectly
// resume the game out from under a menu/overlay that's still visibly
// showing. recomputeGamePaused() is the one place that ever decides the
// final value — every handler below only ever touches its own reason flag
// and then calls this, never `gamePaused` directly (except the hard reset
// in startGame()).
let localMenuOpen = false;
let remoteMenuOpen = false;
let disconnectedPause = false;
function recomputeGamePaused(){
  gamePaused = localMenuOpen || remoteMenuOpen || disconnectedPause;
}

// ANY player opening their menu pauses everyone — a player stepping away
// to check settings must not leave the others free to keep building/
// fighting in real time. The HOST is the pause authority in the star:
// guests report their own menu state ('guest-menu'), the host aggregates
// (its own menu + every guest's) and broadcasts one 'match-pause' verdict.
// The channel is reliable-ordered, so a lost open:false can only mean a
// disconnect, which has its own overlay/pause path.
let guestMenuOpenBySeat = new Map(); // host-side: seat -> that guest's menu is open

// Called from toggleMenu() — reports this client's own menu open/close.
function broadcastMenuState(open){
  if (!netConnected) return;
  if (netRole === 'host') hostBroadcastPauseState();
  else if (netRole === 'guest') sendToHost({ type: 'guest-menu', open });
}

// Host: recompute the aggregate menu-pause and tell every guest. byTeam
// names the (first) responsible player so each guest can label the
// overlay — or skip it when the culprit is itself.
function hostBroadcastPauseState(){
  if (netRole !== 'host') return;
  let byTeam = localMenuOpen ? 0 : null;
  if (byTeam == null) {
    for (const [seat, open] of guestMenuOpenBySeat) { if (open) { byTeam = seat; break; } }
  }
  if (mpMatchStarted) {
    broadcastToGuests({ type: 'match-pause', kind: 'menu', paused: byTeam != null, byTeam });
  }
  // The host's own "remote" reason is any GUEST's menu being open.
  let anyGuest = false;
  for (const [, open] of guestMenuOpenBySeat) { if (open) { anyGuest = true; break; } }
  setRemoteMenuOpen(anyGuest, byTeam);
}

function pauseCulpritName(byTeam){
  if (byTeam === 0) return 'The host';
  let n = (typeof teamNames !== 'undefined' && teamNames && teamNames[byTeam]) || null;
  return n || 'Another player';
}

function setRemoteMenuOpen(open, byTeam){
  remoteMenuOpen = !!open;
  if (remoteMenuOpen) {
    showMpOverlay('Game Paused', pauseCulpritName(byTeam) + ' has paused the game.', false);
  } else if (!disconnectedPause) {
    // Don't blow away a disconnect overlay that's showing for an unrelated
    // reason — recomputeGamePaused() below still gets the pause state
    // right either way, this is purely about which message stays on screen.
    hideMpOverlay();
  }
  recomputeGamePaused();
}

// Which lobby seat (== sim team id) the host assigned this guest. Arrives
// in the 'welcome' reply to our hello; the authoritative values for a
// MATCH come later in lockstep-start/lockstep-resume (yourTeam), but the
// lobby needs the seat immediately to know which roster row is "mine".
onNetMessage((msg) => {
  if (netRole !== 'guest') return;
  if (msg.type === 'welcome') {
    window.__mpSession.mySeat = msg.seat;
  } else if (msg.type === 'join-denied') {
    // The host turned this connection away (game full, match in progress,
    // or we were kicked). Stop any reconnect loop — retrying would just be
    // denied again — and say why.
    if (mpReconnectTimer) { clearTimeout(mpReconnectTimer); mpReconnectTimer = null; }
    let why = msg.reason === 'kicked' ? 'You were removed from this game by the host.'
      : msg.reason === 'in-progress' ? 'This match is already in progress.'
      : 'This game is full.';
    window.__mpSession.inLobby = false;
    lobbyState = null;
    let menu = document.getElementById('tutorial');
    if (menu) menu.style.display = 'flex';
    if (typeof showMenuPanel === 'function') showMenuPanel('main');
    hideDisconnectOverlay();
    showMpStatus(why);
  }
});

// Host-side seating rule for a hello whose token doesn't match any
// existing record (js/net.js's hostHandleHello handles exact-token
// reconnects before consulting this). Mid-match, unknown tokens are never
// seated — no takeover heuristics. Pre-match, hand out the guest seat;
// a stale disconnected record (guest left the lobby) is evicted first.
window.assignGuestSeat = function(msg){
  // Mid-match (and while recovering one) only an exact identity rebind may
  // enter — handled before this hook is consulted (js/net.js). No
  // seat-guessing heuristics.
  if (mpMatchStarted || window.__mpSession.awaitingStateFromGuest) return null;
  if (typeof lobbyState !== 'undefined' && lobbyState) {
    return typeof lobbyNextFreeSeat === 'function' ? lobbyNextFreeSeat(msg) : null;
  }
  // Pre-lobby (no lobbyState yet): first guest gets seat 1. When hosting
  // from a loaded MP save the registry is pre-seeded with that save's
  // seats — those humans rebind by token above; an unknown identity may
  // only take seat 1 if the save didn't reserve it.
  let old = netGuestBySeat(1);
  if (old && old.connected) return null;
  if (old && old.token && mpHostingFromExistingGame) return null; // reserved for the original guest
  if (old) netGuests.delete(1);
  return 1;
};

onNetMessage((msg) => {
  if (msg.type === 'proto' && msg.v !== NET_PROTOCOL_VERSION) {
    console.error('Protocol mismatch: peer is v' + msg.v + ', this client is v' + NET_PROTOCOL_VERSION);
    showMpOverlay('Version Mismatch',
      'Your game version differs from your opponent’s — the match cannot run safely. '
      + 'Both players should hard-refresh the page (Ctrl/Cmd+Shift+R) and reconnect.', false);
    return;
  }
});

// Menu-pause plumbing: guests report their own menu; the host aggregates
// and broadcasts the verdict (hostBroadcastPauseState above).
onNetMessage((msg, src) => {
  if (msg.type === 'guest-menu' && netRole === 'host') {
    if (!src || src.seat == null) return;
    guestMenuOpenBySeat.set(src.seat, !!msg.open);
    hostBroadcastPauseState();
  } else if (msg.type === 'match-pause' && netRole === 'guest' && msg.kind === 'menu') {
    // Skip the "paused by X" flag when X is this very tab — its own
    // localMenuOpen already pauses it (and the menu is on screen).
    setRemoteMenuOpen(msg.paused && msg.byTeam !== myTeam, msg.byTeam);
  } else if (msg.type === 'match-pause' && netRole === 'guest' && msg.kind === 'dc') {
    // The host's disconnect-pause verdict: another guest dropped (or came
    // back). Guests can't see each other's connectivity — mirror it.
    disconnectedPause = !!msg.paused;
    if (msg.paused) {
      showDisconnectOverlay('Waiting for ' + ((msg.waiting || []).join(', ') || 'a player') + ' to reconnect…');
    } else if (!remoteMenuOpen) {
      hideDisconnectOverlay();
    }
    recomputeGamePaused();
  }
});

// Guest entry point: called once at boot (see the bottom of this file) if
// the page was opened via a host's shareable ?join= link. Skips the normal
// single-player Start flow — the guest is about to receive the host's
// whole world over the network (Phase 2/net-sync.js), not generate its own
// via init()'s local genMap()/STARTS spawn.
function enterGuestJoinMode(hostPeerId){
  // No team/seat hardcoding here: the seat arrives in the host's 'welcome'
  // (lobby identity) and the authoritative team in lockstep-start/-resume's
  // yourTeam (js/lockstep.js).
  window.__mpSession.hostPeerId = hostPeerId; // remembered for attemptReconnect() above
  let menu = document.getElementById('tutorial');
  // Hide the normal setup UI (difficulty/map size/start button etc.) —
  // none of it applies to a guest, who inherits the host's match settings.
  if (menu) {
    menu.querySelectorAll('.setup-grid, .menu-button-container, #save-load-row, #mp-row, .menu-divider')
      .forEach(el => { el.style.display = 'none'; });
  }
  attemptGuestJoin();
  updateUiSwitchVisibility(); // netRole is 'guest' from here — hide the page-switch link
}

// Host entry point for a ?host=<id> resume link (see onHostClicked's
// history.replaceState): the previous host page died mid-match, and the
// only live copy of the world is the still-connected guest's mirror.
// Reclaim the SAME peer id (the guest's attemptReconnect loop is retrying
// it every 3s and nothing else), then onNetConnectionOpen's
// awaitingStateFromGuest branch asks the guest for the world.
//
// The id usually isn't free immediately — the signaling server takes a few
// seconds to notice the old session died and release it — so this retries
// strict hostSession() (js/net.js) rather than accepting its usual
// random-id fallback, which would reclaim NOTHING (the guest would retry a
// dead id forever).
function enterHostResumeMode(peerId){
  window.__mpSession.awaitingStateFromGuest = true;
  // This crashed page has no save file — the persisted session map
  // (js/net.js persistMpSessionMap, written while the match ran) is what
  // knows which token owns which seat. Seed the registry from it so each
  // reconnecting guest's hello rebinds to its exact old seat.
  try {
    let m = JSON.parse(localStorage.getItem('aoeMpSessionMap') || 'null');
    if (m && m.hostPeerId === peerId && typeof netSeedGuestRecords === 'function') {
      netSeedGuestRecords(m.seatTokens);
    }
  } catch (e) {}
  setTimeout(updateUiSwitchVisibility, 0); // after netRole set by hostSession below
  let menu = document.getElementById('tutorial');
  if (menu) {
    menu.querySelectorAll('.setup-grid, .menu-button-container, #save-load-row, #mp-row, #misc-row, .menu-divider')
      .forEach(el => { el.style.display = 'none'; });
  }
  showMpStatus('Reconnecting to your match…');
  let attempts = 0;
  let tryHost = () => {
    hostSession(peerId, true).then(() => {
      showMpStatus('Waiting for your opponent to reconnect…');
    }).catch(err => {
      attempts++;
      if (err && err.type === 'unavailable-id' && attempts < 10) {
        showMpStatus('Reclaiming your session… (attempt ' + attempts + ')');
        setTimeout(tryHost, 3000);
      } else {
        console.error('Host resume failed:', err);
        window.__mpSession.awaitingStateFromGuest = false;
        showMpStatus('Could not resume this session — it may have expired. Load a save file and host again, or start fresh.');
      }
    });
  };
  tryHost();
}

// The guest's initial connection attempt, re-runnable via the Retry button
// — the old inline version left "Could not connect" as a dead end with a
// page refresh as the only recourse.
function attemptGuestJoin(){
  let retryBtn = document.getElementById('mp-retry-btn');
  if (retryBtn) retryBtn.style.display = 'none';
  showMpStatus('Connecting to host…');
  joinSession(window.__mpSession.hostPeerId).catch(err => {
    console.error('Failed to join:', err);
    showMpStatus('Could not connect — the link may be invalid or expired.');
    if (retryBtn) retryBtn.style.display = '';
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
  let mpRow = document.getElementById('mp-row');
  let saveBtn = document.getElementById('save-game-btn');
  let loadBtn = document.getElementById('load-game-btn');
  if (!menu) return;
  window.menuMode = mode;

  // The VICTORY/DEFEAT banner block only exists in 'gameover' mode.
  let banner = document.getElementById('game-over-banner');
  if (banner) {
    banner.style.display = mode === 'gameover' ? '' : 'none';
    if (mode === 'gameover') {
      let iWon = didIWin();
      let title = document.getElementById('game-over-title');
      let sub = document.getElementById('game-over-sub');
      if (title) {
        title.textContent = iWon ? '🏆 Victory!' : '💀 Defeat';
        title.className = iWon ? 'game-over-victory' : 'game-over-defeat';
      }
      if (sub) sub.textContent = iWon
        ? 'Your empire has triumphed!'
        : 'Your empire falls to dust.';
    }
  }

  if (mode === 'gameover') {
    // This menu is NOT auto-opened on game over anymore (the end screen is the
    // canvas banner + standalone "See Map" button, js/init.js gameLoop) — it
    // only appears if the player clicks the ☰ button. When they do, it's the
    // full post-game menu: Play Again (single-player / dead MP), or Rematch for
    // a live-MP host (a fresh match over the same connection, see
    // onStartClicked); the guest gets no button (its menu closes by itself when
    // the rematch's 'lockstep-start' arrives), plus Load / Host as usual.
    let liveMp = !!netRole && netConnected;
    if (difficultyRow) difficultyRow.style.display = '';
    if (startBtn) {
      startBtn.style.display = (liveMp && netRole === 'guest') ? 'none' : '';
      startBtn.textContent = (liveMp && netRole === 'host') ? '🔄 Rematch' : '🔄 Play Again';
    }
    if (liveMp && netRole === 'guest') {
      let sub = document.getElementById('game-over-sub');
      if (sub) sub.textContent = 'Waiting for the host to start a rematch…';
    }
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (loadBtn) loadBtn.style.display = liveMp ? 'none' : '';
    if (mpRow) mpRow.style.display = netRole ? 'none' : '';
    if (saveBtn) saveBtn.style.display = 'none';
  } else if (mode === 'ingame') {
    if (difficultyRow) difficultyRow.style.display = 'none';
    // Restart and Load are both dropped from the mid-game menu entirely —
    // keeping things simple: reloading the browser tab already restarts a
    // fresh match, and Load mid-game is the same "why would you overwrite
    // your current progress with an old file" awkwardness Restart has.
    // Resume/Save/Help are the only mid-game actions that make sense.
    if (startBtn) startBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = 'flex';
    if (loadBtn) loadBtn.style.display = 'none';
    // "Host Multiplayer Game" reads as "start a fresh match to host" — but
    // mid-game it would actually take your CURRENT progress online (see
    // mpHostingFromExistingGame in onHostClicked()), which isn't what the
    // label promises and is a confusing thing to stumble into via the
    // pause menu. That capability is still reachable, just not through
    // this button: loading a save tagged wasMultiplayerGame triggers it
    // automatically (see applySavedGame() in js/save.js) without the user
    // ever needing to click Host themselves. A live MP session already
    // hides this row too (restoreMenuForMatch()) — this just extends the
    // same idea to plain single-player's mid-game menu.
    if (mpRow) mpRow.style.display = 'none';
    // Save is hidden by default in the HTML (no match exists on the
    // pristine pre-game screen) — this is the general "a match now exists"
    // signal for ANY mid-game pause menu, single-player included, not just
    // the MP-specific restoreMenuForMatch() path.
    if (saveBtn) saveBtn.style.display = '';
  } else if (mode === 'restart-ready') {
    if (difficultyRow) difficultyRow.style.display = '';
    if (startBtn) { startBtn.style.display = ''; startBtn.textContent = 'Start'; }
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (loadBtn) loadBtn.style.display = '';
    if (mpRow) mpRow.style.display = '';
    if (saveBtn) saveBtn.style.display = 'none';
  } else {
    if (difficultyRow) difficultyRow.style.display = '';
    if (startBtn) { startBtn.style.display = ''; startBtn.textContent = 'Start'; }
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (loadBtn) loadBtn.style.display = '';
    if (mpRow) mpRow.style.display = '';
    if (saveBtn) saveBtn.style.display = 'none';
  }
  updateUiSwitchVisibility();
  scheduleMenuRescale();
}

function openRestartMenu(){
  let menu = document.getElementById('tutorial');
  if (!menu) return;
  menu.style.display = 'flex';
  localMenuOpen = true;
  recomputeGamePaused();
  showMenuPanel('main');
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
  bumpSimGen(); // tick rewound to 0 — invalidate every registered sim cache (js/core.js)
  scoutedByMe.clear(); // fresh map, fresh fog memory — see js/core.js
  window.__mpSession.cameraCentered = false;
  window.__mpSession.hostJustLoadedSave = false;
  window.__mpSession.bottomHeightSet = false;
  window.__mpSession.guestInitialMenuHidden = false;
  // loadedHostPeerId/hostPeerId deliberately NOT reset here — they're
  // consumed/read across the actual connection lifecycle (onHostClicked,
  // attemptReconnect), which spans restartGame() calls rather than being
  // scoped to one "match" the way the above per-match state is.
  clearCommandQueue(); // js/commands.js — stale scheduled commands must never fire into a fresh match
  // Fresh id sequences: entity ids are part of the deterministic sim (they
  // break distance-sort ties, key spatial maps, and feed the checksum) so
  // every peer must allocate the SAME ids for the same world. Without this
  // reset, a page that ran an earlier world (the script-load init(), a
  // finished match) starts the new one at a different counter than a page
  // that didn't — e.g. a ?join= guest, which skips the load-time init().
  nextId = 1;
  nextProjectileId = 1;
  resetTeamVision(); // sim visibility grids reset with the world — see js/core.js
  treeFellTicks.clear(); // fresh map, fresh tree-fall animation state — see js/core.js
  corpseImpactFxDone.clear();
  workSwingCycles.clear();
  buildingFxTick.clear();

  // Reset resources to defaults — every team (single-player AI, or real MP
  // opponents) gets the same start, not a handicap; AI difficulty is tuned
  // via gather rates/behavior (js/ai.js), not a lower resource floor.
  resources = freshTeamResources();
  marketPrices = freshMarketPrices(); // global commodity exchange back to defaults (js/core.js)
  // Controllers for the two shapes a fresh world can take today (SP human
  // vs AI, or 1v1 lockstep human vs human), derived from netRole at
  // world-build time. A future match-setup UI replaces this derivation
  // with explicit slot choices — everything downstream already reads
  // teamControllers, not netRole.
  teamControllers = defaultControllers(netRole != null);
  resetAIStates();      // fresh per-team AI plan state (js/core.js)
  resetLastTeamHit();   // fresh per-team "last hit taken" record (js/core.js)
  teamAlliance = defaultAlliances(netRole != null); // [0,0,1,1] for SP 2v2, else identity (js/core.js)
  resetDefeatedTeams();
  resetTeamAge(); // everyone starts in the Dark Age (js/core.js)
  // Cosmetic seat labels/colors back to defaults (identity palette, no names).
  // Like teamControllers above, the lobby/lockstep paths re-apply the agreed
  // names+colors AFTER restartGame — see hostStartLockstepMatch / the
  // lockstep-start handler (js/lockstep.js).
  resetTeamColorMap();
  resetTeamNames();

  // Reset UI cache to prevent stale HUD panels on restart
  window.lastUIState = null;
  window.lastSelListKey = null;
  window.lastSelGridDetails = null;
  window.lastSelKey = null;
  window.gameOverMenuShown = false; // re-arm the game-over "See Map" reveal (gameLoop)
  window.playedGameOverSound = false;
  window.__gameOverBannerDismissed = false; // fresh match → banner armed again
  window.seeMapMode = false; // exit the finished-map review mode
  { let sm = document.getElementById('see-map-btn'); if (sm) sm.style.display = 'none'; }

  // Re-generate map and spawn starts
  init();
  
  startGame(difficulty);
}

function toggleCameraFollow(){
  if(selected.length===0 || selected[0].type!=='unit' || selected[0].team!==myTeam)return;
  let id=selected[0].id;
  window.cameraFollowId = (window.cameraFollowId===id) ? null : id;
  updateUI();
}

function toggleHelp(){
  let o=document.getElementById('help-overlay');
  if(o)o.style.display=(o.style.display==='none'||o.style.display==='')?'flex':'none';
}

// Game-over "See Map": dismiss the VICTORY/DEFEAT banner and let the player pan
// over the finished, fully-revealed map (AoE2-style). No menu is involved.
//   - window.seeMapMode re-enables the camera controls (pan/zoom/minimap/arrow
//     keys) that are otherwise disabled once gameOver; command input stays off.
//   - fog is turned off and every tile revealed so the whole map is visible.
function seeMap(){
  window.__gameOverBannerDismissed = true;
  window.seeMapMode = true;
  window.fogDisabled = true;
  // Reveal every tile now (updateFog() no-ops while fogDisabled, so flip the
  // grid directly — 2 = fully visible).
  if (typeof fog !== 'undefined' && fog && fog.length) {
    for (let y = 0; y < fog.length; y++) {
      let row = fog[y];
      for (let x = 0; x < row.length; x++) row[x] = 2;
    }
  }
  // Enemy buildings render only once "scouted" (scoutedByMe, js/render.js) even
  // under revealed fog — so mark every building scouted to actually show them.
  if (typeof scoutedByMe !== 'undefined' && scoutedByMe && typeof entities !== 'undefined') {
    entities.forEach(e => { if (e.type === 'building') scoutedByMe.add(e.id); });
  }
  // buildingFogLevel() caches per-building fog in _bflMemo, normally cleared by
  // updateFog() — which doesn't run post-game. Clear it so the fog we just
  // revealed above is actually seen (otherwise buildings keep their stale
  // fog-level-0 and stay hidden).
  if (typeof invalidateBuildingFogMemo === 'function') invalidateBuildingFogMemo();
  let btn = document.getElementById('see-map-btn');
  if (btn) btn.style.display = 'none';
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
      localMenuOpen = true;
      recomputeGamePaused();
      showMenuPanel('main'); // the menu always opens on the main panel
      let inMatch = entities.length > 0 && gameStarted;
      applyMenuMode((inMatch && !gameOver) ? 'ingame'
        : (gameOver && entities.length > 0) ? 'gameover' : 'prestart');
      // Pause the OTHER peer too, with an explanatory overlay — otherwise
      // the match keeps running live on their screen (and, for the guest
      // opening their own menu, the host keeps building/training/fighting
      // in real time while the guest sits frozen and unable to respond —
      // a one-sided advantage neither direction should get away with).
      broadcastMenuState(true);
    } else {
      menu.style.display = 'none';
      // Unpause BEFORE applying audio settings: playAmbientChord skips
      // scheduling while gamePaused, so starting music against a still-paused
      // game would silently defer it to the next phrase (~6s later).
      // recomputeGamePaused() (not a direct `gamePaused = false`) — stays
      // paused if remoteMenuOpen or disconnectedPause is also active,
      // instead of blindly resuming out from under either.
      localMenuOpen = false;
      recomputeGamePaused();
      broadcastMenuState(false);
      applyAudioSettings();
      // Apply the other menu settings mid-match too (map size is the one
      // exception — it needs a map regen, so it only takes effect on Restart).
      applyGameSettings();
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

// The on-screen bandwidth stats box was removed, but the underlying
// counters (netBytesSent/netBytesReceived, js/net.js) still accumulate —
// handy from the console when debugging sync traffic.

// requestAnimationFrame stops entirely in a hidden tab — fine in single-
// player (the game just pauses with you), but a HOST alt-tabbing away used
// to halt simulation and all sync broadcasts, leaving the guest frozen
// staring at a live-but-silent connection (and at risk of a false
// heartbeat-timeout trip). This interval keeps the host's simulation
// running while hidden. Background setInterval is throttled to ~1/sec —
// pages holding an active WebRTC connection are exempt from Chrome's far
// harsher intensive throttling — so each firing may need to cover a full
// second of game time: the catch-up clamp here is 1500ms, not gameLoop's
// 250ms (dozens of ticks per firing is cheap; rendering, the actual
// expensive part, stays skipped while hidden). Only ever advances
// `lastTime` itself, so when the tab comes back, gameLoop's own elapsed
// math resumes cleanly with no double-counted time.
setInterval(() => {
  if (!document.hidden || netRole !== 'host' || !netConnected) return;
  if (!gameStarted || gamePaused || gameOver) return;
  let now = performance.now();
  let elapsed = Math.min(now - lastTime, 1500);
  lastTime = now;
  accumulator += elapsed;
  // Mirror gameLoop's lockstep hooks exactly: without the surcharge the
  // hidden host free-ran unbounded ahead of the guest (pacing/hard-stop
  // never enforced), the snapshot ring froze at pre-hidden ticks (guest
  // commands then forced fatal too-old rollbacks), and progress reports
  // stopped. This interval predates lockstep — it was written for the
  // legacy snapshot-sync broadcasts.
  while (accumulator >= timeStep) {
    if (lockstepEnabled()) {
      let surcharge = lockstepTickSurcharge();
      if (surcharge === Infinity) { accumulator = Math.min(accumulator, timeStep * 4); break; }
      if (accumulator < timeStep + surcharge) break;
      accumulator -= surcharge;
    }
    update();
    accumulator -= timeStep;
    if (lockstepEnabled()) lockstepTakeSnapshot();
  }
  if (lockstepEnabled()) lockstepReport();
}, 250);

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
    if (netRole !== 'guest' || lockstepEnabled()) {
      accumulator += elapsed;
      while (accumulator >= timeStep) {
        // Lockstep runs FREELY — late peer commands rewind-and-resim
        // instead of the sim ever waiting (js/lockstep.js). The surcharge
        // is the only pacing coupling: ~20% slower when far ahead of the
        // peer's reports, a stop only if the peer looks wedged (the net
        // heartbeat surfaces that as a disconnect moments later).
        if (lockstepEnabled()) {
          let surcharge = lockstepTickSurcharge();
          if (surcharge === Infinity) { accumulator = Math.min(accumulator, timeStep * 4); break; }
          if (accumulator < timeStep + surcharge) break;
          accumulator -= surcharge;
        }
        update();
        accumulator -= timeStep;
        if (lockstepEnabled()) lockstepTakeSnapshot();
      }
      if (lockstepEnabled()) lockstepReport();
    }
    // Visual-only effects (particle physics, building smoke/fire) run at
    // frame cadence for BOTH roles, outside the deterministic sim tick —
    // see updateCosmetics (js/loop.js).
    updateCosmetics(elapsed);
  }
  // 30fps render cap on mobile: profiling shows render cost is ~65% native
  // canvas fill/stroke rasterization of per-unit vector art — halving the
  // frame rate halves it. Original AoE2 ran its whole loop at ~20fps and
  // its sprites animate at ~10-15 frames/cycle, so 30 is still smoother
  // than the reference. LOCAL pacing only: the sim keeps its full tick
  // rate (and lockstep gating/watermarks are frame-rate independent).
  window.__lastRenderAt = window.__lastRenderAt || 0;
  const RENDER_MIN_MS = isMobile ? 1000 / 30 - 2 : 0; // -2ms slack so a 33.4ms rAF gap doesn't drop to 20fps
  if (now - window.__lastRenderAt >= RENDER_MIN_MS) {
    window.__lastRenderAt = now;
    render();
    updateUI();
  }
  if(gameOver){
    let iWon = didIWin();
    if (!window.playedGameOverSound) {
      window.playedGameOverSound = true;
      if (window.stopAmbientMusic) window.stopAmbientMusic(); // cut ambient so the ending piece stands alone
      if (window.startGameOverMusic) window.startGameOverMusic(iWon);
    }
    // The whole end screen is the VICTORY/DEFEAT banner plus a standalone
    // "See Map" button under it — NO menu is opened over the result (and so no
    // rematch/play-again). One-shot reveal of the button (reset in
    // restartGame). See Map (seeMap()) dismisses the banner to show the map.
    if (!window.gameOverMenuShown) {
      window.gameOverMenuShown = true;
      let sm = document.getElementById('see-map-btn');
      if (sm) sm.style.display = '';
    }
    if (!window.__gameOverBannerDismissed) {
      X.fillStyle='rgba(0,0,0,0.65)';X.fillRect(0,0,W,window.innerHeight);
      let cy=topH+H/2;
      // Gold banner background
      X.fillStyle='rgba(40,20,5,0.85)';
      X.fillRect(0,cy-80,W,140);
      X.strokeStyle='#bfa054';X.lineWidth=3;
      X.beginPath();X.moveTo(0,cy-80);X.lineTo(W,cy-80);X.stroke();
      X.beginPath();X.moveTo(0,cy+60);X.lineTo(W,cy+60);X.stroke();
      // Main text using Cinzel
      X.fillStyle=iWon?'#ffd700':'#ff4444';X.font="bold 44px 'Cinzel', serif";X.textAlign='center';
      X.shadowColor='rgba(0,0,0,0.8)';X.shadowBlur=6;X.shadowOffsetX=2;X.shadowOffsetY=2;
      X.fillText(iWon?'VICTORY':'DEFEAT',W/2,cy-15);
      // Subtext using Georgia
      X.fillStyle='#ffebad';X.font="italic 16px Georgia, serif";
      X.shadowBlur=3;X.shadowOffsetX=1;X.shadowOffsetY=1;
      X.fillText(iWon?'Your empire has triumphed! The enemy town lies in ruins.':'Your forces have been vanquished. Your empire falls to dust.',W/2,cy+25);
      X.shadowBlur=0;X.shadowOffsetX=0;X.shadowOffsetY=0; // Reset shadow
    }
  }
  requestAnimationFrame(gameLoop);
}

// A guest arriving via a host's ?join= link skips the normal local
// init() entirely — it's about to receive the host's whole world over
// the network instead of generating (and briefly showing) its own.
// ?host=<id> is the HOST's own resume link (written by history.replaceState
// in onHostClicked) — a rehosting page also has no world of its own; it
// recovers the match from the connected guest's live mirror.
let bootParams = (typeof window !== 'undefined' && window.location)
  ? new URLSearchParams(window.location.search) : new URLSearchParams();
let joinHostId = bootParams.get('join');
let resumeHostId = joinHostId ? null : bootParams.get('host');

if (window.__editorMode) {
  // Scenario editor (editor.html): skip the normal init()/menu. The editor
  // boots its blank editable world via enterEditor() at the end of
  // js/editor.js (loaded after this file). gameLoop() below still runs — the
  // editor reuses it, rendering every frame and stepping the sim only when
  // unpaused (Play).
} else if (!joinHostId) {
  init();
}
gameLoop();

if (typeof window !== 'undefined' && window.location && window.location.search.includes('autostart')) {
  setMapSize('medium');
  window.fogDisabled = true;
  restartGame('standard');
}

// ?scenario=<url> — load a hand-authored / editor-exported scenario JSON
// (js/scenario.js) in place of the default world, for visual testing. Fog off
// so the whole authored map is visible. No-op without the param.
if (typeof window !== 'undefined' && window.location && new URLSearchParams(window.location.search).get('scenario')) {
  window.fogDisabled = true;
  maybeLoadScenarioFromURL();
}

if (joinHostId) {
  enterGuestJoinMode(joinHostId);
} else if (resumeHostId) {
  enterHostResumeMode(resumeHostId);
}

// The "Switch to Classic/Mobile UI" footer link on the main menu panel —
// point it at the sibling variant, CARRYING the current query string, so a
// guest who opened a ?join= link (or a host resuming via ?host=) lands in
// the other skin still connected to the same match flow.
(function wireUiSwitchLink(){
  let link = document.getElementById('ui-switch-link');
  if (!link) return;
  let target = location.pathname.endsWith('classic.html') ? 'index.html' : 'classic.html';
  link.href = target + location.search;
  // Initial visibility (audience + menu state) — nothing else evaluates it
  // until the first menu-state change.
  updateUiSwitchVisibility();
})();
