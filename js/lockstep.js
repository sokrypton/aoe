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
// Snapshot ring: every SNAP_EVERY ticks, keep SNAP_KEEP — a ~5s rewind
// window (300 ticks). A command later than that means the connection was
// effectively dead longer than the net-layer heartbeat tolerates anyway.
const LOCKSTEP_SNAP_EVERY = 10;
const LOCKSTEP_SNAP_KEEP = 30;
// Checksums are only exchanged for ticks at least a full ROLLBACK WINDOW
// old: any command that can still legally rewrite tick T arrives within
// the window, so only then is T final on both sides. (This was 90 ticks —
// less than the window — and a single latency spike delivering a command
// 90-300 ticks late rewrote already-exchanged history: a FALSE desync
// alarm that froze a healthy match.)
const LOCKSTEP_CKSUM_LAG = LOCKSTEP_SNAP_EVERY * LOCKSTEP_SNAP_KEEP;
// Drift control (soft): if we're more than SOFT ticks ahead of the peer's
// last report, run at ~80% speed so they catch up; HARD is a stop — only
// reachable if the peer is truly wedged (their reports stopped arriving,
// which the net heartbeat will surface as a disconnect shortly after).
const LOCKSTEP_SOFT_AHEAD = 45;
const LOCKSTEP_HARD_AHEAD = 240;

// Lockstep is the DEFAULT for new multiplayer matches; ?legacy-sync on the
// host's page forces the old host-authoritative snapshot mode (escape
// hatch for one release). The guest follows whatever the host starts.
// Captured at load time — hosting rewrites location.search to the ?host=
// resume link, which would otherwise drop the flag mid-session.
const LEGACY_SYNC_URL_FLAG = typeof window !== 'undefined' && /[?&]legacy-sync\b/.test(window.location.search);
function lockstepRequested(){
  return !LEGACY_SYNC_URL_FLAG;
}
function lockstepEnabled(){
  return lockstepActive && netRole != null;
}

function sendToPeer(msg){
  if (netRole === 'host') broadcastToGuest(msg);
  else if (netRole === 'guest') sendToHost(msg);
}

// Seed the ring with the CURRENT state so a command stamped for the very
// first ticks is still inside the rollback window.
function lockstepSeedSnapshot(){
  lockstepSnapshots.length = 0;
  lockstepSnapshots.push({ t: tick, state: lockstepCaptureState() });
}

function lockstepResetState(){
  lockstepResyncBarrier = -1;
  lockstepResyncCount = 0;
  lastResyncAt = 0;
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
  NUM_TEAMS = 2; // MP is strictly 1v1 — incl. the rematch path, which skips onHostClicked
  let sizeSel = document.querySelector('input[name="mapsize"]:checked');
  let sizeKey = sizeSel ? sizeSel.value : 'medium';
  window.fogDisabled = false;
  setMapSize(sizeKey); // draws the fresh matchSeed both peers will share
  restartGame('standard');
  DET.enabled = true; // per-tick checksum ring for the exchange below
  lockstepSeedSnapshot();
  // controllers: the host's slot layout is authoritative — today always
  // [human, human], but the guest applies whatever arrives, so AI slots in
  // MP become a host-side data change, not a protocol change.
  broadcastToGuest({ type: 'lockstep-start', seed: matchSeed, mapSize: sizeKey, speed: GAME_SPEED, numTeams: NUM_TEAMS, controllers: teamControllers, alliances: teamAlliance });
}

onNetMessage((msg) => {
  if (msg.type === 'lockstep-start' && netRole === 'guest') {
    lockstepActive = true;
    lockstepResetState();
    window.fogDisabled = false;
    if (typeof setGameSpeed === 'function') setGameSpeed(msg.speed);
    NUM_TEAMS = msg.numTeams || 2; // before setMapSize (STARTS) and restartGame (sizing)
    window.__pendingMatchSeed = msg.seed;
    setMapSize(msg.mapSize);
    restartGame('standard');
    // Host's slot layout wins (restartGame derived a default from netRole).
    // Must land before the seed snapshot/checksums so both peers agree.
    if (msg.controllers) { teamControllers = msg.controllers; resetAIStates(); }
    if (msg.alliances) teamAlliance = msg.alliances; else resetTeamAlliance();
    DET.enabled = true;
    lockstepSeedSnapshot();
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
    // Commands from before a resync point are stale on BOTH sides — the
    // resync state already reflects (or deliberately drops) them.
    if (msg.execTick <= lockstepResyncBarrier) return;
    // The peer's team: guest commands land on the host as team 1 and vice
    // versa — never trusted from the wire.
    let peerTeam = netRole === 'host' ? 1 : 0;
    scheduleCommand(msg.execTick, peerTeam, msg.seq, msg.cmd);
    if (msg.execTick <= tick) {
      // Late: that tick already ran without this command. Rewind and replay
      // with it in place — converges with what the peer computed on time.
      lockstepRollback(msg.execTick);
    }
  } else if (msg.type === 'lockstep-resync' && netRole === 'guest' && lockstepActive) {
    lockstepApplyResync(msg.state);
  } else if (msg.type === 'lockstep-resume' && netRole === 'guest') {
    // (Re)joining a lockstep match already in progress — fresh page or a
    // reconnect after a drop. Enter lockstep mode around the state apply.
    lockstepActive = true;
    lockstepResetState();
    if (typeof setGameSpeed === 'function') setGameSpeed(msg.speed);
    DET.enabled = true;
    gameStarted = true;
    lockstepApplyResync(msg.state);
    if (!window.__mpSession.cameraCentered) {
      let own = entities.find(e => e.team === myTeam);
      if (own) {
        let iso = toIso(own.x, own.y);
        camX = iso.ix; camY = iso.iy;
        window.targetCamX = camX; window.targetCamY = camY;
        window.__mpSession.cameraCentered = true;
      }
    }
    if (typeof hideDisconnectOverlay === 'function') hideDisconnectOverlay();
    disconnectedPause = false;
    if (typeof recomputeGamePaused === 'function') recomputeGamePaused();
    let menu = document.getElementById('tutorial');
    if (menu) menu.style.display = 'none';
    if (typeof restoreMenuForMatch === 'function') restoreMenuForMatch();
    if (typeof showMpStatus === 'function') showMpStatus('Reconnected! Match resumed.');
  } else if (msg.type === 'lockstep-resync-request' && netRole === 'host' && lockstepActive) {
    lockstepStartResync();
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
  // Hold at the start line until the peer's first report: the host starts
  // a match while the guest is still applying the start state — running
  // ahead meanwhile leaves the two sims permanently offset by the transit
  // time, making EVERY guest command a rollback (and early ones landed
  // before any snapshot existed: unrecoverable). Reports are time-based
  // (below), so both sides exchange t=0 and release together.
  if (peerSimTick < 0) return Infinity;
  let ahead = tick - peerSimTick;
  if (ahead > LOCKSTEP_HARD_AHEAD) return Infinity;
  if (ahead > LOCKSTEP_SOFT_AHEAD) return timeStep * 0.25;
  return 0;
}

// After each frame: progress report + old-enough checksum. Throttled by
// tick progress, with a time floor so a peer holding at the start line
// (or stalled) still announces itself — without it, both sides would wait
// at tick 0 for the other's first report forever.
let lastReportWallMs = 0;
function lockstepReport(){
  let nowMs = performance.now();
  if (tick - lastReportedSimTick < LOCKSTEP_REPORT_EVERY && nowMs - lastReportWallMs < 250) return;
  lastReportedSimTick = tick;
  lastReportWallMs = nowMs;
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
    // Per-team controller + AI plan state: SIM state (an AI team's brain
    // must rewind with a rollback and agree across peers — plain data,
    // clones fine). Same for lastTeamHit (AI garrison signal, js/core.js).
    teamControllers, aiStates: AI_STATES, lastTeamHit, teamAlliance, defeatedTeams, teamAge,
    // Sim-relevant (gates buildingVisibleToTeam etc.) — both peers must
    // agree, e.g. after the host loads a fog-disabled save mid-match.
    fogDisabled: !!window.fogDisabled,
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
  restoreTeamState(st); // controllers/AI_STATES/lastTeamHit (js/core.js)
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

// Desync recovery: the host snapshots its full sim state (normalized
// through the same JSON round-trip the wire applies, so both peers end up
// bit-identical), applies it to ITSELF, and sends it to the guest. Both
// drop queued/in-flight commands older than the resync point. Costs a
// brief hiccup instead of freezing the match. Rate-limited; a match that
// keeps desyncing still freezes loudly so the bug gets reported.
let lockstepResyncBarrier = -1; // drop stale cmd-ls at/below this tick
let lockstepResyncCount = 0, lastResyncAt = 0;
const LOCKSTEP_MAX_RESYNCS = 5;

function lockstepBuildResyncState(){
  let st = lockstepCaptureState();
  st.exploredSim = st.exploredSim.map(g => Array.from(g));
  st.stuckWatch = Array.from(st.stuckWatch.entries());
  // Same Set->null normalization the save/wire path uses (js/save.js):
  // the sim treats a missing Set as empty and rebuilds it.
  return JSON.parse(JSON.stringify(st, (k, v) => v instanceof Set ? null : v));
}

function lockstepApplyResync(state){
  // A reconnecting guest is a fresh page that skipped init(): size-derived
  // and viewer-local structures don't exist yet. MAP must be set before
  // anything indexes the restored map, and fog is per-viewer (never part
  // of sim state) so it's rebuilt empty and recomputed next tick.
  MAP = state.map.length;
  // Before initFog(): it seeds the whole grid as revealed when fog is off.
  if (state.fogDisabled !== undefined) window.fogDisabled = !!state.fogDisabled;
  if (!fog.length || fog.length !== MAP) initFog();
  if (!window.bellRinging) window.bellRinging = Array.from({length: NUM_TEAMS}, () => false);
  entities = state.entities;
  entitiesById.clear();
  entities.forEach(e => entitiesById.set(e.id, e));
  projectiles = state.projectiles;
  corpses = state.corpses || [];
  resources = state.resources;
  map = state.map;
  popUsed = state.popUsed; popCap = state.popCap;
  tick = state.tick;
  gameOver = state.gameOver; won = state.won;
  nextId = state.nextId; nextProjectileId = state.nextProjectileId;
  simRngState = state.simRngState;
  window.bellRinging = state.bellRinging;
  restoreStuckWatch(new Map(state.stuckWatch || []));
  teamExploredGrid = state.exploredSim.map(g => Uint8Array.from(g));
  restoreTeamState(state); // controllers/AI_STATES/lastTeamHit (js/core.js)
  // A rejoining guest's fog was just rebuilt empty (fresh page) — its
  // explored memory only survives in the sim's explored grid. Seed fog=1
  // from our team's grid; a no-op for tiles already explored/visible, so
  // it's safe on a peer whose fog was never lost (incl. the host itself).
  const myEg = teamExploredGrid[myTeam];
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      if (fog[y][x] === 0 && myEg[y * MAP + x] === 1) fog[y][x] = 1;
    }
  }
  visionFreshTick = -1;
  selected = selected.map(u => entitiesById.get(u.id)).filter(Boolean);
  clearCommandQueue();
  lockstepSnapshots.length = 0;
  DET.history.length = 0;
  lockstepResyncBarrier = tick;
  lockstepSeedSnapshot();
  peerSimTick = tick;
  lastReportedSimTick = tick;
  lockstepDesyncedAt = null;
  window.__lockstepDesync = undefined;
  gamePaused = false;
  if (typeof recomputeGamePaused === 'function') recomputeGamePaused();
  if (typeof showMsg === 'function') showMsg('Connection re-synchronized');
}

// Mid-match reconnect (the guest's page may be brand new): hand it the
// full sim state and re-enter lockstep — same machinery as desync
// recovery. Called from onNetConnectionOpen (js/init.js) on the host.
function lockstepResumeGuest(){
  if (netRole !== 'host') return;
  let state = lockstepBuildResyncState();
  broadcastToGuest({ type: 'lockstep-resume', state, speed: GAME_SPEED });
  lockstepApplyResync(state);
}

function lockstepStartResync(){
  if (netRole !== 'host') return;
  let state = lockstepBuildResyncState();
  broadcastToGuest({ type: 'lockstep-resync', state });
  lockstepApplyResync(state); // host passes through the same normalization
}

function lockstepFatal(why){
  if (lockstepDesyncedAt != null) return;
  lockstepDesyncedAt = tick;
  console.error('LOCKSTEP DESYNC @ tick ' + tick + ': ' + why);
  // Attempt automatic recovery (host authoritative for the resync state).
  let nowMs = performance.now();
  if (lockstepResyncCount < LOCKSTEP_MAX_RESYNCS && (lastResyncAt === 0 || nowMs - lastResyncAt > 10000)) {
    lockstepResyncCount++;
    lastResyncAt = nowMs;
    if (typeof showMsg === 'function') showMsg('Connection hiccup — re-synchronizing…');
    if (netRole === 'host') lockstepStartResync();
    else sendToPeer({ type: 'lockstep-resync-request' });
    return;
  }
  window.__lockstepDesync = why; // tests assert this stays undefined
  if (typeof showMsg === 'function') showMsg('Desync detected — match halted (' + why + ')');
  gamePaused = true;
}
