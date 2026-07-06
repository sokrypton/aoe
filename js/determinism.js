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
  for (let i = 0; i < projectiles.length; i++) {
    let p = projectiles[i];
    h = detMix(h, p.id);
    h = detMixFloat(h, p.x); h = detMixFloat(h, p.y);
    h = detMixFloat(h, p.tx); h = detMixFloat(h, p.ty);
  }
  h = detMix(h, nextId);
  h = detMix(h, nextProjectileId);
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
      if (ai.intel) {
        h = detMix(h, ai.intel.strength || 0);
        h = detMix(h, ai.intel.tcSeen ? 1 : 0);
        for (let u = 0; u < NUM_TEAMS; u++) h = detMix(h, (ai.intel.strengthByTeam && ai.intel.strengthByTeam[u]) || 0);
      }
      if (ai.wallPlan) h = detMix(h, ai.wallPlan.reduce((s, p) => s + (p.done ? 1 : 0), 0));
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
