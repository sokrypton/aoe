// ---- MULTIPLAYER: PRE-MATCH LOBBY ("handshake") ----
// Sits between "a guest connects" and "match start". Two humans, plus 0-2 AI
// opponents the host can add, split across TWO sides (alliances). Everyone
// picks a name + color, the host owns the settings + team assignment, both can
// chat, and the host presses Start. Only then does hostStartLockstepMatch()
// (js/lockstep.js) run — the flow used to auto-start on connect.
//
// SEATS / TEAMS / SIDES. Humans are ALWAYS the low team slots — host = team 0,
// guest = team 1 (the wire mapping in js/lockstep.js hardcodes that). AI are
// teams 2/3. So a match has 2-4 players (2 humans + 0/1/2 AI), each its own
// team with its own base/color. Every player is on one of two SIDES (0 or 1) =
// its alliance; a side holds at most 2 players (the map has 2 corners per
// side, js/core.js setMapSize). "1v1" is just 2 humans on opposite sides with
// no AI. AI teams take NO network input — both peers simulate them
// deterministically (their state rides the lockstep rollback snapshots), so
// adding AI is a config change, not new netcode.
//
// The host does NOT enter the lobby while alone: clicking Host shows the plain
// invite link/QR "waiting for opponent" screen (js/init.js onHostClicked); the
// lobby appears only once a human guest connects.
//
// HOST-AUTHORITATIVE FULL-SNAPSHOT model (mirrors lockstep-resync): the host
// owns `lobbyState` and rebroadcasts the whole thing on every change; the guest
// holds a mirror and sends REQUESTS the host validates. Wire types (over
// js/net.js's envelope, gated by NET_PROTOCOL_VERSION):
//   {type:'lobby-open', ...payload}   host->guest: "you're in the lobby now"
//   {type:'lobby-sync', ...payload}   host->guest: authoritative state changed
//   {type:'lobby-seat', name, colorIdx, ready}  guest->host: a request
// payload = { seats:[{type,name,colorIdx,ready,present,side}], aiDifficulty,
//             mapSize, speed, numTeams }. Chat rides the existing {type:'chat'}
// (js/chat.js, which routes to the lobby log while inLobby).
//
// Names/colors are COSMETIC — never hashed in simChecksum, never snapshotted
// (js/core.js teamColorMap/teamNames). They cross to the match only inside the
// existing lockstep-start / lockstep-resume messages.

// Available color choices = every entry in the shared palette (js/core.js).
function lobbyPaletteSize(){ return PLAYER_TEAM_COLORS.length; }
const LOBBY_NAME_MAX = 24;
const LOBBY_MAX_PLAYERS = 4;   // 2 humans + up to 2 AI
const LOBBY_MAX_PER_SIDE = 3;  // 4 corners total, so up to 3 on a side (1v3 / 3v1) — the other side keeps ≥1

// The host's shareable ?join= link, remembered so a guest leaving the lobby can
// drop the host back onto the "waiting for opponent" screen with the same link.
let lobbyShareLink = null;

// ---- Seat helpers ----
function lobbyAiCount(seats){ return seats.filter(s => s.type === 'ai').length; }
function lobbySideCount(seats, side){ return seats.filter(s => s.side === side).length; }
function lobbyFirstFreeColor(seats){
  let used = new Set(seats.map(s => s.colorIdx));
  for (let i = 0; i < lobbyPaletteSize(); i++) if (!used.has(i)) return i;
  return 0;
}
// A valid match: both sides occupied, neither over the corner limit.
function lobbyValidSplit(seats){
  let a = lobbySideCount(seats, 0), b = lobbySideCount(seats, 1);
  return a >= 1 && b >= 1 && a <= LOBBY_MAX_PER_SIDE && b <= LOBBY_MAX_PER_SIDE;
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
function lobbySeatAlliances(){ return lobbyState.seats.map(s => s.side); }

// ---- Host: seed + lifecycle ----

// Build the host-side lobby the moment a guest connects: two human seats on
// opposite sides (a plain 1v1). The host can then add AI and reassign sides.
function seedHostLobby(){
  let seats = [
    { type: 'human', name: (localPlayerName || '').trim(), colorIdx: 0, ready: true,  present: true, side: 0 },
    { type: 'human', name: '',                             colorIdx: 1, ready: false, present: true, side: 1 },
  ];
  lobbyState = {
    seats: seats,
    aiDifficulty: (typeof aiDifficulty !== 'undefined' && aiDifficulty) ? aiDifficulty : 'standard',
    mapSize: lobbyReadMapSizeRadio(),
    speed: GAME_SPEED,
    numTeams: seats.length,
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

// ---- Host: seat edits ----
function lobbyAddAi(){
  if (netRole !== 'host' || !lobbyState) return;
  if (lobbyState.seats.length >= LOBBY_MAX_PLAYERS) return;
  // Default the new AI to a side with room (prefer the emptier one).
  let a = lobbySideCount(lobbyState.seats, 0), b = lobbySideCount(lobbyState.seats, 1);
  let side = (a <= b && a < LOBBY_MAX_PER_SIDE) ? 0 : (b < LOBBY_MAX_PER_SIDE ? 1 : 0);
  lobbyState.seats.push({ type: 'ai', name: 'Computer', colorIdx: lobbyFirstFreeColor(lobbyState.seats),
    ready: true, present: true, side: side });
  lobbyState.numTeams = lobbyState.seats.length;
  lobbyBroadcast();
}
function lobbyRemoveAi(idx){
  if (netRole !== 'host' || !lobbyState) return;
  let s = lobbyState.seats[idx];
  if (!s || s.type !== 'ai') return; // humans can't be removed
  lobbyState.seats.splice(idx, 1);   // remaining AI reindex (team ids follow seat order)
  lobbyState.numTeams = lobbyState.seats.length;
  // Down to the two humans, and they were teaming up (same side, so removing
  // the AI just emptied the other side)? Auto-split them into a valid 1v1 —
  // host to Team 1, guest to Team 2 — instead of leaving an unstartable lobby.
  if (lobbyState.seats.length === 2 && lobbyState.seats[0].side === lobbyState.seats[1].side) {
    lobbyState.seats[0].side = 0;
    lobbyState.seats[1].side = 1;
  }
  lobbyBroadcast();
}
// Host-only: move a seat to a specific side (drag drop target). No-op if it's
// already there or the destination side is full (2-corner limit).
function lobbySetSide(idx, side){
  if (netRole !== 'host' || !lobbyState) return;
  let s = lobbyState.seats[idx];
  if (!s || s.side === side) return;
  if (lobbySideCount(lobbyState.seats, side) >= LOBBY_MAX_PER_SIDE) return; // side full
  s.side = side;
  lobbyBroadcast();
}

// ---- Custom pointer drag (mouse + touch) ----
// The native HTML5 drag only shows a static ghost image; this floats a live
// clone of the seat that follows the pointer/finger and slides into its
// resting place on release. Host-only. One drag at a time.
let lobbyDrag = null;
function lobbyBeginDrag(e, seatIndex, row){
  if (netRole !== 'host' || !lobbyState || lobbyDrag) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return; // left button / touch only
  e.preventDefault();
  let rect = row.getBoundingClientRect();
  let ghost = row.cloneNode(true);
  ghost.classList.add('lobby-drag-ghost');
  ghost.classList.remove('lobby-seat-dragging');
  ghost.style.width = rect.width + 'px';
  ghost.style.transform = 'translate(' + rect.left + 'px,' + rect.top + 'px)';
  document.body.appendChild(ghost);
  row.classList.add('lobby-seat-dragging'); // dim the original in place
  let handle = e.currentTarget;
  try { handle.setPointerCapture(e.pointerId); } catch (err) {}
  // Fix the team boundary at the divider's position now, so the preview shifting
  // layout can't move it under the pointer (which would flicker the target).
  let divider = document.querySelector('.lobby-team-divider');
  let lineY;
  if (divider) { let r = divider.getBoundingClientRect(); lineY = r.top + r.height / 2; }
  else { let r = document.getElementById('lobby-roster').getBoundingClientRect(); lineY = r.top + r.height / 2; }
  lobbyDrag = { seatIndex: seatIndex, ghost: ghost, handle: handle,
    grabX: e.clientX - rect.left, grabY: e.clientY - rect.top,
    originX: rect.left, originY: rect.top, originH: rect.height, lineY: lineY,
    placeholder: null, partnerRow: null, partnerHome: null, previewKey: null };
  document.getElementById('lobby-roster').classList.add('lobby-dragging-active');
  handle.addEventListener('pointermove', lobbyDragMove);
  handle.addEventListener('pointerup', lobbyDragEnd);
  handle.addEventListener('pointercancel', lobbyDragEnd);
}
function lobbySeatUnder(x, y){
  let el = document.elementFromPoint(x, y);
  let row = (el && el.closest) ? el.closest('.lobby-seat') : null;
  return (row && row.dataset.seat != null) ? parseInt(row.dataset.seat, 10) : null;
}
// The divider between the two teams splits the roster: above it → Team 1
// (side 0), below → Team 2 (side 1). `lineY` is captured at drag start so the
// live preview can't shift the boundary under the pointer mid-drag.
function lobbySideFromY(y, lineY){ return y < lineY ? 0 : 1; }
// Decide what dropping `seatIndex` at (x,y) does — the target team is chosen by
// which side of the divider line the pointer is on:
//   'move' — the target team has room and the source keeps ≥1 player.
//   'swap' — trade with a player on the target team, when it's full OR when a
//            plain move would empty the source team. This "smart drag" keeps
//            both teams occupied. The partner PREFERS a human — a real player
//            gets bumped to the other team, not an AI filler ("always drag the
//            human down"): the human under the pointer, else the first human;
//            only an all-AI target side falls back to the pointer/first seat.
//            (To form 2 humans vs 2 AI, drag an AI onto the humans' side — the
//            human there pops over to join the other human.)
//   'none' — dropping back on your own side.
function lobbyResolveDrop(seatIndex, x, y, lineY){
  if (!lobbyState) return { action: 'none' };
  let side = lobbySideFromY(y, lineY);
  let s = lobbyState.seats[seatIndex];
  if (!s || s.side === side) return { action: 'none' };
  let members = [];
  lobbyState.seats.forEach((ss, t) => { if (t !== seatIndex && ss.side === side) members.push(t); });
  let room = members.length < LOBBY_MAX_PER_SIDE;
  let sourceKeepsOne = lobbySideCount(lobbyState.seats, s.side) > 1;
  if (room && sourceKeepsOne) return { action: 'move', side: side };
  if (members.length >= 1) {
    let under = lobbySeatUnder(x, y);
    let humans = members.filter(t => lobbyState.seats[t].type === 'human');
    let withIdx;
    if (humans.length) {
      withIdx = (under != null && humans.indexOf(under) >= 0) ? under : humans[0];
    } else {
      withIdx = (under != null && members.indexOf(under) >= 0) ? under : members[0];
    }
    return { action: 'swap', withIdx: withIdx };
  }
  return { action: 'move', side: side }; // target team empty — just fill it
}
function lobbySwapSides(a, b){
  if (!lobbyState) return;
  let tmp = lobbyState.seats[a].side;
  lobbyState.seats[a].side = lobbyState.seats[b].side;
  lobbyState.seats[b].side = tmp;
  lobbyBroadcast();
}
function lobbyClearDragHighlights(){
  document.querySelectorAll('.lobby-team-group.lobby-drop-over').forEach(g => g.classList.remove('lobby-drop-over'));
}
function lobbyResetPreview(d){
  if (!d) return;
  if (d.placeholder && d.placeholder.parentNode) d.placeholder.parentNode.removeChild(d.placeholder);
  if (d.partnerRow) {
    d.partnerRow.style.transition = '';
    d.partnerRow.style.transform = '';
    d.partnerRow.classList.remove('lobby-seat-previewing');
  }
  d.placeholder = null; d.partnerRow = null; d.partnerHome = null; d.previewKey = null;
}
// Live preview of the pending arrangement, rebuilt only when the landing spot
// changes:
//   MOVE — a gap grows in the target team, sliding its tiles aside to make room.
//   SWAP — the partner block actually slides into the dragged block's origin
//          slot in the other team, so you watch the whole swap happen BEFORE
//          releasing (e.g. drag player 2 toward Team 1 and player 1 slides down
//          into Team 2 in the background).
function lobbyUpdatePreview(d, res){
  let key = res.action === 'none' ? 'none'
    : res.action === 'move' ? ('m' + res.side) : ('s' + res.withIdx);
  if (key === d.previewKey) return;
  d.previewKey = key;
  // Tear down the previous preview.
  if (d.placeholder && d.placeholder.parentNode) d.placeholder.parentNode.removeChild(d.placeholder);
  d.placeholder = null;
  if (d.partnerRow) {
    d.partnerRow.style.transition = ''; d.partnerRow.style.transform = '';
    d.partnerRow.classList.remove('lobby-seat-previewing');
    d.partnerRow = null; d.partnerHome = null;
  }
  if (res.action === 'none') return;
  if (res.action === 'move') {
    let g = document.querySelector('.lobby-team-group[data-side="' + res.side + '"]');
    if (!g) return;
    let ph = document.createElement('div');
    ph.className = 'lobby-seat-placeholder';
    ph.style.height = '0px';
    g.appendChild(ph);
    d.placeholder = ph;
    ph.getBoundingClientRect();          // reflow so the height transition runs
    ph.style.height = d.originH + 'px';  // grow → target tiles slide down
  } else { // swap — slide the partner into the dragged block's origin slot
    let partner = document.querySelector('.lobby-seat[data-seat="' + res.withIdx + '"]');
    if (!partner) return;
    let pr = partner.getBoundingClientRect();
    d.partnerRow = partner;
    d.partnerHome = pr; // its current spot = where the dragged ghost will land
    partner.classList.add('lobby-seat-previewing');
    partner.getBoundingClientRect(); // reflow before transitioning
    partner.style.transition = 'transform 0.16s ease';
    partner.style.transform = 'translate(' + (d.originX - pr.left) + 'px,' + (d.originY - pr.top) + 'px)';
  }
}
function lobbyDragMove(e){
  if (!lobbyDrag) return;
  lobbyDrag.ghost.style.transform =
    'translate(' + (e.clientX - lobbyDrag.grabX) + 'px,' + (e.clientY - lobbyDrag.grabY) + 'px)';
  lobbyClearDragHighlights();
  let res = lobbyResolveDrop(lobbyDrag.seatIndex, e.clientX, e.clientY, lobbyDrag.lineY);
  lobbyUpdatePreview(lobbyDrag, res);
  if (res.action === 'none') return;
  // Highlight the team the line puts us in.
  let side = lobbySideFromY(e.clientY, lobbyDrag.lineY);
  let group = document.querySelector('.lobby-team-group[data-side="' + side + '"]');
  if (group) group.classList.add('lobby-drop-over');
}
function lobbyDragEnd(e){
  if (!lobbyDrag) return;
  let d = lobbyDrag; lobbyDrag = null;
  d.handle.removeEventListener('pointermove', lobbyDragMove);
  d.handle.removeEventListener('pointerup', lobbyDragEnd);
  d.handle.removeEventListener('pointercancel', lobbyDragEnd);
  try { d.handle.releasePointerCapture(e.pointerId); } catch (err) {}
  lobbyClearDragHighlights();
  let rosterEl = document.getElementById('lobby-roster');
  if (rosterEl) rosterEl.classList.remove('lobby-dragging-active');
  let res = lobbyResolveDrop(d.seatIndex, e.clientX, e.clientY, d.lineY);
  let ghost = d.ghost;
  ghost.style.transition = 'transform 0.16s ease-out';
  let dest, commit = null;
  if (res.action === 'move') {
    let r = d.placeholder ? d.placeholder.getBoundingClientRect() : null;
    if (!r) { let g = document.querySelector('.lobby-team-group[data-side="' + res.side + '"]'); r = g ? g.getBoundingClientRect() : null; }
    dest = r ? [r.left, r.top] : [d.originX, d.originY];
    commit = () => lobbySetSide(d.seatIndex, res.side);
  } else if (res.action === 'swap' && d.partnerHome) {
    // The partner already slid into place during the drag — land the ghost in
    // the slot it vacated, keeping the preview stable until the commit.
    dest = [d.partnerHome.left, d.partnerHome.top];
    commit = () => lobbySwapSides(d.seatIndex, res.withIdx);
  } else {
    dest = [d.originX, d.originY]; // snap back
  }
  ghost.style.transform = 'translate(' + dest[0] + 'px,' + dest[1] + 'px)';
  setTimeout(() => {
    if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    lobbyResetPreview(d);                    // clear placeholder / partner transform
    if (commit) commit();                    // re-renders into the committed layout
    else if (typeof renderLobby === 'function') renderLobby(); // un-dim on snap-back
  }, 170);
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
function lobbyBroadcast(){
  renderLobby();
  if (netRole === 'host' && netConnected) {
    broadcastToGuest(Object.assign({ type: 'lobby-sync' }, lobbyPayload()));
  }
}

// ---- Guest: apply the host's authoritative state ----
function applyLobbyState(msg, isOpen){
  lobbyState = { seats: msg.seats || [], aiDifficulty: msg.aiDifficulty || 'standard',
    mapSize: msg.mapSize, speed: msg.speed, numTeams: msg.numTeams || 2 };
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
// Which seat this tab controls: host edits seat 0, guest edits seat 1.
function lobbyMySeatIndex(){ return netRole === 'guest' ? 1 : 0; }

function renderLobby(){
  if (!lobbyState) return;
  // A rebuild mid-drag would destroy the row/handle holding the pointer capture
  // and strand the drag — skip it; lobbyDragEnd re-renders when it finishes.
  if (lobbyDrag) return;
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
      let me = lobbyState.seats[1];
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
  // Why-can't-I-start hint (host only): the split gates Start, so say so.
  let hint = document.getElementById('lobby-hint');
  if (hint) {
    let msg = '';
    if (netRole === 'host' && !lobbyCanStart()) {
      if (!lobbyValidSplit(lobbyState.seats)) msg = '⚠ Each team needs at least one player.';
      else msg = 'Waiting for your opponent to ready up…';
    }
    hint.textContent = msg;
    hint.style.display = msg ? '' : 'none';
    if (startBtn) startBtn.title = msg || '';
  }
  if (typeof scaleMenuToFit === 'function') scaleMenuToFit();
}

// Roster grouped by side into two "Team" panels — allies listed together. Each
// panel is a drag-and-drop drop zone (host only): drag a seat's handle onto the
// other team to reassign it (js/lobby.js lobbySetSide, same 2-per-side limit).
function renderLobbyRoster(){
  let roster = document.getElementById('lobby-roster');
  if (!roster) return;
  // Preserve the caret if a name input is focused (both peers re-render on sync).
  let active = document.activeElement;
  let keepCaret = (active && active.tagName === 'INPUT' && active.classList.contains('lobby-seat-name'))
    ? active.selectionStart : null;
  roster.textContent = '';
  [0, 1].forEach(side => {
    let members = lobbyState.seats.map((s, t) => ({ s, t })).filter(x => x.s.side === side);
    let group = document.createElement('div');
    group.className = 'lobby-team-group';
    group.dataset.side = String(side);
    let hdr = document.createElement('div');
    hdr.className = 'lobby-team-header';
    hdr.textContent = 'Team ' + (side + 1) + (members.length ? '' : ' — drop a player here');
    group.appendChild(hdr);
    members.forEach(({ s, t }) => group.appendChild(buildSeatRow(s, t)));
    roster.appendChild(group);
    // The divider line between the teams IS the drop boundary: dragging a
    // player above it puts them on Team 1, below it on Team 2 (lobbyResolveDrop
    // reads the pointer's side of this line).
    if (side === 0) {
      let div = document.createElement('div');
      div.className = 'lobby-team-divider';
      div.setAttribute('aria-hidden', 'true');
      roster.appendChild(div);
    }
  });
  if (keepCaret != null) {
    let inp = roster.querySelector('input.lobby-seat-name');
    if (inp) { inp.focus(); try { inp.setSelectionRange(keepCaret, keepCaret); } catch (e) {} }
  }
}

// Can the host start? Valid 2-side split AND the guest is ready.
function lobbyCanStart(){
  if (!lobbyState) return false;
  if (!lobbyValidSplit(lobbyState.seats)) return false;
  let g = lobbyState.seats[1];
  return !!(g && g.present && g.ready);
}

function buildSeatRow(seat, t){
  let row = document.createElement('div');
  row.className = 'lobby-seat';
  row.dataset.seat = String(t); // for drag hit-testing / swap targeting
  let mine = t === lobbyMySeatIndex();

  // Drag handle (host only) — grab it to slide this seat onto the other team.
  // Custom pointer drag (works with mouse AND touch), so the row visibly
  // follows the cursor/finger; only the handle starts a drag, leaving the name
  // input / swatches clickable.
  if (netRole === 'host') {
    let handle = document.createElement('span');
    handle.className = 'lobby-drag-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to the other team';
    handle.addEventListener('pointerdown', e => lobbyBeginDrag(e, t, row));
    row.appendChild(handle);
  }

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

  // Host-only: remove an AI seat (✕). Reassigning sides is drag-and-drop.
  if (netRole === 'host' && seat.type === 'ai') {
    let rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'lobby-mini-btn';
    rm.textContent = '✕';
    rm.title = 'Remove AI';
    rm.onclick = () => lobbyRemoveAi(t);
    row.appendChild(rm);
  }
  return row;
}

function lobbySeatLabel(seat, t){
  if (seat.type === 'ai') return 'Computer';
  if (!seat.present) return 'Open slot';
  return (seat.name && seat.name.trim()) ? seat.name.trim() : ('Player ' + (t + 1));
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
  if (!s || !s.present) return;
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
  teamAlliance = lobbyState.seats.map(s => s.side);
  teamColorMap = lobbyState.seats.map(s => s.colorIdx);
  teamNames = lobbyState.seats.map(s => s.type === 'ai' ? 'Computer' : ((s.name && s.name.trim()) || null));
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
onNetMessage((msg) => {
  if (msg.type === 'lobby-open' && netRole === 'guest') {
    applyLobbyState(msg, true);
  } else if (msg.type === 'lobby-sync' && netRole === 'guest') {
    applyLobbyState(msg, false);
  } else if (msg.type === 'lobby-seat' && netRole === 'host') {
    hostApplyLobbySeat(msg);
  }
});
