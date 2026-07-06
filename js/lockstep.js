// ---- DETERMINISTIC LOCKSTEP WITH BOUNDED ROLLBACK (opt-in via ?lockstep) ----
// Both peers run the full simulation from the same seed and the same
// tick-stamped command stream (js/commands.js). The sim RUNS FREELY — it
// never waits for the peer. A command that arrives for a tick we already
// simulated triggers a rewind: restore the nearest snapshot before it,
// re-simulate to the present with the command in place (identical to what
// the on-time peer computed), and carry on. Lateness costs an invisible
// few-ms resim instead of a visible pause — RTS commands are sparse, so
// rollbacks are rare events, not a per-frame cost.
//
// Wire protocol (on top of js/net.js's envelope):
//   {type:'lockstep-start', seed, mapSize, speed}   host -> guest: begin
//   {type:'cmd-ls', execTick, seq, cmd}             both ways: a command,
//       already world-space, stamped by the ISSUER at issueTick+delay.
//   {type:'tick', t, [ct, h]}                       both ways, ~10/s:
//       progress report for loose drift control, plus a checksum h for an
//       OLD tick ct (old enough that no in-flight command can still
//       rewrite it on either side — see LOCKSTEP_CKSUM_LAG).

let lockstepActive = false;
let peerSimTick = -1;
let lastReportedSimTick = -1;
let lockstepDesyncedAt = null;
let lockstepRollbacks = 0; // stats: rewinds this match

// Report every 6th tick (~10/s at default speed): enough for drift control
// and checksum exchange; per-message compress+send is real CPU on mobile.
const LOCKSTEP_REPORT_EVERY = 6;
// Checksums are only exchanged for ticks at least this old: any command
// that could rewrite history at tick T arrives within the rollback window,
// so by T + LAG both peers' values for T are final.
const LOCKSTEP_CKSUM_LAG = 90;
// Snapshot ring: every SNAP_EVERY ticks, keep SNAP_KEEP — a ~5s rewind
// window (300 ticks). A command later than that means the connection was
// effectively dead longer than the net-layer heartbeat tolerates anyway.
const LOCKSTEP_SNAP_EVERY = 10;
const LOCKSTEP_SNAP_KEEP = 30;
// Drift control (soft): if we're more than SOFT ticks ahead of the peer's
// last report, run at ~80% speed so they catch up; HARD is a stop — only
// reachable if the peer is truly wedged (their reports stopped arriving,
// which the net heartbeat will surface as a disconnect shortly after).
const LOCKSTEP_SOFT_AHEAD = 45;
const LOCKSTEP_HARD_AHEAD = 240;

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

function lockstepResetState(){
  peerSimTick = -1;
  lastReportedSimTick = -1;
  lockstepDesyncedAt = null;
  lockstepRollbacks = 0;
  lockstepSnapshots.length = 0;
  INPUT_DELAY_TICKS = 4;
}

// Host side: begin a fresh lockstep match the moment the guest connects.
function hostStartLockstepMatch(){
  lockstepActive = true;
  lockstepResetState();
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
    lockstepResetState();
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
    scheduleCommand(msg.execTick, peerTeam, msg.seq, msg.cmd);
    if (msg.execTick <= tick) {
      // Late: that tick already ran without this command. Rewind and replay
      // with it in place — converges with what the peer computed on time.
      lockstepRollback(msg.execTick);
    }
  } else if (msg.type === 'tick' && lockstepActive) {
    if (msg.t > peerSimTick) peerSimTick = msg.t;
    if (msg.h !== undefined) lockstepCheckPeerChecksum(msg.ct, msg.h);
  }
});

// ---- Free-running pace control ----
// Returns the extra accumulator cost of one tick right now: 0 normally; a
// 25% surcharge when we are far ahead of the peer's last report (runs us
// ~20% slower so they catch up); Infinity when so far ahead that a peer
// command could fall outside the rollback window.
function lockstepTickSurcharge(){
  if (peerSimTick < 0) return 0; // no report yet (match start)
  let ahead = tick - peerSimTick;
  if (ahead > LOCKSTEP_HARD_AHEAD) return Infinity;
  if (ahead > LOCKSTEP_SOFT_AHEAD) return timeStep * 0.25;
  return 0;
}

// After simming: progress report + old-enough checksum, throttled.
function lockstepReport(){
  if (tick - lastReportedSimTick < LOCKSTEP_REPORT_EVERY) return;
  lastReportedSimTick = tick;
  let msg = { type: 'tick', t: tick };
  // Attach the newest history entry that is safely beyond rollback reach.
  for (let i = DET.history.length - 1; i >= 0; i--) {
    if (DET.history[i].tick <= tick - LOCKSTEP_CKSUM_LAG) {
      msg.ct = DET.history[i].tick;
      msg.h = DET.history[i].sum;
      break;
    }
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

// ---- Snapshot ring + rollback ----
let lockstepSnapshots = []; // {t, state} — state captured AFTER simming tick t

function lockstepCaptureState(){
  return structuredClone({
    entities, projectiles, corpses, resources, map,
    popUsed, popCap, tick, gameOver, won,
    nextId, nextProjectileId, simRngState,
    bellRinging: window.bellRinging,
    stuckWatch: snapshotStuckWatch(),
    exploredSim: teamExploredGrid, // Uint8Arrays clone fine
  });
}

function lockstepTakeSnapshot(){
  if (tick % LOCKSTEP_SNAP_EVERY !== 0) return;
  lockstepSnapshots.push({ t: tick, state: lockstepCaptureState() });
  if (lockstepSnapshots.length > LOCKSTEP_SNAP_KEEP) lockstepSnapshots.shift();
}

function lockstepRestore(snap){
  // Clone again so the ring copy stays pristine for a future rollback.
  let st = structuredClone(snap.state);
  entities = st.entities;
  entitiesById.clear();
  entities.forEach(e => entitiesById.set(e.id, e));
  projectiles = st.projectiles;
  corpses = st.corpses;
  resources = st.resources;
  map = st.map;
  popUsed = st.popUsed; popCap = st.popCap;
  tick = st.tick;
  gameOver = st.gameOver; won = st.won;
  nextId = st.nextId; nextProjectileId = st.nextProjectileId;
  simRngState = st.simRngState;
  window.bellRinging = st.bellRinging;
  restoreStuckWatch(st.stuckWatch);
  teamExploredGrid = st.exploredSim;
  visionFreshTick = -1; // force vision/fog recompute on the next tick
  // UI object references now point at pre-restore objects — re-resolve by id.
  selected = selected.map(u => entitiesById.get(u.id)).filter(Boolean);
  // History beyond the restore point gets recomputed during resim.
  while (DET.history.length && DET.history[DET.history.length - 1].tick > tick) DET.history.pop();
}

// Rewind so that execTick runs with the (just-scheduled) late command, then
// re-simulate back to the present. window.__resim suppresses cosmetic side
// effects (sounds, messages, particles) — those moments already played out
// on this screen once.
function lockstepRollback(execTick){
  if (lockstepDesyncedAt != null) return;
  let snap = null;
  for (let i = lockstepSnapshots.length - 1; i >= 0; i--) {
    if (lockstepSnapshots[i].t <= execTick - 1) { snap = lockstepSnapshots[i]; break; }
  }
  if (!snap) {
    lockstepFatal('command for tick ' + execTick + ' older than the rollback window (at ' + tick + ')');
    return;
  }
  let target = tick;
  lockstepSnapshots = lockstepSnapshots.filter(s => s.t <= snap.t);
  lockstepRestore(snap);
  lockstepRollbacks++;
  window.__resim = true;
  try {
    while (tick < target && !gameOver) {
      update();
      lockstepTakeSnapshot(); // re-fill the ring along the corrected timeline
    }
  } finally {
    window.__resim = false;
  }
}

// Desync is a bug, full stop (the whole determinism workstream exists so
// this never fires). Policy: freeze loudly and keep the evidence —
// automated recovery (full-snapshot restore) is a later phase.
function lockstepFatal(why){
  if (lockstepDesyncedAt != null) return;
  lockstepDesyncedAt = tick;
  window.__lockstepDesync = why; // tests assert this stays undefined
  console.error('LOCKSTEP DESYNC @ tick ' + tick + ': ' + why);
  if (typeof showMsg === 'function') showMsg('Desync detected — match halted (' + why + ')');
  gamePaused = true;
}
