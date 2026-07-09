// ---- MULTIPLAYER: PRE-MATCH LOBBY ("handshake") ----
// Sits between "a guest connects" and "match start". Both players pick a name +
// color, the host owns the settings (map size / speed), both can chat, and the
// host presses Start. Only then does hostStartLockstepMatch() (js/lockstep.js)
// run — the flow used to auto-start the instant the guest connected.
//
// The host does NOT enter the lobby while alone: clicking Host shows the plain
// invite link/QR "waiting for opponent" screen (js/init.js onHostClicked), and
// the lobby appears only once a human guest actually connects. (Playing vs an
// AI stays the single-player menu path — the lobby is strictly two humans.)
//
// HOST-AUTHORITATIVE FULL-SNAPSHOT model (mirrors lockstep-resync): the host
// owns `lobbyState` and rebroadcasts the whole thing on every change; the guest
// holds a mirror and sends REQUESTS the host validates. Wire types (over
// js/net.js's envelope, gated by NET_PROTOCOL_VERSION):
//   {type:'lobby-open',  ...payload}   host->guest: "you're in the lobby now"
//   {type:'lobby-sync',  ...payload}   host->guest: authoritative state changed
//   {type:'lobby-seat',  name, colorIdx, ready}  guest->host: a request
// payload = { seats:[{type,name,colorIdx,ready,present}], mapSize, speed,
//             numTeams }. Chat rides the existing {type:'chat'} (see js/chat.js,
// which routes to the lobby log while inLobby).
//
// Names/colors are COSMETIC — never hashed in simChecksum, never snapshotted
// (js/core.js teamColorMap/teamNames). They cross to the match only inside the
// existing lockstep-start / lockstep-resume messages.

// Available color choices = every entry in the shared palette (js/core.js).
function lobbyPaletteSize(){ return PLAYER_TEAM_COLORS.length; }
const LOBBY_NAME_MAX = 24;

// The host's shareable ?join= link, remembered so a guest leaving the lobby can
// drop the host back onto the "waiting for opponent" screen with the same link.
let lobbyShareLink = null;

// ---- Match modes ----
// Humans are ALWAYS the low team slots — host=team 0, guest=team 1 (the wire
// mapping in js/lockstep.js hardcodes that). AI opponents are teams 2/3. The
// three modes differ only in ALLIANCE, so the controller layout is identical
// ([human,human,ai,ai]) for both 4-team modes:
//   '1v1'         2 teams, host vs guest.
//   'humansVsAi'  4 teams, [0,0,1,1]: {h0,h1} vs {ai2,ai3}.
//   'mixed'       4 teams, [0,1,0,1]: {h0,ai2} vs {h1,ai3}.
function lobbyModeNumTeams(mode){ return mode === '1v1' ? 2 : 4; }
function lobbyAlliancesFor(mode){
  if (mode === 'mixed') return [0, 1, 0, 1];
  if (mode === 'humansVsAi') return [0, 0, 1, 1];
  return [0, 1];
}
function lobbyControllersFor(mode, aiDiff){
  if (mode === '1v1') return [{ type: 'human' }, { type: 'human' }];
  let ai = { type: 'ai', difficulty: aiDiff || 'standard' };
  return [{ type: 'human' }, { type: 'human' }, { type: 'ai', difficulty: aiDiff || 'standard' }, { type: 'ai', difficulty: aiDiff || 'standard' }];
}

// Build the seat array for a mode, preserving the two human seats' chosen
// name/color/ready across a mode switch. Host-only (the guest mirrors seats
// from lobby-sync). AI seats get distinct colors the humans aren't using.
function lobbyBuildSeats(mode, prev){
  let host = (prev && prev[0]) || {};
  let guest = (prev && prev[1]) || {};
  let seats = [
    { type: 'human', name: host.name != null ? host.name : (localPlayerName || '').trim(),
      colorIdx: host.colorIdx != null ? host.colorIdx : 0, ready: true, present: true },
    { type: 'human', name: guest.name || '',
      colorIdx: guest.colorIdx != null ? guest.colorIdx : 1, ready: !!guest.ready,
      present: guest.present !== false },
  ];
  if (lobbyModeNumTeams(mode) === 4) {
    seats.push({ type: 'ai', name: 'Computer', colorIdx: 2, ready: true, present: true });
    seats.push({ type: 'ai', name: 'Computer', colorIdx: 3, ready: true, present: true });
  }
  lobbyReassignAiColors(seats); // resolve any AI/human color collision
  return seats;
}

// Give every AI seat a distinct color the humans aren't using. Humans have
// priority (they pick freely); the AI slide to whatever's free.
function lobbyReassignAiColors(seats){
  let used = new Set();
  seats.forEach(s => { if (s.type === 'human') used.add(s.colorIdx); });
  seats.forEach(s => {
    if (s.type !== 'ai') return;
    if (used.has(s.colorIdx)) {
      for (let i = 0; i < lobbyPaletteSize(); i++) { if (!used.has(i)) { s.colorIdx = i; break; } }
    }
    used.add(s.colorIdx);
  });
}

// ---- Host: seed + lifecycle ----

// Build the host-side lobby the moment a guest connects. Seat 0 is the host
// (always "ready" — host readiness means "can click Start"); seat 1 is the
// just-connected human guest. Starts in 1v1; the host can switch modes.
function seedHostLobby(){
  let mode = '1v1';
  lobbyState = {
    mode: mode,
    aiDifficulty: (typeof aiDifficulty !== 'undefined' && aiDifficulty) ? aiDifficulty : 'standard',
    seats: lobbyBuildSeats(mode, null),
    mapSize: lobbyReadMapSizeRadio(),
    speed: GAME_SPEED,
    numTeams: lobbyModeNumTeams(mode),
  };
}

// Host: a guest's DataConnection just opened. Build the lobby, swap the
// "waiting" screen for it, and hand the guest the state. The match does NOT
// start here — only when the host clicks Start.
function hostEnterLobby(){
  window.__mpSession.inLobby = true;
  seedHostLobby();
  let status = document.getElementById('mp-status-panel');
  if (status) status.style.display = 'none';
  let menu = document.getElementById('tutorial');
  if (menu) menu.style.display = 'flex';
  showMenuPanel('lobby');
  renderLobby();
  broadcastToGuest(Object.assign({ type: 'lobby-open' }, lobbyPayload()));
}

// Host: the guest dropped while in the lobby. Fall back to the plain
// "waiting for opponent" invite screen; a re-joining guest re-enters the lobby
// via hostEnterLobby (onNetConnectionOpen, js/init.js).
function onGuestLeftLobby(){
  window.__mpSession.inLobby = false;
  lobbyState = null;
  showMenuPanel('main');
  if (typeof showMpStatus === 'function') {
    showMpStatus('Waiting for opponent to join…', lobbyShareLink || undefined);
  }
  let cancelBtn = document.getElementById('mp-cancel-btn');
  if (cancelBtn) cancelBtn.style.display = '';
  if (typeof showMsg === 'function') showMsg('Opponent left — waiting for a new opponent');
}

// ---- Payload / broadcast helpers ----
function lobbyPayload(){
  // Deep-ish copy so a later host-side mutation can't retroactively change an
  // already-queued message (queueSend serializes async — js/net.js).
  return {
    seats: lobbyState.seats.map(s => Object.assign({}, s)),
    mode: lobbyState.mode,
    aiDifficulty: lobbyState.aiDifficulty,
    mapSize: lobbyState.mapSize,
    speed: lobbyState.speed,
    numTeams: lobbyState.numTeams,
  };
}
// Host: authoritative state changed — push the whole thing and re-render.
function lobbyBroadcast(){
  renderLobby();
  if (netRole === 'host' && netConnected) {
    broadcastToGuest(Object.assign({ type: 'lobby-sync' }, lobbyPayload()));
  }
}

// ---- Guest: apply the host's authoritative state ----
function applyLobbyState(msg, isOpen){
  lobbyState = { seats: msg.seats || [], mode: msg.mode || '1v1', aiDifficulty: msg.aiDifficulty || 'standard',
    mapSize: msg.mapSize, speed: msg.speed, numTeams: msg.numTeams || 2 };
  window.__mpSession.inLobby = true;
  if (isOpen) {
    // First time entering the lobby: dismiss the "connecting" status and the
    // guest's hidden setup UI, show the lobby panel.
    let status = document.getElementById('mp-status-panel');
    if (status) status.style.display = 'none';
    let menu = document.getElementById('tutorial');
    if (menu) menu.style.display = 'flex';
    showMenuPanel('lobby');
  }
  renderLobby();
}

// ---- Rendering ----
// Which seat this tab controls: host edits seat 0, guest edits seat 1.
function lobbyMySeatIndex(){ return netRole === 'guest' ? 1 : 0; }

function renderLobby(){
  if (!lobbyState) return;
  // The guest's enterGuestJoinMode (js/init.js) broad-hides EVERY
  // .menu-button-container / .setup-grid / .menu-divider in the menu at boot —
  // which sweeps up the lobby's own Ready/Leave buttons, settings grid, and
  // heading. Re-show the lobby panel's own structural children so they're
  // visible once we're actually in the lobby (per-button display is managed
  // below; the settings grid is shown-but-disabled for the guest).
  let panel = document.getElementById('menu-panel-lobby');
  if (panel) panel.querySelectorAll('.menu-button-container, .setup-grid, .menu-divider')
    .forEach(el => { el.style.display = ''; });
  let roster = document.getElementById('lobby-roster');
  if (roster) {
    // A full rebuild on every sync would yank focus/caret out of a name field
    // mid-type (both peers re-render whenever the authoritative state changes).
    // Remember the caret in a focused name input and restore it afterward.
    let active = document.activeElement;
    let keepCaret = (active && active.tagName === 'INPUT' && active.classList.contains('lobby-seat-name'))
      ? active.selectionStart : null;
    roster.textContent = '';
    lobbyState.seats.forEach((seat, t) => roster.appendChild(buildSeatRow(seat, t)));
    if (keepCaret != null) {
      let inp = roster.querySelector('input.lobby-seat-name'); // only my own seat is an input
      if (inp) { inp.focus(); try { inp.setSelectionRange(keepCaret, keepCaret); } catch (e) {} }
    }
  }
  // Settings: host-interactive, guest read-only mirror.
  lobbySetRadio('lobbymode', lobbyState.mode || '1v1');
  lobbySetRadio('lobbyaidiff', lobbyState.aiDifficulty || 'standard');
  lobbySetRadio('lobbymapsize', lobbyState.mapSize);
  lobbySetRadio('lobbyspeed', String(lobbyState.speed));
  // AI difficulty control only applies when there are AI opponents.
  let aiCol = document.getElementById('lobby-aidiff-col');
  if (aiCol) aiCol.style.visibility = (lobbyModeNumTeams(lobbyState.mode) === 4) ? '' : 'hidden';
  lobbySetSettingsEnabled(netRole === 'host');
  // Buttons.
  let readyBtn = document.getElementById('lobby-ready-btn');
  let startBtn = document.getElementById('lobby-start-btn');
  // Leaving is a host action (it tears down the session); a guest just closes
  // the tab / navigates away. Hide the guest's Leave button — but the BUTTON,
  // not its container, which it now shares with the guest's Ready button.
  let leaveBtn = document.getElementById('lobby-leave-btn');
  if (leaveBtn) leaveBtn.style.display = netRole === 'guest' ? 'none' : '';
  if (netRole === 'guest') {
    if (readyBtn) {
      readyBtn.style.display = '';
      let me = lobbyState.seats[1];
      let ready = me && me.ready;
      readyBtn.textContent = ready ? '✔ Ready (waiting for host)' : '✔ Ready';
      readyBtn.classList.toggle('lobby-ready-on', !!ready);
    }
    if (startBtn) startBtn.style.display = 'none';
  } else {
    if (readyBtn) readyBtn.style.display = 'none';
    if (startBtn) {
      startBtn.style.display = '';
      startBtn.disabled = !lobbyCanStart();
    }
  }
  if (typeof scaleMenuToFit === 'function') scaleMenuToFit();
}

// Can the host start? The guest seat must be present and ready.
function lobbyCanStart(){
  if (!lobbyState) return false;
  let s = lobbyState.seats[1];
  return !!(s && s.present && s.ready);
}

function buildSeatRow(seat, t){
  let row = document.createElement('div');
  row.className = 'lobby-seat';
  let mine = t === lobbyMySeatIndex();

  // Color swatches: for MY seat, the full palette (taken colors disabled);
  // otherwise a single read-only swatch of this seat's color.
  let swatches = document.createElement('div');
  swatches.className = 'lobby-seat-swatches';
  let editableColor = mine && seat.present;
  if (editableColor) {
    let taken = lobbyTakenColors(t);
    for (let i = 0; i < lobbyPaletteSize(); i++) {
      let b = document.createElement('button');
      b.type = 'button';
      b.className = 'lobby-swatch' + (i === seat.colorIdx ? ' lobby-swatch-sel' : '');
      b.style.background = PLAYER_TEAM_COLORS[i];
      if (taken.has(i) && i !== seat.colorIdx) b.disabled = true;
      let idx = i;
      b.onclick = () => lobbyPickColor(idx);
      swatches.appendChild(b);
    }
  } else {
    let sw = document.createElement('div');
    sw.className = 'lobby-swatch';
    sw.style.background = PLAYER_TEAM_COLORS[seat.colorIdx];
    swatches.appendChild(sw);
  }
  row.appendChild(swatches);

  // Name: editable input for my seat, else static text.
  if (mine && seat.present) {
    let input = document.createElement('input');
    input.className = 'lobby-seat-name';
    input.type = 'text';
    input.maxLength = LOBBY_NAME_MAX;
    input.value = seat.name || '';
    input.placeholder = 'Your name';
    input.oninput = () => lobbyEditName(input.value);
    // Keep game hotkeys / Esc from hijacking the field.
    input.onkeydown = (e) => e.stopPropagation();
    row.appendChild(input);
  } else {
    let nm = document.createElement('span');
    nm.className = 'lobby-seat-name';
    nm.setAttribute('readonly', '');
    nm.textContent = lobbySeatLabel(seat, t);
    nm.style.color = PLAYER_TEAM_COLORS[seat.colorIdx];
    row.appendChild(nm);
  }

  // Alliance-side tag (only meaningful in the 4-team modes). Same-letter = allied.
  if (lobbyModeNumTeams(lobbyState.mode) === 4) {
    let side = document.createElement('span');
    side.className = 'lobby-seat-team';
    let al = lobbyAlliancesFor(lobbyState.mode);
    side.textContent = 'Team ' + (String.fromCharCode(65 + (al[t] || 0)));
    row.appendChild(side);
  }

  // Right-side status badge.
  let badge = document.createElement('span');
  badge.className = 'lobby-seat-badge';
  if (seat.type === 'ai') {
    badge.textContent = 'AI · ' + (AI_LEVELS[lobbyState.aiDifficulty] || AI_LEVELS.standard).name;
  } else if (t === 0) {
    badge.textContent = 'Host';
  } else if (!seat.present) {
    badge.textContent = 'Waiting…';
  } else if (seat.ready) {
    badge.textContent = 'Ready';
    badge.classList.add('lobby-ready');
  } else {
    badge.textContent = 'Not ready';
  }
  row.appendChild(badge);
  return row;
}

// A seat's display string when not an editable input.
function lobbySeatLabel(seat, t){
  if (seat.type === 'ai') return 'Computer';
  if (!seat.present) return 'Open slot';
  return (seat.name && seat.name.trim()) ? seat.name.trim() : ('Player ' + (t + 1));
}

// Colors held by OTHER present HUMAN seats — a human can't take another human's
// color. AI colors are NOT "taken": they auto-slide out of the way
// (lobbyReassignAiColors) when a human picks their color.
function lobbyTakenColors(exceptT){
  let set = new Set();
  lobbyState.seats.forEach((s, t) => {
    if (t === exceptT) return;
    if (s.type === 'human' && s.present) set.add(s.colorIdx);
  });
  return set;
}

// ---- Edits (route by role) ----
function lobbyEditName(val){
  let name = String(val || '').slice(0, LOBBY_NAME_MAX);
  localPlayerName = name.trim();
  try { localStorage.setItem('aoePlayerName', localPlayerName); } catch (e) {}
  if (netRole === 'host') {
    lobbyState.seats[0].name = name;
    lobbyBroadcast();
  } else {
    lobbyState.seats[1].name = name;
    sendLobbySeat();
  }
}

function lobbyPickColor(idx){
  if (idx < 0 || idx >= lobbyPaletteSize()) return;
  let me = lobbyMySeatIndex();
  if (lobbyTakenColors(me).has(idx)) return; // another human has it — ignore
  lobbyState.seats[me].colorIdx = idx;
  if (netRole === 'host') { lobbyReassignAiColors(lobbyState.seats); lobbyBroadcast(); }
  else { renderLobby(); sendLobbySeat(); } // host reconciles AI colors on sync
}

// Host-only: the Teams mode changed. Rebuild seats (preserving the humans) and
// resize the match.
function onLobbyModeChange(){
  if (!lobbyState || netRole !== 'host') return;
  let sel = document.querySelector('input[name="lobbymode"]:checked');
  let mode = sel ? sel.value : '1v1';
  lobbyState.mode = mode;
  lobbyState.numTeams = lobbyModeNumTeams(mode);
  lobbyState.seats = lobbyBuildSeats(mode, lobbyState.seats);
  lobbyBroadcast();
}
// Host-only: shared AI difficulty changed.
function onLobbyAiDiffChange(){
  if (!lobbyState || netRole !== 'host') return;
  let sel = document.querySelector('input[name="lobbyaidiff"]:checked');
  lobbyState.aiDifficulty = sel ? sel.value : 'standard';
  lobbyBroadcast();
}

// Host-only: settings radios changed.
function onLobbyMapSizeChange(){ if (!lobbyState || netRole !== 'host') return; lobbyState.mapSize = lobbyReadMapSizeRadio(); lobbyBroadcast(); }
function onLobbySpeedChange(){
  if (!lobbyState || netRole !== 'host') return;
  let sel = document.querySelector('input[name="lobbyspeed"]:checked');
  lobbyState.speed = sel ? parseFloat(sel.value) : 2;
  lobbyBroadcast();
}

// Guest-only: Ready toggle.
function onLobbyReadyClicked(){
  if (netRole !== 'guest' || !lobbyState) return;
  lobbyState.seats[1].ready = !lobbyState.seats[1].ready;
  renderLobby();
  sendLobbySeat();
}

// Guest -> host request with this tab's current seat prefs.
function sendLobbySeat(){
  if (netRole !== 'guest') return;
  let s = lobbyState.seats[1] || {};
  sendToHost({ type: 'lobby-seat', name: s.name || '', colorIdx: s.colorIdx || 0, ready: !!s.ready });
}

// Host: validate + merge a guest's seat request, then rebroadcast.
function hostApplyLobbySeat(msg){
  if (netRole !== 'host' || !lobbyState) return;
  let s = lobbyState.seats[1];
  if (!s || !s.present) return; // no live guest to accept from
  if (typeof msg.name === 'string') s.name = msg.name.slice(0, LOBBY_NAME_MAX);
  if (typeof msg.colorIdx === 'number' && msg.colorIdx >= 0 && msg.colorIdx < lobbyPaletteSize()
      && !lobbyTakenColors(1).has(msg.colorIdx)) {
    s.colorIdx = msg.colorIdx; // reject the host's own color (guest UI snaps back on sync)
  }
  s.ready = !!msg.ready;
  lobbyReassignAiColors(lobbyState.seats); // AI slide off the guest's chosen color
  lobbyBroadcast();
}

// ---- Start (host) ----
function onLobbyStartClicked(){
  if (netRole !== 'host' || !lobbyCanStart()) return;
  // hostStartLockstepMatch (js/lockstep.js) reads lobbyState for map/speed/
  // controllers/names/colors. lobbyState stays set so a later Rematch reuses
  // this same agreed config.
  hostStartLockstepMatch();
  // Reset the (now hidden) menu to its minimal mid-match state — crucially
  // showMenuPanel('main'), so reopening the pause menu doesn't show the stale
  // lobby panel. (The guest does this in its lockstep-start handler.)
  if (typeof restoreMenuForMatch === 'function') restoreMenuForMatch();
}

// Translate the agreed seats into the sim/team globals. Called by
// hostStartLockstepMatch AFTER restartGame (which reset them to defaults),
// BEFORE the seed snapshot + broadcast so both peers and the checksum agree.
function applyLobbyConfigToTeams(){
  if (!lobbyState) return;
  let mode = lobbyState.mode || '1v1';
  teamControllers = lobbyControllersFor(mode, lobbyState.aiDifficulty);
  teamAlliance = lobbyAlliancesFor(mode);
  teamColorMap = lobbyState.seats.map(s => s.colorIdx);
  teamNames = lobbyState.seats.map(s => s.type === 'ai' ? 'Computer' : ((s.name && s.name.trim()) || null));
  resetAIStates(); // (re)create the AI brains for any AI slots (js/core.js)
}

// ---- Leave (host only — the guest's button is hidden) ----
function onLobbyLeaveClicked(){
  if (netRole === 'host') {
    cancelHosting(); // js/init.js — tears down the session, back to the main menu
  } else {
    if (typeof leaveMpSession === 'function') leaveMpSession();
    try { location.href = location.pathname; } catch (e) { location.reload(); }
  }
}

// ---- Settings radio helpers ----
function lobbyReadMapSizeRadio(){
  let sel = document.querySelector('input[name="lobbymapsize"]:checked');
  return sel ? sel.value : 'medium';
}
function lobbySetRadio(name, value){
  let el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
  if (el) el.checked = true;
}
function lobbySetSettingsEnabled(enabled){
  document.querySelectorAll('#lobby-settings-grid input[type="radio"]').forEach(el => { el.disabled = !enabled; });
  let grid = document.getElementById('lobby-settings-grid');
  if (grid) grid.style.opacity = enabled ? '' : '0.75';
}

// ---- Chat wiring (rendering lives in js/chat.js, which routes to the lobby
// log while inLobby). Here we just wire the lobby's own input box. ----
document.addEventListener('DOMContentLoaded', () => {
  // Host settings radios → broadcast on change.
  document.querySelectorAll('input[name="lobbymode"]').forEach(el => el.addEventListener('change', onLobbyModeChange));
  document.querySelectorAll('input[name="lobbyaidiff"]').forEach(el => el.addEventListener('change', onLobbyAiDiffChange));
  document.querySelectorAll('input[name="lobbymapsize"]').forEach(el => el.addEventListener('change', onLobbyMapSizeChange));
  document.querySelectorAll('input[name="lobbyspeed"]').forEach(el => el.addEventListener('change', onLobbySpeedChange));
  // Lobby chat input: Enter sends via the shared chat pipeline (js/chat.js).
  let input = document.getElementById('lobby-chat-input');
  if (input) {
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        if (typeof sendChatMessage === 'function') sendChatMessage(input.value);
        input.value = '';
      }
    });
  }
});

// ---- Incoming lobby messages ----
onNetMessage((msg) => {
  if (msg.type === 'lobby-open' && netRole === 'guest') {
    applyLobbyState(msg, true);
  } else if (msg.type === 'lobby-sync' && netRole === 'guest') {
    applyLobbyState(msg, false);
  } else if (msg.type === 'lobby-seat' && netRole === 'host') {
    hostApplyLobbySeat(msg);
  }
});
