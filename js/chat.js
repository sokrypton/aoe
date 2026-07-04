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
  return (netRole === 'host' || netRole === 'guest') && netConnected && gameStarted && !gameOver;
}

// Sender is identified by ROLE, not name — there are only ever two peers in
// this 1v1 design. Colors match each side's team color so the label reads
// the same way unit outlines already do (host=team 0 blue, guest=team 1 red).
function addChatLine(senderRole, text){
  let log = document.getElementById('chat-log');
  if (!log) return;
  let line = document.createElement('div');
  line.className = 'chat-line';
  let name = document.createElement('span');
  name.className = senderRole === 'host' ? 'chat-name-host' : 'chat-name-guest';
  name.textContent = (senderRole === 'host' ? 'Host' : 'Guest') + ': ';
  let body = document.createElement('span');
  body.textContent = String(text).slice(0, CHAT_MAX_LEN);
  line.appendChild(name);
  line.appendChild(body);
  log.appendChild(line);
  while (log.children.length > CHAT_MAX_LINES) log.removeChild(log.firstChild);
  // Old lines fade out on their own so the log doesn't permanently cover
  // the map — but the node stays until pushed out by newer lines, so a
  // just-arrived message never yanks the layout around mid-read.
  setTimeout(() => line.classList.add('chat-line-faded'), CHAT_LINE_FADE_MS);
}

function openChatInput(){
  if (chatOpen || !chatAvailable()) return;
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
  if (netRole === 'host') broadcastToGuest(msg);
  else sendToHost(msg);
  addChatLine(netRole, text);
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
  let want = chatAvailable() ? 'flex' : 'none';
  if (btn.style.display !== want) btn.style.display = want;
}, 1000);

onNetMessage((msg) => {
  if (msg.type !== 'chat') return;
  if (typeof msg.text !== 'string' || !msg.text.trim()) return;
  // The sender is simply "the other role" — the only other peer there is.
  addChatLine(netRole === 'host' ? 'guest' : 'host', msg.text);
  if (window.playSound) playSound('chat');
});
