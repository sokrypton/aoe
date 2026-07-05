// ---- DETERMINISTIC LOCKSTEP (opt-in via ?lockstep while it burns in) ----
// Both peers run the full simulation from the same seed and the same
// tick-stamped command stream (js/commands.js): no snapshots, no smoothing,
// no corrections — each player's own sim is the render source, so commands
// feel instant (cosmetic feedback at input time, execution INPUT_DELAY_TICKS
// later) and nothing ever jumps.
//
// Wire protocol (on top of js/net.js's envelope):
//   {type:'lockstep-start', seed, mapSize, speed}   host -> guest: begin
//   {type:'cmd-ls', execTick, seq, cmd}             both ways: a command,
//       already world-space, stamped by the ISSUER at issueTick+delay;
//       scheduled verbatim on both queues.
//   {type:'tick', t, [ct, h]}                       both ways, per simmed
//       tick: watermark "I have simulated through t (and issued every
//       command with execTick <= t+delay)". Optional piggybacked checksum
//       h for tick ct every LOCKSTEP_CKSUM_EVERY ticks.
//
// Gating: a peer may simulate tick T only once the other side's watermark
// covers it (peerSimTick >= T - INPUT_DELAY_TICKS). The DataChannel is
// reliable+ordered, so when {tick:t} arrives, every cmd-ls stamped by the
// peer at or before t has already arrived — no missing-input case exists,
// only waiting. A fast peer therefore stalls at most INPUT_DELAY_TICKS
// ahead of a slow one: tick-rate sync falls out of the gating for free.

let lockstepActive = false;
let peerSimTick = -1;
let lastReportedSimTick = -1;
let lockstepDesyncedAt = null;
const LOCKSTEP_CKSUM_EVERY = 30;

// Requested via ?lockstep on the host's page; the guest turns it on when
// the lockstep-start message arrives, whatever its own URL said. Captured
// at load time — hosting rewrites location.search to the ?host= resume
// link, which would otherwise drop the flag before the guest ever joins.
const LOCKSTEP_URL_FLAG = typeof window !== 'undefined' && /[?&]lockstep\b/.test(window.location.search);
function lockstepRequested(){
  return LOCKSTEP_URL_FLAG;
}
function lockstepEnabled(){
  return lockstepActive && netRole != null;
}

function sendToPeer(msg){
  if (netRole === 'host') broadcastToGuest(msg);
  else if (netRole === 'guest') sendToHost(msg);
}

// Host side: begin a fresh lockstep match the moment the guest connects
// (mirrors the restartGame path in onNetConnectionOpen, plus the seed
// handshake). Called from init.js instead of the plain restartGame.
function hostStartLockstepMatch(){
  lockstepActive = true;
  peerSimTick = -1;
  lastReportedSimTick = -1;
  lockstepDesyncedAt = null;
  let sizeSel = document.querySelector('input[name="mapsize"]:checked');
  let sizeKey = sizeSel ? sizeSel.value : 'medium';
  window.fogDisabled = false;
  setMapSize(sizeKey); // draws the fresh matchSeed both peers will share
  restartGame('standard');
  DET.enabled = true; // per-tick checksum ring for the exchange below
  broadcastToGuest({ type: 'lockstep-start', seed: matchSeed, mapSize: sizeKey, speed: GAME_SPEED });
}

onNetMessage((msg) => {
  if (msg.type === 'lockstep-start' && netRole === 'guest') {
    lockstepActive = true;
    peerSimTick = -1;
    lastReportedSimTick = -1;
    lockstepDesyncedAt = null;
    window.fogDisabled = false;
    if (typeof setGameSpeed === 'function') setGameSpeed(msg.speed);
    window.__pendingMatchSeed = msg.seed;
    setMapSize(msg.mapSize);
    restartGame('standard');
    DET.enabled = true;
    gameStarted = true;
    gamePaused = false;
    if (typeof showMpStatus === 'function') showMpStatus('Connected! Lockstep match started.');
    let menu = document.getElementById('tutorial');
    if (menu) menu.style.display = 'none';
    if (typeof restoreMenuForMatch === 'function') restoreMenuForMatch();
  } else if (msg.type === 'cmd-ls' && lockstepActive) {
    // The peer's team: guest commands land on the host as team 1 and vice
    // versa — never trusted from the wire.
    let peerTeam = netRole === 'host' ? 1 : 0;
    if (msg.execTick <= tick) {
      // Should be impossible under the gating; if it ever happens the sims
      // have already diverged — say so loudly rather than silently degrade.
      lockstepFatal('late command: execTick ' + msg.execTick + ' arrived at tick ' + tick);
    }
    scheduleCommand(msg.execTick, peerTeam, msg.seq, msg.cmd);
  } else if (msg.type === 'tick' && lockstepActive) {
    if (msg.t > peerSimTick) peerSimTick = msg.t;
    if (msg.h !== undefined) lockstepCheckPeerChecksum(msg.ct, msg.h);
  }
});

// May we simulate tick T? (Called with tick+1 before each update().)
function lockstepCanSim(t){
  if (!netConnected) return false; // peer gone: stall (disconnect flow pauses anyway)
  // Strictly-greater window: while the peer is still AT tick P it can still
  // issue commands stamped P+DELAY, and those are sent BEFORE its {tick:P+1}
  // report (ordered channel). So tick T is complete only once the peer has
  // reported P >= T - DELAY + 1.
  return peerSimTick >= t - INPUT_DELAY_TICKS + 1;
}

// After simming: tell the peer how far we are, with a periodic checksum.
function lockstepReport(){
  if (tick === lastReportedSimTick) return;
  lastReportedSimTick = tick;
  let msg = { type: 'tick', t: tick };
  if (tick % LOCKSTEP_CKSUM_EVERY === 0 && DET.history.length) {
    let last = DET.history[DET.history.length - 1];
    msg.ct = last.tick;
    msg.h = last.sum;
  }
  sendToPeer(msg);
}

function lockstepCheckPeerChecksum(t, h){
  // DET.history is a bounded ring — an entry we've already dropped is fine
  // to skip; adjacent exchanges cover it.
  for (let i = DET.history.length - 1; i >= 0; i--) {
    let rec = DET.history[i];
    if (rec.tick === t) {
      if (rec.sum !== h) lockstepFatal('checksum mismatch at tick ' + t);
      return;
    }
    if (rec.tick < t) return;
  }
}

// Desync is a bug, full stop (the whole determinism workstream exists so
// this never fires). Phase A policy: freeze loudly and keep the evidence —
// automated recovery (full-snapshot restore) is the tuning phase's job.
function lockstepFatal(why){
  if (lockstepDesyncedAt != null) return;
  lockstepDesyncedAt = tick;
  window.__lockstepDesync = why; // tests assert this stays undefined
  console.error('LOCKSTEP DESYNC @ tick ' + tick + ': ' + why);
  if (typeof showMsg === 'function') showMsg('Desync detected — match halted (' + why + ')');
  gamePaused = true;
}
