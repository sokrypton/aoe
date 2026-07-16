// ---- MULTIPLAYER: in-game chat ----
// Classic RTS flow: Enter opens the input, Enter again sends (or closes if
// empty), Esc cancels. Messages ride the same reliable compressed message
// channel as everything else ({type:'chat', text}) — no new transport
// concerns. Multiplayer-only: the Enter hook (js/input.js) never opens the
// box without a live connection.
//
// All message text goes into the DOM via textContent, never innerHTML —
// chat is the one place a remote peer controls a string we display, so it
// must never be parsed as markup.

const CHAT_MAX_LEN = 200;
const CHAT_MAX_LINES = 8;
const CHAT_LINE_FADE_MS = 12000;

let chatOpen = false;

function chatAvailable(){
  let connected = (netRole === 'host' || netRole === 'guest') && netConnected;
  // Available both in-match AND in the pre-match lobby (js/lobby.js) — the
  // lobby has no gameStarted yet.
  return connected && ((gameStarted && !gameOver) || window.__mpSession.inLobby);
}

// The color/name to label a seat's chat with. In the lobby the agreed colors/
// names aren't applied to teamColorMap/teamNames yet (they land at match
// start), so read them straight from lobbyState there; in-match, use the
// applied globals so a lobby-chosen color/name carries through.
function chatSeatColor(team){
  if (window.__mpSession.inLobby && typeof lobbyState !== 'undefined' && lobbyState && lobbyState.seats[team]) {
    return PLAYER_TEAM_COLORS[lobbyState.seats[team].colorIdx];
  }
  return teamColor(team);
}
function chatSeatName(team){
  if (window.__mpSession.inLobby && typeof lobbyState !== 'undefined' && lobbyState && lobbyState.seats[team]) {
    let s = lobbyState.seats[team];
    return (s.name && s.name.trim()) ? s.name.trim() : (s.type === 'ai' ? 'Computer' : ('Player ' + (team + 1)));
  }
  return teamName(team);
}

// Sender identified by TEAM (== seat index; the host derives it from the
// sending connection, guests from the host's relay stamp), labeled with the
// seat's chosen name in its chosen color. Routes to the lobby's own log
// while in the lobby, else the in-match overlay log. All text goes through
// textContent — names are remote-controlled strings, so they must never be
// parsed as markup (same rule the body already followed).
function addChatLine(team, text){
  let inLobby = window.__mpSession.inLobby;
  let log = document.getElementById(inLobby ? 'lobby-chat-log' : 'chat-log');
  if (!log) return;
  let line = document.createElement('div');
  line.className = 'chat-line';
  let name = document.createElement('span');
  name.style.color = chatSeatColor(team);
  name.style.fontWeight = 'bold';
  name.textContent = chatSeatName(team) + ': ';
  let body = document.createElement('span');
  body.textContent = String(text).slice(0, CHAT_MAX_LEN);
  line.appendChild(name);
  line.appendChild(body);
  log.appendChild(line);
  while (log.children.length > CHAT_MAX_LINES) log.removeChild(log.firstChild);
  if (inLobby) {
    // Lobby log persists (scrollable panel) — no fade; keep the newest visible.
    log.scrollTop = log.scrollHeight;
  } else {
    // In-match overlay: old lines fade so they don't permanently cover the map
    // — the node stays until pushed out, so a just-arrived message never yanks
    // the layout mid-read.
    setTimeout(() => line.classList.add('chat-line-faded'), CHAT_LINE_FADE_MS);
  }
}

function openChatInput(){
  // The floating in-match chat box is suppressed in the lobby — the lobby
  // panel has its own always-visible input (js/lobby.js).
  if (chatOpen || !chatAvailable() || window.__mpSession.inLobby) return;
  chatOpen = true;
  let wrap = document.getElementById('chat-input-wrap');
  let input = document.getElementById('chat-input');
  if (!wrap || !input) return;
  wrap.style.display = 'flex';
  input.value = '';
  input.focus();
}

function closeChatInput(){
  chatOpen = false;
  let wrap = document.getElementById('chat-input-wrap');
  let input = document.getElementById('chat-input');
  if (wrap) wrap.style.display = 'none';
  // Return keyboard focus to the game so hotkeys work immediately — an
  // input left focused would swallow every game key (the keydown handler
  // in js/input.js ignores events targeting form fields).
  if (input) input.blur();
}

function sendChatMessage(text){
  text = text.trim().slice(0, CHAT_MAX_LEN);
  if (!text) return;
  let msg = { type: 'chat', text };
  if (netRole === 'host') broadcastToGuests(msg);
  else sendToHost(msg); // the host's relay forwards it to the other guests
  // In the lobby a guest's myTeam isn't assigned yet — the seat index is
  // the identity there.
  addChatLine(window.__mpSession.inLobby ? lobbyMySeatIndex() : myTeam, text);
}

document.addEventListener('DOMContentLoaded', () => {
  let input = document.getElementById('chat-input');
  if (!input) return;
  input.addEventListener('keydown', e => {
    // Stop game hotkeys from also seeing these; the guard in js/input.js
    // already skips INPUT targets, but Esc there isn't guarded by target.
    e.stopPropagation();
    if (e.key === 'Enter') {
      sendChatMessage(input.value);
      closeChatInput();
    } else if (e.key === 'Escape') {
      closeChatInput();
    }
  });
  // Clicking away mid-typing shouldn't leave a zombie focused input.
  input.addEventListener('blur', () => { if (chatOpen) closeChatInput(); });
});

// The 💬 button exists for touch devices (index.html is the mobile-friendly
// variant — there's no Enter key on a phone), but shows on desktop too.
// Visibility follows chatAvailable() on a coarse poll rather than hooking
// every connect/disconnect/game-over code path.
setInterval(() => {
  let btn = document.getElementById('chat-btn');
  if (!btn) return;
  // Hidden in the lobby (it has its own input) — only the in-match overlay.
  let want = (chatAvailable() && !window.__mpSession.inLobby) ? 'flex' : 'none';
  if (btn.style.display !== want) btn.style.display = want;
}, 1000);

onNetMessage((msg, src) => {
  if (msg.type !== 'chat') return;
  if (typeof msg.text !== 'string' || !msg.text.trim()) return;
  // Sender: the connection's seat on the host; the relay stamp on a guest
  // (absent = the host itself, team 0).
  let team = netRole === 'host' ? (src && src.seat) : (msg.from != null ? msg.from : 0);
  if (team == null) return;
  addChatLine(team, msg.text);
  if (window.playSound) playSound('chat');
});
