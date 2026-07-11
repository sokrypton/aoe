// Determinism harness for lockstep multiplayer (see plan: deterministic
// lockstep replacing snapshot sync). Provides:
//   - simChecksum(): order-sensitive hash of all sim-relevant state, exact
//     float bits included, so two peers (or a live run vs a replay) can be
//     compared tick-by-tick.
//   - simEntityHashes(): per-entity sub-hashes for bisecting WHICH entity
//     diverged once a tick-level mismatch is found.
//   - DET.record*/DET.log: seed + per-tick command journal, dumpable and
//     replayable once commands are queue-scheduled.
//   - DET strict mode: while the sim tick runs, Math.random throws — catches
//     any sim call site that hasn't been migrated to the seeded sim PRNG.
// Everything is inert unless explicitly enabled; zero cost in normal play
// beyond one boolean check per tick.

const DET = {
  enabled: false,      // per-tick checksum history collection
  strict: false,       // Math.random tripwire during update()
  history: [],         // ring of {tick, sum} while enabled
  historyMax: 600,
  log: null,           // {seed, settings, commands:[{execTick, team, seq, cmd}]}
};

// FNV-1a-style 32-bit mix. Strings and floats are folded via their exact
// bits — 0.1+0.2 style drift MUST change the checksum, that's the point.
function detMix(h, v){
  h = (h ^ (v | 0)) >>> 0;
  return Math.imul(h, 0x01000193) >>> 0;
}
const _detF64 = new Float64Array(1);
const _detU32 = new Uint32Array(_detF64.buffer);
function detMixFloat(h, v){
  _detF64[0] = v;
  return detMix(detMix(h, _detU32[0]), _detU32[1]);
}
function detMixStr(h, s){
  if (s == null) return detMix(h, 0x9e3779b9);
  for (let i = 0; i < s.length; i++) h = detMix(h, s.charCodeAt(i));
  return h;
}

// Hash one entity's sim-relevant fields. Deliberately excludes cosmetic /
// local-only fields (smoothX/Y, animation phase, selection). Extend this
// when new sim state is added to entities — anything the sim READS on later
// ticks must be here, or desyncs in it will go undetected.
function detEntityHash(e){
  let h = 0x811c9dc5;
  h = detMix(h, e.id);
  h = detMixStr(h, e.type);
  h = detMixStr(h, e.btype || e.utype);
  h = detMix(h, e.team);
  h = detMixFloat(h, e.x);
  h = detMixFloat(h, e.y);
  h = detMixFloat(h, e.hp);
  h = detMixStr(h, e.task);
  h = detMix(h, e.target == null ? -1 : e.target);
  h = detMix(h, e.buildTarget == null ? -1 : e.buildTarget);
  h = detMix(h, e.garrisonTarget == null ? -1 : e.garrisonTarget);
  h = detMix(h, e.followId == null ? -1 : e.followId);
  h = detMix(h, e.path ? e.path.length : -1);
  h = detMixFloat(h, e.moveT || 0);
  h = detMixFloat(h, e.progress || 0);
  h = detMixFloat(h, e.carrying || 0);
  h = detMixStr(h, e.carryType);
  h = detMix(h, e.cooldown || 0);
  h = detMix(h, e.garrisonedIn == null ? -1 : e.garrisonedIn);
  h = detMix(h, e.complete ? 1 : 0);
  // Age research rides the TC entity — hash it so a divergent research
  // clock trips the checksum before it silently lands a mistimed age-up.
  h = detMix(h, e.research ? e.research.tick : -1);
  h = detMix(h, e.research ? e.research.target : -1);
  h = detMix(h, e.leashCooling ? 1 : 0); // bear leash hysteresis (sim-read)
  // Fields the sim reads on later ticks that previously went unhashed — a
  // divergence here only tripped the checksum once it eventually moved
  // hp/x/y, often far outside the resync window.
  h = detMixFloat(h, e.atk || 0);                 // age-up sweep mutates this
  h = detMix(h, e.exhausted ? 1 : 0);             // farm lifecycle
  h = detMix(h, e.trainTick || 0);                // training clock
  h = detMixFloat(h, e.buildProgress || 0);       // construction clock
  h = detMix(h, e.rallyX == null ? -1 : e.rallyX);
  h = detMix(h, e.rallyY == null ? -1 : e.rallyY);
  h = detMix(h, e.rallyTargetId == null ? -1 : e.rallyTargetId);
  if (e.queue) { h = detMix(h, e.queue.length); for (let i = 0; i < e.queue.length; i++) h = detMixStr(h, e.queue[i]); }
  h = detMix(h, e.gatherX == null ? -2 : e.gatherX); // villager tile claims steer OTHER villagers
  h = detMix(h, e.gatherY == null ? -2 : e.gatherY);
  h = detMix(h, e.explicitAttack ? 1 : 0);
  h = detMixFloat(h, e.defendX || 0);
  h = detMixFloat(h, e.defendY || 0);
  h = detMixFloat(h, e.guardX == null ? -1 : e.guardX); // guard flag pins the anchor
  h = detMixFloat(h, e.guardY == null ? -1 : e.guardY);
  h = detMix(h, e.guardTargetId == null ? -1 : e.guardTargetId); // escort target
  h = detMix(h, e.savedTask ? 1 : 0);
  h = detMix(h, e.buildBackoffUntil || 0); // AI assigners read this on later ticks
  // Retry/throttle/avoid umbrellas (js/logic.js retryFail/avoidAdd): they
  // decide WHICH TICK pathfinding and give-up fire on — unhashed, a
  // divergence is invisible until it has already moved a position. Sorted
  // keys so JSON round-trips can't reorder the hash.
  if (e.retry) for (const k of Object.keys(e.retry).sort()) {
    h = detMixStr(h, k); h = detMix(h, e.retry[k].n); h = detMix(h, e.retry[k].next);
  }
  if (e.avoid) for (const k of Object.keys(e.avoid).sort()) {
    h = detMixStr(h, k); const a = e.avoid[k];
    h = detMix(h, a.length); for (let i = 0; i < a.length; i++) h = detMix(h, a[i]);
  }
  h = detMixFloat(h, e.moveGoalX == null ? -1 : e.moveGoalX); // multi-leg move goal
  h = detMixFloat(h, e.moveGoalY == null ? -1 : e.moveGoalY);
  h = detMixStr(h, e.prevTask);
  h = detMix(h, e.siegeSpot ? e.siegeSpot.x * 4096 + e.siegeSpot.y : -1); // cross-unit melee-ring claims
  // Stuck-watchdog watch entry (it force-clears tasks, so WHEN it fires is
  // sim state — see updateStuckWatchdog, js/logic.js).
  h = detMix(h, e.fledBearId == null ? -1 : e.fledBearId); // bear-hunt trigger (js/ai.js reads it)
  h = detMix(h, e.stepWait || 0); // blocked-lane wait counter (stepBlocked, js/pathfinding.js)
  h = detMixFloat(h, e.groupSpeed || 0); // formation pace cap (unitMoveSpeed, js/logic.js)
  h = detMix(h, e.stuck ? e.stuck.since : -1);
  h = detMixStr(h, e.stuck && e.stuck.sig);
  // Chase-progress watch (combatApproach, js/logic.js): decides WHEN a unit
  // gives up a target it can't advance on, so it's sim state.
  h = detMix(h, e.chaseProg ? e.chaseProg.since : -1);
  h = detMix(h, e.chaseProg ? e.chaseProg.id : -2);
  h = detMix(h, e.lastAtkTick == null ? -1 : e.lastAtkTick); // gates stuck-watchdog (js/logic.js)
  // Trade cart route (updateTradeCart, js/logic.js): which Markets it shuttles
  // between and which leg it's on decide its pathing and gold delivery on later
  // ticks — unhashed, a diverged route is invisible until it moves gold/position.
  h = detMix(h, e.tradeHomeId == null ? -1 : e.tradeHomeId);
  h = detMix(h, e.tradeDestId == null ? -1 : e.tradeDestId);
  h = detMixStr(h, e.tradePhase);
  h = detMix(h, e.autoScout ? 1 : 0); // player Auto Scout mode (re-paths each tick, js/logic.js)
  return h >>> 0;
}

// Full sim-state checksum for the current tick. Order-sensitive over the
// entities array (array order IS sim state under lockstep).
function simChecksum(){
  let h = 0x811c9dc5;
  h = detMix(h, tick);
  for (let i = 0; i < entities.length; i++) h = detMix(h, detEntityHash(entities[i]));
  for (let t = 0; t < resources.length; t++) {
    let r = resources[t];
    h = detMixFloat(h, r.food); h = detMixFloat(h, r.wood);
    h = detMixFloat(h, r.gold); h = detMixFloat(h, r.stone);
    h = detMix(h, r.prepaidFarms || 0);
  }
  // Global commodity exchange prices (marketPrices, js/core.js) — shared sim
  // state mutated by execMarketTrade; a diverged price desyncs every future
  // buy/sell. Guarded for older states without a market.
  if (typeof marketPrices !== 'undefined' && marketPrices) {
    h = detMix(h, marketPrices.food); h = detMix(h, marketPrices.wood); h = detMix(h, marketPrices.stone);
  }
  for (let i = 0; i < projectiles.length; i++) {
    let p = projectiles[i];
    h = detMix(h, p.id);
    h = detMixFloat(h, p.x); h = detMixFloat(h, p.y);
    h = detMixFloat(h, p.tx); h = detMixFloat(h, p.ty);
  }
  // Map tiles: terrain + remaining resources are sim state (gather
  // depletion, farm exhaust/reseed rewrite them) — unhashed, a divergent
  // tree stump only surfaced when some unit's position later differed.
  for (let y = 0; y < MAP; y++) {
    let row = map[y];
    for (let x = 0; x < MAP; x++) {
      h = detMix(h, row[x].t);
      if (row[x].res) h = detMixFloat(h, row[x].res);
    }
  }
  h = detMix(h, nextId);
  h = detMix(h, nextProjectileId);
  // popUsed/popCap are deliberately NOT hashed: they are viewer-relative
  // caches of teamPopUsed(myTeam), legitimately different on host vs guest.
  // Seeded sim PRNG state (added with the PRNG migration); tolerate absence
  // so the harness works before that lands.
  if (typeof simRngState !== 'undefined') h = detMix(h, simRngState);
  // Per-team controllers + AI plan state (js/core.js): sim state — a
  // host/guest settings disagreement or an AI brain diverging under
  // rollback must trip the checksum instead of surfacing as slow mystery
  // desync. Scalar digest only (intel counts/wall progress fold into it).
  h = detMix(h, NUM_TEAMS);
  for (let t = 0; t < NUM_TEAMS; t++) {
    let c = teamControllers[t];
    h = detMix(h, c && c.type === 'ai' ? 1 : 0);
    let ai = AI_STATES && AI_STATES[t];
    if (ai) {
      h = detMix(h, ai.tick);
      h = detMix(h, ai.waveCount);
      h = detMix(h, ai.gateBuilt ? 1 : 0);
      h = detMix(h, ai.lastWaveTick == null ? -1 : ai.lastWaveTick);
      h = detMix(h, ai.lastWaveGlobalTick == null ? -1 : ai.lastWaveGlobalTick);
      h = detMix(h, ai.savingForAge ? 1 : 0);
      h = detMix(h, ai.lastAgeUpTick == null ? -1 : ai.lastAgeUpTick);
      h = detMix(h, ai.resignScore || 0);
      if (ai.intel) {
        h = detMix(h, ai.intel.strength || 0);
        h = detMix(h, ai.intel.tcSeen ? 1 : 0);
        for (let u = 0; u < NUM_TEAMS; u++) h = detMix(h, (ai.intel.strengthByTeam && ai.intel.strengthByTeam[u]) || 0);
      }
      if (ai.wallPlan) h = detMix(h, ai.wallPlan.reduce((s, p) => s + (p.done ? 1 : 0), 0));
      if (ai.dangerZones) for (const z of ai.dangerZones) { h = detMix(h, z.x); h = detMix(h, z.y); h = detMix(h, z.until); h = detMix(h, z.bearId || -1); }
    }
    let hit = lastTeamHit && lastTeamHit[t];
    h = detMix(h, hit ? hit.tick : -1);
    h = detMix(h, allianceOf(t));
    h = detMix(h, defeatedTeams && defeatedTeams[t] ? 1 : 0);
    h = detMix(h, teamAge && teamAge[t] || 0);
  }
  return h >>> 0;
}

// Per-entity hash list: when peers disagree on simChecksum at tick T, diff
// these arrays to find the first divergent entity instead of eyeballing
// the whole world.
function simEntityHashes(){
  return entities.map(e => ({ id: e.id, h: detEntityHash(e) }));
}

// Called from update() once per completed sim tick when DET.enabled.
function detAfterTick(){
  DET.history.push({ tick: tick, sum: simChecksum() });
  if (DET.history.length > DET.historyMax) DET.history.shift();
}

// ---- Command journal (replay) ----
// detStartLog at match start (records the sim seed once the PRNG lands);
// detRecordCommand from the command queue's enqueue path so a full game is
// reproducible as {seed, settings, commands}.
function detStartLog(seed, settings){
  DET.log = { seed: seed, settings: settings || {}, commands: [] };
}
function detRecordCommand(execTick, team, seq, cmd){
  if (DET.log) DET.log.commands.push({ execTick: execTick, team: team, seq: seq, cmd: cmd });
}
function detDumpLog(){
  return JSON.stringify(DET.log);
}

// ---- Math.random tripwire ----
// While the sim tick runs in strict mode, any un-migrated Math.random call
// site throws immediately with a stack pointing at the offender. Cosmetic
// code running outside update() is unaffected.
const _detRealRandom = Math.random;
function detEnterSim(){
  if (!DET.strict) return;
  Math.random = function(){
    detExitSim(); // restore before throwing so cosmetic code keeps working after the trap fires
    throw new Error('DET: Math.random called inside sim tick — migrate this call site to simRandom()');
  };
}
function detExitSim(){
  Math.random = _detRealRandom;
}
