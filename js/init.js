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
        if(sp)createUnit('sheep',sp.x,sp.y,GAIA_TEAM);
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
    let bear=createUnit('bear',x,y,GAIA_TEAM);
    // Den anchor: the bear leashes back here after a chase (see logic.js)
    bear.homeX=x; bear.homeY=y;
    placed++;
  }
}

function startGame(difficulty){
  aiDifficulty=AI_LEVELS[difficulty]?difficulty:'standard';
  gameStarted=true;
  gamePaused=false;
  // A genuine fresh start — no other pause reason should carry over from
  // whatever came before (see recomputeGamePaused()/the flags it reads,
  // further down this file).
  localMenuOpen = false;
  remoteMenuOpen = false;
  disconnectedPause = false;
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

// Non-audio settings, same live-apply-and-persist idea as
// applyAudioSettings above. Speed and difficulty take effect immediately
// (both are safe to change mid-match); map size only matters at the next
// restart, but its choice is persisted here all the same. A guest never
// applies speed locally — GAME_SPEED is host-authoritative and arrives via
// sync (js/net-sync.js); writing it here would just fight the next sync.
function applyGameSettings(){
  let speedSel = document.querySelector('input[name="gamespeed"]:checked');
  if (speedSel && netRole !== 'guest') setGameSpeed(parseFloat(speedSel.value));
  let diffSel = document.querySelector('input[name="difficulty"]:checked');
  if (diffSel && AI_LEVELS[diffSel.value]) aiDifficulty = diffSel.value;
  let sizeSel = document.querySelector('input[name="mapsize"]:checked');
  try {
    if (diffSel) localStorage.setItem('aoeDifficulty', diffSel.value);
    if (sizeSel) localStorage.setItem('aoeMapSize', sizeSel.value);
    if (speedSel) localStorage.setItem('aoeGameSpeed', speedSel.value);
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
    [['aoeDifficulty','difficulty'], ['aoeMapSize','mapsize'], ['aoeGameSpeed','gamespeed']]
      .forEach(([key, name]) => {
        let v = localStorage.getItem(key);
        if (!v) return;
        let el = document.querySelector('input[name="'+name+'"][value="'+v+'"]');
        if (el) el.checked = true;
      });
  } catch (e) {}
})();

// ---- Two-level menu: 'main' (big actions) vs 'options' (settings grid) ----
// Orthogonal to applyMenuMode()'s menuMode — menuMode decides WHICH actions
// are visible for the current game state; menuPanel decides which of the
// two panels is showing. Every path that opens the menu resets to 'main'.
function showMenuPanel(which){
  let main = document.getElementById('menu-panel-main');
  let opts = document.getElementById('menu-panel-options');
  if (main) main.style.display = which === 'main' ? '' : 'none';
  if (opts) opts.style.display = which === 'options' ? '' : 'none';
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
  // "Play Again" from a finished multiplayer match starts a fresh LOCAL
  // game — tear the dead session down first so netRole/myTeam don't leak
  // multiplayer behavior (guest never simulating, host broadcasting syncs)
  // into the new single-player match.
  if (netRole && gameOver) leaveMpSession();
  let selected = document.querySelector('input[name="difficulty"]:checked');
  let diff = selected ? selected.value : 'standard';
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
  // pre-game screen) — now that one genuinely does, show it back.
  let saveBtn = document.getElementById('save-game-btn');
  if (saveBtn) saveBtn.style.display = '';
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

  hostSession(desiredPeerId).then(peerId => {
    // Cancelled while the signaling server was still assigning an id
    // (cancelHosting → teardownNet nulls netRole) — don't resurrect the
    // "waiting" panel the user just dismissed, and destroy the
    // just-created peer (hostSession assigned it to netPeer in finish(),
    // AFTER teardownNet already ran) so no one can still join it.
    if (netRole !== 'host') {
      if (netPeer) { try { netPeer.destroy(); } catch (e) {} netPeer = null; }
      return;
    }
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

// Fully leave multiplayer: transport teardown (teardownNet, js/net.js) plus
// all the session-level state that lives HERE rather than in net.js — the
// reconnect retry timer especially: left armed, it would re-join the old
// host seconds after the user deliberately walked away.
function leaveMpSession(){
  if (mpReconnectTimer) { clearTimeout(mpReconnectTimer); mpReconnectTimer = null; }
  teardownNet();
  myTeam = 0;
  mpMatchStarted = false;
  mpHostingFromExistingGame = false;
  disconnectedPause = false;
  window.__mpSession.loadedHostPeerId = null;
  recomputeGamePaused();
}

// Wired to #mp-cancel-btn on the "Waiting for opponent…" screen — before
// this, clicking Host was irreversible: the setup UI was hidden and the
// only way back was a page refresh.
function cancelHosting(){
  let wasMidMatch = mpHostingFromExistingGame;
  leaveMpSession();
  let panel = document.getElementById('mp-status-panel');
  if (panel) panel.style.display = 'none';
  let cancelBtn = document.getElementById('mp-cancel-btn');
  if (cancelBtn) cancelBtn.style.display = 'none';
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
      // Real per-team fog now (updateFog() in js/core.js computes vision
      // for `myTeam` — 0 on the host, 1 on the guest — instead of a
      // hardcoded team 0). Force it on explicitly regardless of whatever
      // a loaded save's own fogDisabled flag was — a live multiplayer
      // match should always use real fog, not a leftover "reveal map"
      // setting from single-player. Only needs setting on the HOST: the
      // guest computes its own fog entirely locally (see js/net-sync.js's
      // applyNetSync), never inherits this flag from a sync payload for
      // that purpose.
      window.fogDisabled = false;
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
        localMenuOpen = false;
        recomputeGamePaused();
      } else {
        showMpStatus('Opponent connected! Starting match…');
        restartGame('standard');
      }
      // Re-show the (now minimal) mid-match menu — see restoreMenuForMatch.
      restoreMenuForMatch();
    } else {
      // Reconnect: resume exactly where the match was paused, don't touch
      // anything else — the guest gets caught back up by the forced full
      // sync above, same mechanism a first join uses. Only clears ITS OWN
      // reason (disconnectedPause) — recomputeGamePaused() below still
      // keeps the game paused if e.g. this host's own menu happens to be
      // open at the exact moment the guest reconnects.
      hideDisconnectOverlay();
      disconnectedPause = false;
      recomputeGamePaused();
    }
    // Re-broadcast this session's actual current localMenuOpen regardless
    // of which branch above ran. A (re)connecting guest's own remoteMenuOpen
    // is a mirrored copy of whatever the LAST 'host-menu' message it ever
    // received said — if the previous host session died (crash/reload)
    // while its menu happened to be open, it can never send the matching
    // open:false (the whole page is gone), permanently stranding that
    // guest paused with remoteMenuOpen stuck true and nothing on screen to
    // explain why (confirmed by an actual test: host reloads from a save
    // while its own menu was open, guest auto-reconnects via the same peer
    // id, and ends up stuck gamePaused with no visible cause). This new
    // session's localMenuOpen is always known-correct at this point (freshly
    // computed above), so just tell the guest what it actually is.
    broadcastToGuest({ type: 'host-menu', open: localMenuOpen });
  } else if (netRole === 'guest') {
    if (!mpMatchStarted) {
      mpMatchStarted = true;
      showMpStatus('Connected! Waiting for game state…');
      // Re-show the (now minimal) mid-match menu — see restoreMenuForMatch.
      // Save Game works for the guest too (their entities/map are a live
      // mirror of the host's), it's everything ELSE that stays hidden.
      restoreMenuForMatch();
    } else {
      hideDisconnectOverlay();
      disconnectedPause = false;
      recomputeGamePaused();
    }
  }
};

window.onNetConnectionClosed = function(){
  // A drop before the match ever started, or after it's already over, is
  // someone else's flow (the pre-game "waiting to join" status panel, or
  // just a post-game teardown) — not this mid-match pause/reconnect one.
  if (!mpMatchStarted || gameOver) return;
  disconnectedPause = true;
  recomputeGamePaused();
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
  joinSession(window.__mpSession.hostPeerId).catch(() => {
    mpReconnectTimer = setTimeout(attemptReconnect, 3000);
  });
}

// gamePaused has three independent reasons it can be true, any of which
// can be active at once (e.g. this client opens its own local menu WHILE
// the connection is also mid-reconnect): this client's own #tutorial menu
// being open, the OTHER peer's menu being open (either direction — see
// the message handler below), and a disconnect/reconnect in progress. A
// bug this exact shape already bit once (see applyNetSync's one-shot
// guard in js/net-sync.js — a different unconditional overwrite): any
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

// Called from toggleMenu() — sends this client's own menu open/close state
// to the other peer, whichever role we are. A no-op if not connected.
function broadcastMenuState(open){
  if (!netConnected) return;
  if (netRole === 'host') broadcastToGuest({ type: 'host-menu', open });
  else if (netRole === 'guest') sendToHost({ type: 'guest-menu', open });
}

// Symmetric both ways — either peer opening their menu pauses (and alerts)
// the other, not just the host. Without this, a guest stepping away to
// check settings would leave the host free to keep building/training/
// fighting in real time while the guest sits frozen, unable to respond —
// exactly the kind of one-sided advantage a 1v1 match shouldn't allow.
// Shared by the one-shot menu messages below AND the per-sync hostMenuOpen
// reconciliation (js/net-sync.js's applyNetSync) — the latter is what
// un-wedges a guest whose 'host-menu' open:false message got lost.
function setRemoteMenuOpen(open){
  remoteMenuOpen = !!open;
  if (remoteMenuOpen) {
    showMpOverlay('Game Paused', netRole === 'guest'
      ? 'The host has paused the game.'
      : 'Your opponent has paused the game.', false);
  } else if (!disconnectedPause) {
    // Don't blow away a disconnect overlay that's showing for an unrelated
    // reason — recomputeGamePaused() below still gets the pause state
    // right either way, this is purely about which message stays on screen.
    hideMpOverlay();
  }
  recomputeGamePaused();
}

onNetMessage((msg) => {
  let isRemoteMenuMsg = (msg.type === 'host-menu' && netRole === 'guest')
    || (msg.type === 'guest-menu' && netRole === 'host');
  if (!isRemoteMenuMsg) return;
  setRemoteMenuOpen(msg.open);
});

// Guest entry point: called once at boot (see the bottom of this file) if
// the page was opened via a host's shareable ?join= link. Skips the normal
// single-player Start flow — the guest is about to receive the host's
// whole world over the network (Phase 2/net-sync.js), not generate its own
// via init()'s local genMap()/STARTS spawn.
function enterGuestJoinMode(hostPeerId){
  myTeam = 1;
  window.__mpSession.hostPeerId = hostPeerId; // remembered for attemptReconnect() above
  let menu = document.getElementById('tutorial');
  // Hide the normal setup UI (difficulty/map size/start button etc.) —
  // none of it applies to a guest, who inherits the host's match settings.
  if (menu) {
    menu.querySelectorAll('.setup-grid, .menu-button-container, #save-load-row, #mp-row, .menu-divider')
      .forEach(el => { el.style.display = 'none'; });
  }
  attemptGuestJoin();
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
    // Same layout as prestart (Play Again = a fresh start), minus the MP
    // host button when a (now finished) MP session is still attached —
    // Play Again there tears the session down and starts local (see
    // onStartClicked); offering "Host" next to it would be confusing.
    if (difficultyRow) difficultyRow.style.display = '';
    if (startBtn) { startBtn.style.display = ''; startBtn.textContent = '🔄 Play Again'; }
    if (resumeBtn) resumeBtn.style.display = 'none';
    if (loadBtn) loadBtn.style.display = '';
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
  scoutedByMe.clear(); // fresh map, fresh fog memory — see js/core.js
  teamExploredEver[0].clear(); // fresh map, stale explored-history memory no longer meaningful — see js/core.js
  teamExploredEver[1].clear();
  hostKnownGuestCam = null; // fresh map, stale camera position no longer meaningful — see js/core.js
  for (let kind in SYNC_BUFFERS) SYNC_BUFFERS[kind].pending = []; // fresh map, stale pending-sync entries no longer meaningful — see js/core.js
  window.__mpSession.cameraCentered = false;
  window.__mpSession.hostJustLoadedSave = false;
  window.__mpSession.bottomHeightSet = false;
  window.__mpSession.guestInitialMenuHidden = false;
  // loadedHostPeerId/hostPeerId deliberately NOT reset here — they're
  // consumed/read across the actual connection lifecycle (onHostClicked,
  // attemptReconnect), which spans restartGame() calls rather than being
  // scoped to one "match" the way the above per-match state is.
  treeFellTicks.clear(); // fresh map, fresh tree-fall animation state — see js/core.js
  corpseImpactFxDone.clear();
  workSwingCycles.clear();
  guestPrevHp.clear();
  guestReactedCorpses.clear();
  guestBuildingFxTick.clear();
  lastSentEntitySnapshot = new Map(); // fresh map, stale entity-diff baseline no longer meaningful — see js/core.js

  // Reset resources to defaults — team 1 (single-player AI, or a real MP
  // guest) gets the same starting resources as team 0, not a handicap; AI
  // difficulty is tuned via gather rates/behavior (js/ai.js), not a lower
  // resource floor.
  resources = [
    {food:200, wood:200, gold:100, stone:200, prepaidFarms:0},
    {food:200, wood:200, gold:100, stone:200, prepaidFarms:0}
  ];
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
  window.gameOverMenuShown = false; // re-arm the game-over auto-menu (gameLoop)
  window.playedGameOverSound = false;

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
  while (accumulator >= timeStep) {
    update();
    accumulator -= timeStep;
  }
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
      advanceGuestParticles(elapsed);
      advanceGuestBuildingEffects();
    }
    reportGuestViewIfChanged(now); // js/net-sync.js — lets the host hand this back on a future reconnect
  }
  render();
  updateUI();
  if(gameOver){
    let iWon = didIWin();
    // Auto-open the menu in 'gameover' mode (Play Again / Load) a moment
    // after the canvas VICTORY/DEFEAT banner lands — previously the banner
    // just sat there and the only way to a new game was finding the ☰
    // button. One-shot (reset in restartGame). Deliberately NOT
    // broadcastMenuState(true): the opponent hits gameOver too and gets
    // their own menu; flashing a "Game Paused" overlay over their result
    // screen would be wrong (and there's nothing left to pause).
    if (!window.gameOverMenuShown) {
      window.gameOverMenuShown = true;
      setTimeout(() => {
        if (!gameOver) return;      // already restarted meanwhile
        if (localMenuOpen) return;  // user beat us to the menu
        let menu = document.getElementById('tutorial');
        if (!menu) return;
        menu.style.display = 'flex';
        localMenuOpen = true;
        recomputeGamePaused();
        showMenuPanel('main');
        applyMenuMode('gameover');
      }, 2200);
    }
    if (!window.playedGameOverSound) {
      window.playedGameOverSound = true;
      if (window.stopAmbientMusic) window.stopAmbientMusic(); // cut ambient so the ending piece stands alone
      if (window.startGameOverMusic) window.startGameOverMusic(iWon);
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
    X.fillStyle=iWon?'#ffd700':'#ff4444';X.font="bold 44px 'Cinzel', serif";X.textAlign='center';
    X.shadowColor='rgba(0,0,0,0.8)';X.shadowBlur=6;X.shadowOffsetX=2;X.shadowOffsetY=2;
    X.fillText(iWon?'VICTORY':'DEFEAT',W/2,cy-15);

    // Subtext using Georgia
    X.fillStyle='#ffebad';X.font="italic 16px Georgia, serif";
    X.shadowBlur=3;X.shadowOffsetX=1;X.shadowOffsetY=1;
    X.fillText(iWon?'Your empire has triumphed! The enemy town lies in ruins.':'Your forces have been vanquished. Your empire falls to dust.',W/2,cy+25);
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
