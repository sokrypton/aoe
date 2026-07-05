// ---- MULTIPLAYER: command relay (guest -> host) ----
// The guest never mutates world state directly. Every action is resolved
// to a world-space command on the guest (js/commands.js resolver/executor
// split), relayed here, and scheduled on the HOST's tick queue as team 1 —
// executed by the same execCommand the host's own commands go through.

function sendCommand(intent){
  sendToHost({ type: 'cmd', intent });
}

// Set true while executing a command issued by the OTHER player (see
// execCommand, js/commands.js) — read by the shared mutation code to
// suppress issuer-only feedback (sounds/markers/showMsg): that feedback
// belongs to whoever physically clicked, and they already got it locally
// at input time.
let isReplayingRemoteCommand = false;

// Commands arrive from the guest already resolved to world space
// (js/commands.js's resolver/executor split) — schedule on the host's
// queue as team 1 with the same input delay as local commands. Ownership
// is enforced per-kind inside execCommand, never trusted from the wire.
let remoteCmdSeq = 0;
function applyRemoteCommand(intent){
  if (!intent || !intent.kind) return;
  scheduleCommand(tick + INPUT_DELAY_TICKS, 1, ++remoteCmdSeq, intent);
}

onNetMessage((msg) => {
  if (msg.type === 'cmd' && netRole === 'host') {
    applyRemoteCommand(msg.intent);
  }
});
