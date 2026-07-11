// ---- DETERMINISTIC LOCKSTEP WITH BOUNDED ROLLBACK (the only MP netcode) ----
// Every peer (host + up to 3 guests) runs the full simulation from the
// same seed and the same tick-stamped command stream (js/commands.js).
// The sim RUNS FREELY — it never waits for a peer. A command that arrives
// for a tick we already simulated triggers a rewind: restore the nearest
// snapshot before it, re-simulate to the present with the command in
// place (identical to what the on-time peer computed), and carry on.
// Lateness costs an invisible few-ms resim instead of a visible pause —
// RTS commands are sparse, so rollbacks are rare events, not a per-frame
// cost.
//
// TOPOLOGY: host-relay star (js/net.js). Guests only talk to the host;
// the host forwards each guest's cmd-ls/tick to the other guests stamped
// with the sender's seat (`from`). Command ORDER needs no sequencer — the
// canonical (team, seq) sort in runScheduledCommands makes arrival order
// irrelevant. The host IS authoritative for: match start config, resync/
// resume state, pause, and the seat a command is attributed to (a guest's
// own claim is never trusted; the host stamps from the connection's seat
// binding, and a guest trusts `from` because its only link is the host).
//
// Wire protocol (on top of js/net.js's envelope):
//   {type:'lockstep-start', ..., yourTeam}   host -> each guest: begin
//   {type:'cmd-ls', execTick, seq, cmd, [from]}  a command, already
//       world-space, stamped by the ISSUER at issueTick+delay.
//   {type:'tick', t, [ct, h], [from]}        ~10/s per peer: progress
//       report for loose drift control, plus a checksum h for an OLD tick
//       ct (old enough that no in-flight command can still rewrite it on
//       either side — see LOCKSTEP_CKSUM_LAG). Checksums are compared
//       host<->guest only; guest->guest relays carry just t.

let lockstepActive = false;
let peerSimTicks = new Map(); // seat/team -> that peer's last reported sim tick
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

function lockstepEnabled(){
  return lockstepActive && netRole != null;
}

function sendToAllPeers(msg){
  if (netRole === 'host') broadcastToGuests(msg);
  else if (netRole === 'guest') sendToHost(msg); // the host relays onward
}

// Host-side: human seats with no live connection right now (dropped
// mid-match, not yet rejoined). Drives the "waiting for <name>" pause.
function lockstepExpectedSeatsMissing(){
  let out = [];
  if (netRole !== 'host') return out;
  for (let t = 1; t < NUM_TEAMS; t++) {
    if (!teamControllers[t] || teamControllers[t].type !== 'human') continue;
    let rec = typeof netGuestBySeat === 'function' ? netGuestBySeat(t) : null;
    if (rec && rec.kicked) continue; // being handed to the AI — not awaited
    if (!rec || !rec.connected) out.push(t);
  }
  return out;
}

// The human seats this peer expects lockstep progress reports from. On
// the host that's every CONNECTED guest (a dropped guest must not wedge
// the pace gate — the pause flow owns that case); guests can't see
// connectivity, so they expect every human seat and rely on the host's
// pause broadcast when one goes missing.
function lockstepExpectedSeats(){
  let seats = [];
  for (let t = 0; t < NUM_TEAMS; t++) {
    if (t === myTeam) continue;
    if (!teamControllers[t] || teamControllers[t].type !== 'human') continue;
    if (netRole === 'host') {
      let rec = typeof netGuestBySeat === 'function' ? netGuestBySeat(t) : null;
      if (!rec || !rec.connected) continue;
    }
    seats.push(t);
  }
  return seats;
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
  peerSimTicks.clear();
  lastReportedSimTick = -1;
  lockstepDesyncedAt = null;
  lockstepRollbacks = 0;
  lockstepSnapshots.length = 0;
  INPUT_DELAY_TICKS = 4;
}

// Host side: begin a fresh lockstep match when the host clicks Start in the
// lobby (onLobbyStartClicked, js/lobby.js). Also reused verbatim by the Rematch
// path (onStartClicked, js/init.js) — which keeps the same lobbyState, so a
// rematch reuses the agreed names/colors/AI/settings.
function hostStartLockstepMatch(){
  lockstepActive = true;
  lockstepResetState();
  // Config comes from the lobby when there is one; fall back to the setup-menu
  // pickers otherwise (defensive — every live path today has a lobbyState).
  let ls = (typeof lobbyState !== 'undefined') ? lobbyState : null;
  NUM_TEAMS = ls ? (ls.numTeams || 2) : 2; // one team per lobby seat (2-4 humans/AI in any mix)
  let sizeKey = ls ? ls.mapSize : (function(){ let s = document.querySelector('input[name="mapsize"]:checked'); return s ? s.value : 'medium'; })();
  if (ls && typeof setGameSpeed === 'function') setGameSpeed(ls.speed);
  window.fogDisabled = false;
  // Each player's ALLIANCE drives the spawn adjacency (js/core.js
  // setMapSize) — every peer must build STARTS from the SAME array, so
  // it's taken from the lobby seats here and sent in lockstep-start below
  // for the guests to reuse.
  let al = (ls && ls.seats && typeof lobbySeatAlliances === 'function') ? lobbySeatAlliances() : undefined;
  setMapSize(sizeKey, al); // draws the fresh matchSeed all peers will share
  restartGame('standard');
  // The lobby's agreed seats become the authoritative team layout + cosmetic
  // names/colors. Must land AFTER restartGame (which reset them to defaults)
  // and BEFORE the seed snapshot/broadcast so both peers + the checksum agree.
  // An AI seat here is what makes host-vs-AI-over-a-connection just a data
  // change (the update() AI loop drives it — no protocol change).
  if (ls && typeof applyLobbyConfigToTeams === 'function') applyLobbyConfigToTeams();
  DET.enabled = true; // per-tick checksum ring for the exchange below
  lockstepSeedSnapshot();
  mpMatchStarted = true;
  window.__mpSession.inLobby = false;
  // Now that the match is truly underway, arm the host's ?host= resume URL
  // (js/init.js) and persist the seat<->token map it will need — not
  // before, so a lobby refresh doesn't auto-resume.
  if (typeof setHostResumeUrl === 'function') setHostResumeUrl();
  if (typeof persistMpSessionMap === 'function') persistMpSessionMap();
  // names/colors are COSMETIC (never hashed/snapshotted) but must reach the
  // guests so every screen renders the agreed labels/colors consistently.
  // Per-guest send: yourTeam is how each guest learns which seat it plays —
  // the ONE per-recipient field in an otherwise identical payload.
  let startPayload = { type: 'lockstep-start', seed: matchSeed, mapSize: sizeKey, speed: GAME_SPEED, numTeams: NUM_TEAMS, controllers: teamControllers, alliances: teamAlliance, names: teamNames, colors: teamColorMap };
  for (const s of netConnectedGuestSeats()) {
    sendToGuest(s, Object.assign({}, startPayload, { yourTeam: s }));
  }
}

onNetMessage((msg, src) => {
  if (msg.type === 'lockstep-start' && netRole === 'guest') {
    lockstepActive = true;
    lockstepResetState();
    window.fogDisabled = false;
    // Which seat this guest plays — assigned by the host (replaces the old
    // hardcoded guest=1). Must land before restartGame/fog/camera below,
    // all of which read myTeam.
    if (msg.yourTeam != null) { myTeam = msg.yourTeam; localHumanTeam = msg.yourTeam; }
    if (typeof setGameSpeed === 'function') setGameSpeed(msg.speed);
    NUM_TEAMS = msg.numTeams || 2; // before setMapSize (STARTS) and restartGame (sizing)
    window.__pendingMatchSeed = msg.seed;
    // Pass the host's alliance array so the guest builds identical 4-team
    // spawns (allies in adjacent corners — js/core.js setMapSize).
    setMapSize(msg.mapSize, msg.alliances);
    restartGame('standard');
    // Host's slot layout wins (restartGame derived a default from netRole).
    // Must land before the seed snapshot/checksums so both peers agree.
    if (msg.controllers) { teamControllers = msg.controllers; resetAIStates(); }
    if (msg.alliances) teamAlliance = msg.alliances; else resetTeamAlliance();
    // Cosmetic lobby names/colors (not part of the checksum) — apply so this
    // guest renders the agreed labels/colors, matching the host's screen.
    if (msg.colors) teamColorMap = msg.colors;
    if (msg.names) teamNames = msg.names;
    // The match is now truly underway — flip the gate the lobby deliberately
    // left off (js/init.js onNetConnectionOpen), and leave the lobby.
    mpMatchStarted = true;
    window.__mpSession.inLobby = false;
    DET.enabled = true;
    lockstepSeedSnapshot();
    gameStarted = true;
    gamePaused = false;
    // init() (via restartGame) centered the camera on TEAM 0's start — on
    // this guest that's the OPPONENT's base. Recenter on our own.
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
    // The issuer's team: on the host it's the SEAT the connection is bound
    // to (never whatever the payload claims); on a guest it's the host's
    // relay stamp (`from`), absent on the host's own commands (team 0).
    let peerTeam;
    if (netRole === 'host') {
      if (!src || src.seat == null) return; // unattributable — drop
      peerTeam = src.seat;
    } else {
      peerTeam = msg.from != null ? msg.from : 0;
    }
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
    // Adopt the host-assigned seat BEFORE the state apply — the fog
    // seeding and camera recenter below both read myTeam.
    if (msg.yourTeam != null) { myTeam = msg.yourTeam; localHumanTeam = msg.yourTeam; }
    if (typeof setGameSpeed === 'function') setGameSpeed(msg.speed);
    // A reconnecting guest is a fresh page with reset (identity/empty) name +
    // color defaults — re-apply the agreed cosmetics so it doesn't show the
    // wrong colors/names after resuming. Cosmetic, not part of the checksum.
    if (msg.colors) teamColorMap = msg.colors;
    if (msg.names) teamNames = msg.names;
    mpMatchStarted = true; // a resume means the match is live
    window.__mpSession.inLobby = false;
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
    // Attribute the report: connection seat on the host, relay stamp on a
    // guest (absent = the host's own report, seat 0).
    let seat = netRole === 'host' ? (src && src.seat) : (msg.from != null ? msg.from : 0);
    if (seat == null) return;
    if (msg.t > (peerSimTicks.get(seat) ?? -1)) peerSimTicks.set(seat, msg.t);
    // Checksums compare host<->guest only: the host checks every guest's
    // reports; a guest checks only the host's (the relay strips ct/h from
    // guest->guest forwards anyway — this guard is belt and braces).
    if (msg.h !== undefined && (netRole === 'host' || seat === 0)) {
      lockstepCheckPeerChecksum(msg.ct, msg.h);
    }
  }
});

// ---- Free-running pace control ----
// Returns the extra accumulator cost of one tick right now: 0 normally; a
// 25% surcharge when we are far ahead of the peer's last report (runs us
// ~20% slower so they catch up); Infinity when so far ahead that a peer
// command could fall outside the rollback window.
function lockstepTickSurcharge(){
  // Pace against the SLOWEST expected peer. Hold at the start line until
  // every one of them has reported at least once: the host starts a match
  // while guests are still applying the start state — running ahead
  // meanwhile leaves the sims permanently offset by the transit time,
  // making EVERY late peer's command a rollback (and early ones landed
  // before any snapshot existed: unrecoverable). Reports are time-based
  // (below), so all sides exchange t=0 and release together.
  let expected = lockstepExpectedSeats();
  if (expected.length === 0) return 0; // nobody live to pace against
  let minPeer = Infinity;
  for (const s of expected) {
    let pt = peerSimTicks.has(s) ? peerSimTicks.get(s) : -1;
    if (pt < minPeer) minPeer = pt;
  }
  if (minPeer < 0) return Infinity;
  let ahead = tick - minPeer;
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
  sendToAllPeers(msg);
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
    entities, projectiles, corpses, resources, map, marketPrices,
    popUsed, popCap, tick, gameOver, won,
    nextId, nextProjectileId, simRngState,
    bellRinging: window.bellRinging,
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
  if (st.marketPrices) marketPrices = st.marketPrices; // global commodity exchange (js/core.js)
  map = st.map;
  popUsed = st.popUsed; popCap = st.popCap;
  tick = st.tick;
  gameOver = st.gameOver; won = st.won;
  nextId = st.nextId; nextProjectileId = st.nextProjectileId;
  simRngState = st.simRngState;
  window.bellRinging = st.bellRinging;
  teamExploredGrid = st.exploredSim;
  restoreTeamState(st); // controllers/AI_STATES/lastTeamHit (js/core.js)
  bumpSimGen(); // tick rewound — invalidate every registered sim cache (js/core.js)
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
  // Corpse deathTime is performance.now()-epoch — meaningless on the peer's
  // clock (page-load relative). Ship ages instead, same as the save path
  // (js/save.js), and rebase on apply. Cosmetic only, but raw timestamps
  // rendered every corpse instantly skeletal after a resync/rejoin.
  st.corpses = st.corpses.map(c => ({...c, deathTime: undefined, ageAtSaveMs: performance.now() - c.deathTime}));
  // Plain JSON round-trip = exactly what the wire does, so the host applies
  // bit-identical state to what the guest receives. (No Set normalization
  // needed anymore: entity retry/avoid state is plain arrays/objects —
  // see the retry/avoid primitives in js/logic.js.)
  return JSON.parse(JSON.stringify(st));
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
  // Rebase shipped corpse ages onto THIS page's performance.now() epoch
  // (see lockstepBuildResyncState). Older peers/states without ageAtSaveMs
  // fall back to "just died".
  {
    let nowMs = performance.now();
    corpses = (state.corpses || []).map(c =>
      c.ageAtSaveMs !== undefined ? {...c, ageAtSaveMs: undefined, deathTime: nowMs - c.ageAtSaveMs} : c);
  }
  resources = state.resources;
  if (state.marketPrices) marketPrices = state.marketPrices; // global commodity exchange (js/core.js)
  map = state.map;
  popUsed = state.popUsed; popCap = state.popCap;
  tick = state.tick;
  gameOver = state.gameOver; won = state.won;
  nextId = state.nextId; nextProjectileId = state.nextProjectileId;
  simRngState = state.simRngState;
  window.bellRinging = state.bellRinging;
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
  bumpSimGen(); // tick jumped — invalidate every registered sim cache (js/core.js)
  selected = selected.map(u => entitiesById.get(u.id)).filter(Boolean);
  // Prune only commands at/before the resync point — NOT the whole queue.
  // Commands scheduled past it (our own just-submitted ones included) were
  // already sent on the wire, and the peer's stale-guard keeps anything
  // with execTick > barrier: it WILL execute them. Wiping them here made
  // the issuer skip commands the peer runs — an instant re-desync loop.
  commandQueue.forEach((v, t) => { if (t <= tick) commandQueue.delete(t); });
  lockstepSnapshots.length = 0;
  DET.history.length = 0;
  lockstepResyncBarrier = tick;
  lockstepSeedSnapshot();
  // Every expected peer is (about to be) at this tick — the resync/resume
  // sender applied the same state. Seeding the entries also releases the
  // pace gate without waiting a report round-trip, and refreshes any
  // stale entry left by a peer that was disconnected during the resync.
  peerSimTicks.clear();
  lockstepExpectedSeats().forEach(s => peerSimTicks.set(s, tick));
  lastReportedSimTick = tick;
  lockstepDesyncedAt = null;
  window.__lockstepDesync = undefined;
  gamePaused = false;
  if (typeof recomputeGamePaused === 'function') recomputeGamePaused();
  if (typeof showMsg === 'function') showMsg('Connection re-synchronized');
}

// Mid-match (re)join (the guest's page may be brand new): hand it the full
// sim state and re-enter lockstep — same machinery as desync recovery.
// Called from onNetConnectionOpen (js/init.js) on the host with the seat
// that just (re)connected; no seat means "resume everyone" (the ?host=
// crash-recovery path, js/net-sync.js). EVERY peer must apply the same
// JSON-normalized state — the resync barrier and post-normalization values
// diverge otherwise — so the other guests get it as a plain resync and the
// host self-applies.
function lockstepResumeGuest(seat){
  if (netRole !== 'host') return;
  let state = lockstepBuildResyncState();
  // Carry the cosmetic names/colors so a fresh reconnecting page re-shows
  // them (the resync `state` deliberately excludes them — not sim state),
  // and yourTeam so the page knows which seat it plays.
  for (const s of netConnectedGuestSeats()) {
    if (seat == null || s === seat) {
      sendToGuest(s, { type: 'lockstep-resume', state, speed: GAME_SPEED, names: teamNames, colors: teamColorMap, yourTeam: s });
    } else {
      sendToGuest(s, { type: 'lockstep-resync', state });
    }
  }
  lockstepApplyResync(state);
}

function lockstepStartResync(){
  if (netRole !== 'host') return;
  let state = lockstepBuildResyncState();
  broadcastToGuests({ type: 'lockstep-resync', state });
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
    else sendToHost({ type: 'lockstep-resync-request' });
    return;
  }
  window.__lockstepDesync = why; // tests assert this stays undefined
  if (typeof showMsg === 'function') showMsg('Desync detected — match halted (' + why + ')');
  gamePaused = true;
}
