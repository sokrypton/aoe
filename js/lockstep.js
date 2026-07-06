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
// Start pessimistic (~167ms buffer) and adapt DOWN on a good link: a too-
// small opening delay stalls the first seconds of every real-internet
// match before the controller can react, which reads as "the game is
// laggy" right at first impression. Coming down from a safe start only
// costs command latency nobody notices while their first villagers walk.
const LOCKSTEP_START_DELAY = 10;

// ---- Adaptive input delay ----
// The gating slack actually in force. INPUT_DELAY_TICKS (js/commands.js)
// is what new commands are STAMPED with; the two must never violate
// stamp(issuer) >= slack(receiver), or an in-flight command can arrive
// after its tick was simmed. Decreases are safe immediately; an INCREASE
// may only widen the gating after every old-stamp command has landed —
// one old-delay window later.
let lockstepSlack = 4;
let lockstepSlackNext = null, lockstepSlackAtTick = 0;
function lockstepApplyDelay(d){
  let old = INPUT_DELAY_TICKS;
  if (d === old) return;
  INPUT_DELAY_TICKS = d; // stamping switches now — same sim tick on both peers
  if (d < old) {
    lockstepSlack = d; lockstepSlackNext = null;
  } else {
    lockstepSlack = old;
    lockstepSlackNext = d;
    lockstepSlackAtTick = tick + old;
  }
  if (typeof showMsg === 'function') showMsg('Network buffer: ' + Math.round(d * timeStep) + 'ms');
}

// Stall accounting (debug/stats only — see lockstepAdaptDelay for the
// actual control signal): a "stall" is a gameLoop frame that wanted to
// simulate but couldn't because the peer's watermark hadn't covered the
// next tick.
let stallFrames = 0, simFrames = 0;
function lockstepNoteFrame(stalled){
  simFrames++;
  if (stalled) stallFrames++;
}
// Adaptive controller, host-driven. Control signal: PACE — sim ticks
// actually produced vs. expected from wall-clock. Frame-level stall counts
// over-trigger (a gated frame is harmless if the accumulator catches up
// the same instant), which maxed the delay out on links that were already
// running at full speed. Pace only moves when players would actually feel
// it. Gating throttles both peers identically, so the host's own pace IS
// the match's pace — no peer-side signal needed.
let lastAdaptAt = 0, lastAdaptTick = 0, lastDelayChangeAt = 0;
function lockstepAdaptDelay(){
  if (netRole !== 'host' || lockstepDesyncedAt != null) return;
  let nowMs = performance.now();
  if (!lastAdaptAt) { lastAdaptAt = nowMs; lastAdaptTick = tick; return; }
  let windowMs = nowMs - lastAdaptAt;
  if (windowMs < 3000) return;
  // A pause (menus, disconnect) poisons the window — reset the baseline.
  if (windowMs > 10000) { lastAdaptAt = nowMs; lastAdaptTick = tick; return; }
  let pace = (tick - lastAdaptTick) / (windowMs / timeStep);
  lastAdaptAt = nowMs; lastAdaptTick = tick;
  stallFrames = 0; simFrames = 0;
  if (pace < 0.95 && INPUT_DELAY_TICKS < INPUT_DELAY_MAX) {
    lastDelayChangeAt = nowMs;
    submitCommand({ kind: 'set-delay', d: Math.min(INPUT_DELAY_MAX, INPUT_DELAY_TICKS + 2) });
  } else if (pace > 0.99 && INPUT_DELAY_TICKS > 4) {
    // Coming down: quick single steps while still above the healthy-link
    // range (walking off the pessimistic start), then strong hysteresis
    // near the sweet spot — without it the delay oscillates and re-stalls.
    let downEveryMs = INPUT_DELAY_TICKS > 8 ? 6000 : 20000;
    if (nowMs - lastDelayChangeAt >= downEveryMs) {
      lastDelayChangeAt = nowMs;
      submitCommand({ kind: 'set-delay', d: INPUT_DELAY_TICKS - 1 });
    }
  }
}

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
  INPUT_DELAY_TICKS = LOCKSTEP_START_DELAY; lockstepSlack = LOCKSTEP_START_DELAY; lockstepSlackNext = null;
  stallFrames = 0; simFrames = 0; lastAdaptAt = 0; lastDelayChangeAt = 0;
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
    INPUT_DELAY_TICKS = LOCKSTEP_START_DELAY; lockstepSlack = LOCKSTEP_START_DELAY; lockstepSlackNext = null;
    stallFrames = 0; simFrames = 0; lastAdaptAt = 0; lastDelayChangeAt = 0;
    window.fogDisabled = false;
    if (typeof setGameSpeed === 'function') setGameSpeed(msg.speed);
    window.__pendingMatchSeed = msg.seed;
    setMapSize(msg.mapSize);
    restartGame('standard');
    DET.enabled = true;
    gameStarted = true;
    gamePaused = false;
    // init() (via restartGame) centered the camera on TEAM 0's start — on
    // this guest that's the OPPONENT's base. Recenter on our own. (The old
    // snapshot path did this in applyNetSync, which lockstep never runs.)
    let own = entities.find(e => e.team === myTeam);
    if (own) {
      let iso = toIso(own.x, own.y);
      camX = iso.ix; camY = iso.iy;
      window.targetCamX = camX; window.targetCamY = camY;
      window.__mpSession.cameraCentered = true;
    }
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
  // Deferred slack widening from lockstepApplyDelay.
  if (lockstepSlackNext != null && t >= lockstepSlackAtTick) {
    lockstepSlack = lockstepSlackNext;
    lockstepSlackNext = null;
  }
  // Strictly-greater window: while the peer is still AT tick P it can still
  // issue commands stamped P+DELAY, and those are sent BEFORE its {tick:P+1}
  // report (ordered channel). So tick T is complete only once the peer has
  // reported P >= T - SLACK + 1.
  return peerSimTick >= t - lockstepSlack + 1;
}

// After simming: tell the peer how far we are, with a periodic checksum.
function lockstepReport(){
  if (tick === lastReportedSimTick) return;
  // Report every 2nd tick (plus every checksum tick): each report is a
  // compress+send, 60/s of which is real CPU on a mobile guest. The gating
  // window (INPUT_DELAY_TICKS=4) comfortably absorbs watermarks that are
  // one tick coarse.
  if (tick % 2 !== 0 && tick % LOCKSTEP_CKSUM_EVERY !== 0 && tick - lastReportedSimTick < 2) return;
  lastReportedSimTick = tick;
  let msg = { type: 'tick', t: tick };
  if (tick % LOCKSTEP_CKSUM_EVERY === 0 && DET.history.length) {
    let last = DET.history[DET.history.length - 1];
    msg.ct = last.tick;
    msg.h = last.sum;
  }
  sendToPeer(msg);
  lockstepAdaptDelay();
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
