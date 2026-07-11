// ---- MULTIPLAYER: PRE-MATCH LOBBY ("handshake") ----
// Sits between "a guest connects" and "match start". Up to 4 players in
// any human/AI mix: the host (seat 0), 1-3 human guests, and AI seats the
// host can add. Everyone picks a name + color + team, everyone can chat,
// and the host presses Start. Only then does hostStartLockstepMatch()
// (js/lockstep.js) run.
//
// SEATS / TEAMS. Seat index == sim team id (host is always seat/team 0);
// a joining guest gets the next free seat (js/net.js hello -> js/init.js
// assignGuestSeat -> lobbyNextFreeSeat here). Every seat has a TEAM pick,
// AoE2-style: '–' (no team — its own alliance, i.e. free-for-all) or a
// shared team number 1-4 (allied seats spawn in adjacent corners,
// js/core.js setMapSize). ANY combination is allowed — 1v1, 2v2, 3v1,
// full FFA, even everyone allied (sandbox); there is deliberately no
// auto-fixing of "invalid" splits. AI seats take NO network input — every
// peer simulates them deterministically (their state rides the lockstep
// rollback snapshots), so adding AI is a config change, not new netcode.
//
// The host does NOT enter the lobby while alone: clicking Host shows the
// plain invite link/QR "waiting for opponent" screen (js/init.js
// onHostClicked); the lobby appears once the first human guest connects.
// The invite link stays shown inside the lobby while seats remain.
//
// HOST-AUTHORITATIVE FULL-SNAPSHOT model (mirrors lockstep-resync): the
// host owns `lobbyState` and re-sends the whole thing to every guest on
// every change; guests hold a mirror and send REQUESTS the host validates.
// Wire types (over js/net.js's envelope, gated by NET_PROTOCOL_VERSION):
//   {type:'lobby-open', ...payload, yourSeat}  host->guest: "you're in"
//   {type:'lobby-sync', ...payload, yourSeat}  host->guest: state changed
//   {type:'lobby-seat', name, colorIdx, ready, team}  guest->host: request
//       (applied to the SENDING connection's seat — never a claimed one)
// payload = { seats:[{type,name,colorIdx,ready,present,team}], aiDifficulty,
//             mapSize, speed, numTeams }. Chat rides the existing
// {type:'chat'} (js/chat.js, which routes to the lobby log while inLobby).
//
// Names/colors are COSMETIC — never hashed in simChecksum, never snapshotted
// (js/core.js teamColorMap/teamNames). They cross to the match only inside the
// existing lockstep-start / lockstep-resume messages.

// Available color choices = every entry in the shared palette (js/core.js).
function lobbyPaletteSize(){ return PLAYER_TEAM_COLORS.length; }
const LOBBY_NAME_MAX = 24;
const LOBBY_MAX_PLAYERS = 4;   // one per map corner, any human/AI mix

// Every player starts with a random funny name (host, guests without a
// remembered name, and AI seats alike) — editable in the lobby; a chosen
// name persists via localStorage('aoePlayerName') and wins next time.
const LOBBY_NAME_POOL = [
  'Sir Lags-a-Lot', 'Wololo Wizard', 'Sheep Rustler', 'Baron von Boar',
  'Castle Dropper', 'Idle Villager', 'Herbert the Herder', 'Trebuchet Ted',
  'Gold Hoarder', 'Farm Reseeder', 'Scout Rusher', 'Wall Enjoyer',
  'Relic Gremlin', 'Duke of Deer', 'Petard Pete', 'Quickwall Quinn',
  'Berry Baron', 'Militia Mike', 'Tower Toni', 'Saint Wololo',
  'Count Anti-Cav', 'Marquis de Mangonel', 'Loom Skipper', 'Deer Pusher',
];
function lobbyRandomName(){
  let used = new Set((lobbyState ? lobbyState.seats : []).map(s => (s.name || '').trim()));
  let free = LOBBY_NAME_POOL.filter(n => !used.has(n));
  let pool = free.length ? free : LOBBY_NAME_POOL;
  return pool[Math.floor(Math.random() * pool.length)];
}

// The host's shareable ?join= link, remembered so a guest leaving the lobby can
// drop the host back onto the "waiting for opponent" screen with the same link.
let lobbyShareLink = null;

// ---- Seat helpers ----
function lobbyAiCount(seats){ return seats.filter(s => s.type === 'ai').length; }
function lobbyFirstFreeColor(seats){
  let used = new Set(seats.map(s => s.colorIdx));
  for (let i = 0; i < lobbyPaletteSize(); i++) if (!used.has(i)) return i;
  return 0;
}
// Give every AI seat a distinct color the humans aren't using (humans pick
// freely; the AI slide to whatever's free).
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
// The seats' team picks as the sim's teamAlliance array: seats sharing a
// team number are allied; a '–' (team: null) seat is its own one-member
// alliance. 100+team keeps group ids disjoint from the seat-index ids used
// for solo seats — the values are opaque (only compared for equality, in
// sameSide/spawn grouping/checksum).
function lobbySeatAlliances(){
  return lobbyState.seats.map((s, t) => s.team != null ? 100 + s.team : t);
}

// ---- Host: seed + lifecycle ----

// Build the host-side lobby the moment the first guest connects: just the
// host's own seat — guest seats are appended as they join (lobbyNextFreeSeat).
function seedHostLobby(){
  lobbyState = {
    seats: [
      { type: 'human', name: (localPlayerName || '').trim(), colorIdx: 0, ready: true, present: true, team: null },
    ],
    aiDifficulty: (typeof aiDifficulty !== 'undefined' && aiDifficulty) ? aiDifficulty : 'standard',
    mapSize: lobbyReadMapSizeRadio(),
    speed: GAME_SPEED,
    numTeams: 1,
  };
  if (!lobbyState.seats[0].name) lobbyState.seats[0].name = lobbyRandomName();
}

// Host: pick a seat for a hello whose identity matched no existing record
// (js/init.js assignGuestSeat delegates here once a lobby exists). Appends
// the new seat — seat index == team id == the js/net.js registry key.
function lobbyNextFreeSeat(msg){
  if (netRole !== 'host' || !lobbyState) return null;
  if (lobbyState.seats.length >= LOBBY_MAX_PLAYERS) return null;
  let seat = lobbyState.seats.length;
  lobbyState.seats.push({
    type: 'human',
    name: '', // filled by hostEnsureLobbySeat (hello name or a funny default)
    colorIdx: lobbyFirstFreeColor(lobbyState.seats),
    ready: false, present: true, team: null,
  });
  lobbyState.numTeams = lobbyState.seats.length;
  return seat;
}

// Host: a guest's connection just bound to `seat` (js/init.js
// onNetConnectionOpen). Build the lobby if this is the first guest, make
// sure the seat row exists and is marked present, swap the "waiting"
// screen for the lobby, and hand every guest the state. The match does
// NOT start here — only when the host clicks Start.
function hostEnterLobby(seat){
  window.__mpSession.inLobby = true;
  if (!lobbyState) seedHostLobby();
  hostEnsureLobbySeat(seat);
  let status = document.getElementById('mp-status-panel');
  if (status) status.style.display = 'none';
  let menu = document.getElementById('tutorial');
  if (menu) menu.style.display = 'flex';
  showMenuPanel('lobby');
  lobbySendState(seat);
}

function hostEnsureLobbySeat(seat){
  if (seat == null) return;
  let s = lobbyState.seats[seat];
  if (!s) {
    // The pre-lobby first guest got seat 1 before lobbyState existed
    // (js/init.js assignGuestSeat's fallback) — materialize its row now.
    s = { type: 'human', name: '', colorIdx: lobbyFirstFreeColor(lobbyState.seats),
      ready: false, present: true, team: null };
    lobbyState.seats[seat] = s;
    lobbyState.numTeams = lobbyState.seats.length;
  }
  s.present = true;
  let rec = (typeof netGuestBySeat === 'function') ? netGuestBySeat(seat) : null;
  if (rec && rec.name && !(s.name && s.name.trim())) s.name = rec.name.slice(0, LOBBY_NAME_MAX);
  if (!(s.name && s.name.trim())) s.name = lobbyRandomName();
}

// Host: a guest dropped while in the lobby. Its seat is spliced out (team
// ids only crystallize at Start, so reindexing is safe pre-match — the
// js/net.js registry shifts with it). With guests still present the lobby
// stays open; only the LAST guest leaving falls back to the plain
// "waiting for opponent" invite screen.
function onGuestLeftLobby(seat){
  if (netRole !== 'host' || !lobbyState) return;
  if (seat != null && seat !== 0 && lobbyState.seats[seat] && lobbyState.seats[seat].type === 'human') {
    lobbyState.seats.splice(seat, 1);
    lobbyState.numTeams = lobbyState.seats.length;
    if (typeof netGuestsReindexAfterSeatRemoval === 'function') netGuestsReindexAfterSeatRemoval(seat);
  }
  if (typeof netConnectedGuestSeats === 'function' && netConnectedGuestSeats().length > 0) {
    lobbyBroadcast();
    if (typeof showMsg === 'function') showMsg('A player left the lobby');
    return;
  }
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

// Host: kick a human guest out of the lobby (✕ on their row). Their record
// is forgotten entirely — rejoining fresh through the link is allowed.
function lobbyKickHuman(idx){
  if (netRole !== 'host' || !lobbyState) return;
  let s = lobbyState.seats[idx];
  if (!s || s.type !== 'human' || idx === 0) return;
  if (typeof netCloseGuest === 'function') netCloseGuest(idx, 'kicked', false);
  onGuestLeftLobby(idx);
}

// ---- Host: seat edits ----
function lobbyAddAi(){
  if (netRole !== 'host' || !lobbyState) return;
  if (lobbyState.seats.length >= LOBBY_MAX_PLAYERS) return;
  lobbyState.seats.push({ type: 'ai', name: lobbyRandomName(), colorIdx: lobbyFirstFreeColor(lobbyState.seats),
    ready: true, present: true, team: null });
  lobbyState.numTeams = lobbyState.seats.length;
  lobbyBroadcast();
}
function lobbyRemoveAi(idx){
  if (netRole !== 'host' || !lobbyState) return;
  let s = lobbyState.seats[idx];
  if (!s || s.type !== 'ai') return; // humans leave via lobbyKickHuman
  lobbyState.seats.splice(idx, 1);   // later seats reindex (team ids follow seat order)…
  lobbyState.numTeams = lobbyState.seats.length;
  // …so guest connections seated after the removed AI must shift with them.
  if (typeof netGuestsReindexAfterSeatRemoval === 'function') netGuestsReindexAfterSeatRemoval(idx);
  lobbyBroadcast();
}

// Set a seat's team pick: null = '–' (no team, its own alliance) or a
// shared team number 0-3 (shown as Team 1-4). Host edits any seat; a guest
// edits only its own (routed through lobby-seat like name/color).
function lobbySetTeam(idx, team){
  if (!lobbyState) return;
  if (team != null && (team < 0 || team >= LOBBY_MAX_PLAYERS)) return;
  if (netRole === 'host') {
    if (!lobbyState.seats[idx]) return;
    lobbyState.seats[idx].team = team;
    lobbyBroadcast();
  } else if (idx === lobbyMySeatIndex()) {
    lobbyState.seats[idx].team = team;
    renderLobby();
    sendLobbySeat();
  }
}

function onLobbyAiDiffChange(){
  if (!lobbyState || netRole !== 'host') return;
  let sel = document.querySelector('input[name="lobbyaidiff"]:checked');
  lobbyState.aiDifficulty = sel ? sel.value : 'standard';
  lobbyBroadcast();
}

// ---- Payload / broadcast helpers ----
function lobbyPayload(){
  return {
    seats: lobbyState.seats.map(s => Object.assign({}, s)),
    aiDifficulty: lobbyState.aiDifficulty,
    mapSize: lobbyState.mapSize,
    speed: lobbyState.speed,
    numTeams: lobbyState.numTeams,
  };
}
// Per-guest send: the payload is identical for everyone except yourSeat —
// how each guest knows which roster row is its own (there is no implicit
// "the guest is seat 1" anymore). `openSeat` names a guest that should get
// a lobby-open (it just joined); everyone else gets a lobby-sync.
function lobbySendState(openSeat){
  renderLobby();
  if (netRole !== 'host' || !lobbyState || !netConnected) return;
  for (const s of netConnectedGuestSeats()) {
    let type = (openSeat != null && s === openSeat) ? 'lobby-open' : 'lobby-sync';
    sendToGuest(s, Object.assign({ type, yourSeat: s }, lobbyPayload()));
  }
}
function lobbyBroadcast(){ lobbySendState(null); }

// ---- Guest: apply the host's authoritative state ----
function applyLobbyState(msg, isOpen){
  lobbyState = { seats: msg.seats || [], aiDifficulty: msg.aiDifficulty || 'standard',
    mapSize: msg.mapSize, speed: msg.speed, numTeams: msg.numTeams || 2 };
  if (msg.yourSeat != null) window.__mpSession.mySeat = msg.yourSeat;
  window.__mpSession.inLobby = true;
  if (isOpen) {
    let status = document.getElementById('mp-status-panel');
    if (status) status.style.display = 'none';
    let menu = document.getElementById('tutorial');
    if (menu) menu.style.display = 'flex';
    showMenuPanel('lobby');
  }
  renderLobby();
}

// ---- Rendering ----
// Which seat this tab controls: the host is always seat 0; a guest's seat
// arrived in its 'welcome' / lobby-sync yourSeat (js/init.js).
function lobbyMySeatIndex(){
  return netRole === 'guest' ? (window.__mpSession.mySeat != null ? window.__mpSession.mySeat : 1) : 0;
}

function renderLobby(){
  if (!lobbyState) return;
  // The guest's enterGuestJoinMode (js/init.js) broad-hides EVERY
  // .menu-button-container / .setup-grid / .menu-divider in the menu at boot —
  // re-show the lobby panel's own structural children.
  let panel = document.getElementById('menu-panel-lobby');
  if (panel) panel.querySelectorAll('.menu-button-container, .setup-grid, .menu-divider')
    .forEach(el => { el.style.display = ''; });

  renderLobbyRoster();

  // Settings: host-interactive, guest read-only mirror.
  lobbySetRadio('lobbyaidiff', lobbyState.aiDifficulty || 'standard');
  lobbySetRadio('lobbymapsize', lobbyState.mapSize);
  lobbySetRadio('lobbyspeed', String(lobbyState.speed));
  // AI difficulty always sits next to the Add AI button (applies to AI added now
  // or later).
  lobbySetSettingsEnabled(netRole === 'host');

  // Add-AI button (host only, when there's room).
  let addRow = document.getElementById('lobby-addai-row');
  if (addRow) addRow.style.display = (netRole === 'host') ? '' : 'none';
  let addBtn = document.getElementById('lobby-addai-btn');
  if (addBtn) addBtn.disabled = lobbyState.seats.length >= LOBBY_MAX_PLAYERS;

  // Buttons.
  let readyBtn = document.getElementById('lobby-ready-btn');
  let startBtn = document.getElementById('lobby-start-btn');
  let leaveBtn = document.getElementById('lobby-leave-btn');
  if (leaveBtn) leaveBtn.style.display = netRole === 'guest' ? 'none' : '';
  if (netRole === 'guest') {
    if (readyBtn) {
      readyBtn.style.display = '';
      let me = lobbyState.seats[lobbyMySeatIndex()];
      let ready = me && me.ready;
      readyBtn.textContent = ready ? '✔ Ready (waiting for host)' : '✔ Ready';
    }
    if (startBtn) startBtn.style.display = 'none';
  } else {
    if (readyBtn) readyBtn.style.display = 'none';
    if (startBtn) {
      startBtn.style.display = '';
      startBtn.disabled = !lobbyCanStart();
    }
  }
  // Why-can't-I-start hint (host only).
  let hint = document.getElementById('lobby-hint');
  if (hint) {
    let msg = '';
    if (netRole === 'host' && !lobbyCanStart()) {
      msg = 'Waiting for players to ready up…';
    }
    hint.textContent = msg;
    hint.style.display = msg ? '' : 'none';
    if (startBtn) startBtn.title = msg || '';
  }
  // The invite link stays visible inside the lobby while seats remain —
  // more friends can join until Start.
  let inviteRow = document.getElementById('lobby-invite-row');
  if (inviteRow) {
    let show = netRole === 'host' && lobbyShareLink && lobbyState.seats.length < LOBBY_MAX_PLAYERS;
    inviteRow.style.display = show ? '' : 'none';
    let linkEl = document.getElementById('lobby-invite-link');
    if (linkEl && show && linkEl.value !== lobbyShareLink) linkEl.value = lobbyShareLink;
  }
  if (typeof scaleMenuToFit === 'function') scaleMenuToFit();
}

// Flat roster, one row per seat — alliances are the per-row Team pick
// (AoE2-style), not a grouped layout.
function renderLobbyRoster(){
  let roster = document.getElementById('lobby-roster');
  if (!roster) return;
  // Preserve the caret if a name input is focused (all peers re-render on sync).
  let active = document.activeElement;
  let keepCaret = (active && active.tagName === 'INPUT' && active.classList.contains('lobby-seat-name'))
    ? active.selectionStart : null;
  roster.textContent = '';
  lobbyState.seats.forEach((s, t) => roster.appendChild(buildSeatRow(s, t)));
  if (keepCaret != null) {
    let inp = roster.querySelector('input.lobby-seat-name');
    if (inp) { inp.focus(); try { inp.setSelectionRange(keepCaret, keepCaret); } catch (e) {} }
  }
}

// Can the host start? Every present human guest is ready. Team combos are
// never validated — any split (FFA included) is a legal match.
function lobbyCanStart(){
  if (!lobbyState) return false;
  return lobbyState.seats.every((s, t) => s.type !== 'human' || t === 0 || (s.present && s.ready));
}

function buildSeatRow(seat, t){
  let row = document.createElement('div');
  row.className = 'lobby-seat';
  row.dataset.seat = String(t);
  let mine = t === lobbyMySeatIndex();

  // Color swatches: full palette for MY seat, single read-only swatch otherwise.
  let swatches = document.createElement('div');
  swatches.className = 'lobby-seat-swatches';
  if (mine && seat.present) {
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

  // Team pick: '–' (no team — own alliance / FFA) or Team 1-4. The host
  // sets any seat's team (including AI); a guest sets only its own.
  let canEditTeam = netRole === 'host' || (mine && seat.present);
  let teamSel = document.createElement('select');
  teamSel.className = 'lobby-team-select';
  [['', '–'], ['0', '1'], ['1', '2'], ['2', '3'], ['3', '4']].forEach(([v, label]) => {
    let o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    teamSel.appendChild(o);
  });
  teamSel.value = seat.team == null ? '' : String(seat.team);
  teamSel.title = 'Team (– = no team)';
  teamSel.disabled = !canEditTeam;
  teamSel.onchange = () => lobbySetTeam(t, teamSel.value === '' ? null : parseInt(teamSel.value, 10));
  row.appendChild(teamSel);

  // Status badge. (AI difficulty is the shared global control below the roster,
  // not shown per-seat.)
  let badge = document.createElement('span');
  badge.className = 'lobby-seat-badge';
  if (seat.type === 'ai') {
    badge.textContent = 'AI';
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

  // Host-only: remove an AI seat / kick a human guest (✕).
  if (netRole === 'host' && t !== 0) {
    let rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'lobby-mini-btn';
    rm.textContent = '✕';
    rm.title = seat.type === 'ai' ? 'Remove AI' : 'Kick player';
    rm.onclick = () => seat.type === 'ai' ? lobbyRemoveAi(t) : lobbyKickHuman(t);
    row.appendChild(rm);
  }
  return row;
}

function lobbySeatLabel(seat, t){
  let name = (seat.name && seat.name.trim()) ? seat.name.trim() : null;
  if (seat.type === 'ai') return name || 'Computer';
  if (!seat.present) return 'Open slot';
  return name || ('Player ' + (t + 1));
}

// Colors held by OTHER present HUMAN seats — a human can't take another human's
// color. AI colors auto-slide out of the way (lobbyReassignAiColors).
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
    let me = lobbyState.seats[lobbyMySeatIndex()];
    if (me) me.name = name;
    sendLobbySeat();
  }
}

function lobbyPickColor(idx){
  if (idx < 0 || idx >= lobbyPaletteSize()) return;
  let me = lobbyMySeatIndex();
  if (lobbyTakenColors(me).has(idx)) return; // another human has it — ignore
  lobbyState.seats[me].colorIdx = idx;
  if (netRole === 'host') { lobbyReassignAiColors(lobbyState.seats); lobbyBroadcast(); }
  else { renderLobby(); sendLobbySeat(); }
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
  let me = lobbyState.seats[lobbyMySeatIndex()];
  if (!me) return;
  me.ready = !me.ready;
  renderLobby();
  sendLobbySeat();
}

// Guest -> host request with this tab's current seat prefs.
function sendLobbySeat(){
  if (netRole !== 'guest') return;
  let s = lobbyState.seats[lobbyMySeatIndex()] || {};
  sendToHost({ type: 'lobby-seat', name: s.name || '', colorIdx: s.colorIdx || 0, ready: !!s.ready,
    team: s.team == null ? null : s.team });
}

// Host: validate + merge a guest's seat request, then rebroadcast. The
// TARGET seat is the sending connection's binding (src.seat) — a payload
// can never edit someone else's seat.
function hostApplyLobbySeat(msg, src){
  if (netRole !== 'host' || !lobbyState) return;
  if (!src || src.seat == null) return;
  let s = lobbyState.seats[src.seat];
  if (!s || s.type !== 'human' || !s.present) return;
  if (typeof msg.name === 'string' && msg.name.trim()) s.name = msg.name.slice(0, LOBBY_NAME_MAX);
  if (typeof msg.colorIdx === 'number' && msg.colorIdx >= 0 && msg.colorIdx < lobbyPaletteSize()
      && !lobbyTakenColors(src.seat).has(msg.colorIdx)) {
    s.colorIdx = msg.colorIdx; // taken colors are rejected (guest UI snaps back on sync)
  }
  if (msg.team === null || (typeof msg.team === 'number' && msg.team >= 0 && msg.team < LOBBY_MAX_PLAYERS)) {
    s.team = msg.team;
  }
  s.ready = !!msg.ready;
  lobbyReassignAiColors(lobbyState.seats); // AI slide off the guest's chosen color
  lobbyBroadcast();
}

// ---- Start (host) ----
function onLobbyStartClicked(){
  if (netRole !== 'host' || !lobbyCanStart()) return;
  // hostStartLockstepMatch (js/lockstep.js) reads lobbyState for teams/sides/
  // names/colors. lobbyState stays set so a later Rematch reuses this config.
  hostStartLockstepMatch();
  if (typeof restoreMenuForMatch === 'function') restoreMenuForMatch();
}

// Translate the agreed seats into the sim/team globals. Called by
// hostStartLockstepMatch AFTER restartGame (which reset them to defaults),
// BEFORE the seed snapshot + broadcast so both peers and the checksum agree.
function applyLobbyConfigToTeams(){
  if (!lobbyState) return;
  let diff = lobbyState.aiDifficulty || 'standard';
  teamControllers = lobbyState.seats.map(s => s.type === 'ai' ? { type: 'ai', difficulty: diff } : { type: 'human' });
  teamAlliance = lobbySeatAlliances();
  teamColorMap = lobbyState.seats.map(s => s.colorIdx);
  teamNames = lobbyState.seats.map(s => (s.name && s.name.trim()) || null);
  resetAIStates(); // (re)create the AI brains for the AI slots (js/core.js)
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

// ---- Chat input wiring (rendering lives in js/chat.js, which routes to the
// lobby log while inLobby). ----
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[name="lobbyaidiff"]').forEach(el => el.addEventListener('change', onLobbyAiDiffChange));
  document.querySelectorAll('input[name="lobbymapsize"]').forEach(el => el.addEventListener('change', onLobbyMapSizeChange));
  document.querySelectorAll('input[name="lobbyspeed"]').forEach(el => el.addEventListener('change', onLobbySpeedChange));
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
onNetMessage((msg, src) => {
  if (msg.type === 'lobby-open' && netRole === 'guest') {
    applyLobbyState(msg, true);
  } else if (msg.type === 'lobby-sync' && netRole === 'guest') {
    applyLobbyState(msg, false);
  } else if (msg.type === 'lobby-seat' && netRole === 'host') {
    hostApplyLobbySeat(msg, src);
  }
});
