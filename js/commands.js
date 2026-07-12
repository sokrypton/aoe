// ---- TICK-SCHEDULED COMMAND QUEUE (lockstep substrate) ----
// Every player action is resolved to a WORLD-SPACE command object on the
// issuing client (screen->tile, unit-under-cursor, etc. all happen at input
// time, against the issuer's own viewport and fog), then scheduled to
// execute at an agreed future tick instead of mutating state mid-frame.
//
//   resolver (input.js/ui.js)  ->  submitCommand(cmd)  ->  commandQueue
//   update() tick T            ->  runScheduledCommands(): exec all cmds
//                                  stamped T in canonical (team, seq) order
//
// This gives every mutation a deterministic execution point: the same
// commands at the same ticks produce the same sim on every peer — the
// foundation for both-peers-simulate lockstep (and for replays, see
// detRecordCommand in js/determinism.js).
//
// Roles (lockstep): every peer schedules its OWN commands locally at
// tick+delay and mirrors them to the other peer as 'cmd-ls'
// (js/lockstep.js), which schedules them at the same issuer-stamped tick.

// ~67ms at the default GAME_SPEED=2 (60 ticks/sec): imperceptible for an
// RTS (AoE2 ran 250ms command turns). Under rollback lockstep
// (js/lockstep.js) a command arriving LATE is no longer fatal — the sim
// rewinds and re-simulates — so this stays small and fixed; it only sets
// how often rollbacks happen, not whether the game stalls.
let INPUT_DELAY_TICKS = 4;
const INPUT_DELAY_MIN = 2, INPUT_DELAY_MAX = 16;

let commandQueue = new Map(); // execTick -> [{team, seq, cmd}]
let localCmdSeq = 0;

function submitCommand(cmd){
  cmd.team = myTeam;
  let execTick = tick + INPUT_DELAY_TICKS;
  let seq = ++localCmdSeq;
  scheduleCommand(execTick, myTeam, seq, cmd);
  // Multiplayer: EVERY peer schedules the command at the issuer-stamped
  // tick; peers get it via 'cmd-ls' (js/lockstep.js — guests' commands
  // reach other guests through the host relay) and roll back if it
  // arrives late.
  if (typeof lockstepEnabled === 'function' && lockstepEnabled()) {
    sendToAllPeers({ type: 'cmd-ls', execTick, seq, cmd });
  }
}

function scheduleCommand(execTick, team, seq, cmd){
  let arr = commandQueue.get(execTick);
  if (!arr) { arr = []; commandQueue.set(execTick, arr); }
  arr.push({ team, seq, cmd });
  detRecordCommand(execTick, team, seq, cmd); // no-op unless a replay log is active
}

// Called at the top of update() for the tick just started. Canonical order
// (team asc, then per-sender seq) so arrival order can never matter.
// Entries are NOT deleted after execution: a lockstep rollback re-simulates
// past ticks and must re-execute their commands from the queue. Pruned
// once safely older than the rollback window.
const COMMAND_KEEP_TICKS = 600;
function runScheduledCommands(){
  let arr = commandQueue.get(tick);
  if (arr) {
    arr.sort((a, b) => a.team - b.team || a.seq - b.seq);
    arr.forEach(c => execCommand(c.cmd, c.team));
  }
  if (tick % 100 === 0) {
    commandQueue.forEach((v, t) => { if (t < tick - COMMAND_KEEP_TICKS) commandQueue.delete(t); });
  }
}

function clearCommandQueue(){
  commandQueue.clear();
  localCmdSeq = 0;
}

// Run fn with `selected`/`myTeam` swapped to the command's own units/team.
// The mutation code below (and the shared helpers it calls: canAfford,
// spendCost, resourceStore, canPlace...) reads those globals for every
// ownership/affordability check; swapping them lets one executor serve any
// team.
function withCommandContext(team, unitIds, fn){
  let prevSelected = selected;
  let prevTeam = myTeam;
  // Resolve ids against OUR entitiesById (never trust object identity from
  // the network) and enforce ownership here, once, for every command kind.
  selected = (unitIds || []).map(id => entitiesById.get(id))
    .filter(e => e && e.team === team && e.hp > 0);
  myTeam = team;
  try { fn(); } finally { selected = prevSelected; myTeam = prevTeam; }
}

// Dispatch one command. Issuer-only feedback (showMsg/sounds/markers)
// inside the mutation code goes through feedbackFor(team, …) (js/core.js),
// which no-ops unless `team` is the human at this keyboard — the local
// player never gets feedback for actions they didn't take.
function execCommand(cmd, team){
  if (!cmd || !cmd.kind) return;
  switch (cmd.kind) {
    case 'rally':
      withCommandContext(team, [], () => execRally(cmd));
      break;
    case 'command':
      withCommandContext(team, cmd.unitIds, () => execUnitCommand(cmd));
      break;
    case 'build-placement':
      withCommandContext(team, cmd.unitIds, () => execBuildPlacement(cmd));
      break;
    case 'wall-drag':
      withCommandContext(team, cmd.unitIds, () => execWallDrag(cmd));
      break;
    case 'train-unit': {
      let bldg = entitiesById.get(cmd.bldgId);
      if (bldg && bldg.type === 'building' && bldg.team === team) {
        withCommandContext(team, [], () => execTrainUnit(bldg, cmd.utype));
      }
      break;
    }
    case 'cancel-queue':
      withCommandContext(team, [], () => execCancelQueue(cmd.bldgId, cmd.idx, team));
      break;
    case 'delete-units':
      (cmd.unitIds || []).forEach(id => {
        let en = entitiesById.get(id);
        if (en && en.team === team) deleteOwnedEntity(en);
      });
      break;
    case 'upgrade-walls':
      withCommandContext(team, [], () => execUpgradeWalls(cmd, team));
      break;
    case 'gate-lock':
      withCommandContext(team, [], () => execGateLock(cmd, team));
      break;
    case 'research-age': {
      let tc = entitiesById.get(cmd.bldgId);
      if (tc && tc.type === 'building' && tc.team === team) {
        withCommandContext(team, [], () => execResearchAge(tc));
      }
      break;
    }
    case 'cancel-research': {
      let tc = entitiesById.get(cmd.bldgId);
      if (tc && tc.type === 'building' && tc.team === team) {
        withCommandContext(team, [], () => execCancelResearch(tc));
      }
      break;
    }
    case 'prepay-farm':
      withCommandContext(team, [], () => prepayFarmNow());
      break;
    case 'cancel-reseed':
      withCommandContext(team, [], () => cancelReseedNow());
      break;
    case 'reactivate-farm': {
      let farm = entitiesById.get(cmd.bldgId);
      if (farm && farm.team === team) {
        withCommandContext(team, [], () => reactivateFarmNow(farm));
      }
      break;
    }
    case 'eject-garrison': {
      let bldg = entitiesById.get(cmd.bldgId);
      if (bldg && bldg.team === team) {
        ejectGarrison(bldg, gu => gu.id === cmd.unitId);
        if (team === myTeam && typeof updateUI === 'function') updateUI();
      }
      break;
    }
    case 'set-delay':
      // Manual lockstep input-delay override (host-only). Under rollback
      // the delay only tunes how often rewinds happen — lateness is no
      // longer fatal — so there's no automatic controller anymore.
      if (team === 0 && cmd.d >= INPUT_DELAY_MIN && cmd.d <= INPUT_DELAY_MAX && lockstepEnabled()) {
        INPUT_DELAY_TICKS = cmd.d;
      }
      break;
    case 'set-speed':
      // Host-only control (team 0); executes at the same tick on both
      // peers so timeStep/pacing never diverge. Range-clamped, never
      // trusted from the wire.
      if (team === 0 && cmd.v >= 0.5 && cmd.v <= 4) {
        setGameSpeed(cmd.v);
        if (typeof showMsg === 'function') showMsg('Game speed: ' + cmd.v + 'x');
      }
      break;
    case 'set-controller':
      // Host-only (team 0): hand a kicked/abandoned player's seat to the
      // AI mid-match. Rides the command stream — not a resync — because
      // teamControllers/AI_STATES are sim state (checksummed, snapshotted,
      // rolled back), so every peer must flip the seat at the same tick.
      // The existing brain state is kept if one exists (a seat that began
      // as AI in a loaded save resumes its plans); a never-AI seat gets a
      // fresh brain.
      if (team === 0 && isPlayerTeam(cmd.t) && cmd.t !== 0) {
        let diff = AI_LEVELS[cmd.diff] ? cmd.diff : (typeof aiDifficulty !== 'undefined' ? aiDifficulty : 'standard');
        teamControllers[cmd.t] = { type: 'ai', difficulty: diff };
        if (!AI_STATES[cmd.t]) AI_STATES[cmd.t] = freshAIState(cmd.t);
        // Everyone should see this, not just the issuer (feedbackFor would
        // limit it to the host) — only a resim replay stays quiet.
        if (!window.__resim && typeof showMsg === 'function') showMsg(teamName(cmd.t) + "'s seat was handed to the AI");
      }
      break;
    case 'dev-spawn':
      // Test-only scenario injection for multiplayer measurement: spawns
      // a deterministic army through the queue so both lockstep peers
      // create identical entities at the same tick. Requires an explicit
      // console opt-in on BOTH peers (window.DEV_TEST_COMMANDS = true);
      // inert otherwise. Used by tests/mp-lockstep-perf.js.
      if (window.DEV_TEST_COMMANDS) {
        let types = cmd.utype ? [cmd.utype] : ['militia', 'archer', 'spearman', 'scout'];
        for (let i = 0; i < (cmd.n | 0) && i < 400; i++) {
          let t = findSpawnTile(cmd.x + (i % 20), cmd.y + ((i / 20) | 0), 12);
          if (t) createUnit(types[i % types.length], t.x, t.y, cmd.forTeam != null ? cmd.forTeam : i % 2);
        }
      }
      break;
    case 'dev-destroy':
      // Test-only deterministic kill (same DEV_TEST_COMMANDS gate) — the
      // lockstep replacement for tests that used to set hp=0 directly on
      // one peer (an out-of-band write is an instant desync now).
      if (window.DEV_TEST_COMMANDS) {
        let victim = entitiesById.get(cmd.id);
        if (victim) { victim.hp = 0; handleDeath(victim, team); }
      }
      break;
    case 'town-bell':
      if (cmd.ringing) ringTownBell(team); else soundAllClear(team);
      if (typeof updateUI === 'function') updateUI();
      break;
    case 'market-trade':
      execMarketTrade(cmd, team);
      break;
    case 'auto-scout':
      execAutoScout(cmd, team);
      break;
    case 'guard':
      execGuard(cmd, team);
      break;
  }
}

// Which units carry a guard post: soldiers, plus RAMS — a ram doesn't
// auto-engage (isSoldierUnit is false) but holding a position is a valid
// order for it. THE single eligibility filter: the UI button (allGuardable,
// js/ui.js), the rally-spawn pin (js/logic.js) and the move-order re-pin
// (issueMoveOrder, js/pathfinding.js) all call this.
function guardEligible(u){
  return isSoldierUnit(u) || (u.type === 'unit' && u.utype === 'ram');
}

// The one way to (re)place a guard post: clamps to the map (formation
// offsets at the edge produced off-map posts whose -1 aliased the "no
// guard" sentinel in the determinism hash) and resets the guard-return
// attempt counter so a fresh post gets fresh return tries (see the settle
// logic in js/logic.js).
function setGuardPost(u, x, y, flagged){
  u.guardX = Math.max(0, Math.min(MAP - 1, x));
  u.guardY = Math.max(0, Math.min(MAP - 1, y));
  u.guardFlagged = !!flagged;
  if (u.retry && u.retry['guardret']) u.retry['guardret'].n = 0;
}

// Building rally targets are kept only where the BUILDING is the point:
// one you can go INSIDE (TC / guard tower garrison), a Market (trade-cart
// route), an own foundation (builders), or an enemy building (attack).
// Shared by execRally (sim) and doCommand's click feedback (js/input.js)
// so the message can never disagree with what actually got set.
function isRallyBuildingTarget(b, team){
  return canGarrisonIn(b, team)
    || b.btype === 'MARKET'
    || (b.team === team && !b.complete)
    || !sameSide(b.team, team);
}

// AoE2-style Guard: ONE flag order, three target kinds —
//   ground:   hold that spot (formation offsets, like a group move)
//   building: stand watch around it (per-unit perimeter posts)
//   unit:     ESCORT — the post rides on the guarded unit (follow + leash,
//             see syncGuardPost in js/logic.js); if it dies, the post
//             freezes at its last position.
// Guarding units engage enemies that come close and RETURN to the post
// afterwards. The post is never CANCELLED: a plain ground move simply
// relocates it ("this is your temp spot", execUnitCommand), and explicit
// attacks are exempt from the leash.
function execGuard(cmd, team){
  let units = (cmd.unitIds || []).map(id => entitiesById.get(id))
    .filter(u => u && u.team === team && u.hp > 0 && !u.garrisonedIn && guardEligible(u));
  if (!units.length) return;
  // Re-resolve and validate the flagged target: own/allied only — a tap on
  // an enemy or gaia thing falls through to a ground post at that spot.
  let target = cmd.targetId != null ? entitiesById.get(cmd.targetId) : null;
  if (target && (target.hp <= 0 || target.garrisonedIn || !sameSide(target.team, team))) target = null;
  let finish = (u, px, py) => {
    setGuardPost(u, px, py, true); // EXPLICIT flag: draws the in-world flag/line (render.js)
    u.target = null; u.task = null;
    u.explicitAttack = false; u.autoScout = false;
    clearUnitPath(u);
    pathUnitTo(u, Math.round(u.guardX), Math.round(u.guardY));
  };
  if (target && target.type === 'unit') {
    units.forEach(u => {
      if (u.id === target.id) return; // can't escort yourself
      u.guardTargetId = target.id;
      u.followId = target.id; // the existing follow leg does the walking
      finish(u, target.x, target.y);
    });
  } else if (target && target.type === 'building') {
    // Fan the guards OUT around the footprint (claimed set) so they cover the
    // whole building instead of piling onto its nearest corner — the leash
    // (js/logic.js) then anchors each to the building as a whole.
    let claimed = new Set();
    units.forEach(u => {
      let pt = nearestBldgPerimeter(u.x, u.y, target, u.id, claimed);
      claimed.add(pt.x + ',' + pt.y);
      u.guardTargetId = target.id; // liveness only — buildings don't move
      u.followId = undefined;
      finish(u, pt.x, pt.y);
    });
  } else {
    let x = Math.max(0, Math.min(MAP - 1, Math.round(cmd.x)));
    let y = Math.max(0, Math.min(MAP - 1, Math.round(cmd.y)));
    let offsets = getFormation(units.length);
    units.forEach((u, i) => {
      let ox = offsets[i] ? offsets[i][0] : 0, oy = offsets[i] ? offsets[i][1] : 0;
      u.guardTargetId = null;
      u.followId = undefined;
      finish(u, x + ox, y + oy);
    });
  }
  feedbackFor(team, () => { if (window.playSound) playSound('click'); });
  if (team === myTeam && typeof updateUI === 'function') updateUI();
}

// Toggle the player's Auto Scout mode on the given scout units. When turned ON,
// clear any target/path so it starts exploring immediately (the per-tick
// behavior in js/logic.js drives the frontier wander). Mirrors execGateLock's
// re-resolve-and-revalidate-by-id pattern for lockstep safety.
function execAutoScout(cmd, team){
  let on = !!cmd.on;
  let units = (cmd.unitIds || []).map(id => entitiesById.get(id))
    .filter(u => u && u.type === 'unit' && u.utype === 'scout' && u.team === team && u.hp > 0);
  if (!units.length) return;
  units.forEach(u => {
    u.autoScout = on;
    if (on) {
      u.target = null; u.explicitAttack = false; u.task = null; clearUnitPath(u);
      // Exploring IS the new task — drop any guard post (flag, escort and
      // all), or the guard leash/return would fight the frontier wander.
      // Mirrors execGuard clearing autoScout. followId MUST clear too: an
      // escort walks via followId, so leaving it set kept the scout glued to
      // the escorted unit for a beat before the wander took over.
      u.guardX = null; u.guardY = null; u.guardTargetId = null; u.guardFlagged = false;
      u.followId = undefined;
    }
  });
  feedbackFor(team, () => { if (window.playSound) playSound('click'); });
  if (team === myTeam && typeof updateUI === 'function') updateUI();
}

// Commodity exchange: buy or sell 100 of a resource for gold at the current
// global price (marketPrices, js/core.js — shared by all players). Mutates the
// shared price so every player sees the drift, which is why it MUST run here in
// the deterministic executor, never client-side. Integer math only.
function execMarketTrade(cmd, team){
  let res = cmd.resType;
  if (res !== 'food' && res !== 'wood' && res !== 'stone') return;
  // Authoritative gate: the team must actually own a completed Market.
  let hasMarket = entities.some(b => b.type === 'building' && b.btype === 'MARKET' && b.team === team && b.complete && b.hp > 0);
  if (!hasMarket) return;
  let store = resourceStore(team);
  let price = marketPrices[res];
  if (cmd.dir === 'buy') {
    if (store.gold < price) { feedbackFor(team, () => showMsg('Not enough gold.')); return; }
    store.gold -= price;
    store[res] += MARKET_LOT;
    marketPrices[res] = Math.min(MARKET_PRICE_MAX, price + MARKET_PRICE_STEP);
  } else if (cmd.dir === 'sell') {
    if (store[res] < MARKET_LOT) { feedbackFor(team, () => showMsg('Not enough ' + res + ' to sell.')); return; }
    store[res] -= MARKET_LOT;
    store.gold += Math.floor(price * MARKET_SELL_RATIO / 100);
    marketPrices[res] = Math.max(MARKET_PRICE_MIN, price - MARKET_PRICE_STEP);
  }
  if (team === myTeam && typeof updateUI === 'function') updateUI();
}

// ---- EXECUTORS ----
// Pure sim mutation, world-space inputs only. All run under
// withCommandContext (selected/myTeam swapped to the issuing team).

// Rally point for a training building (right-click with building selected).
function execRally(cmd){
  let bldg = entitiesById.get(cmd.bldgId);
  if (!bldg || bldg.type !== 'building' || bldg.team !== myTeam) return;
  let bData = BLDGS[bldg.btype];
  if (!bData || !bData.builds || bData.builds.length === 0) return;
  if (!inMapBounds(cmd.tileX, cmd.tileY)) return;
  let rx = cmd.tileX, ry = cmd.tileY;
  let rTarget = cmd.targetId != null ? entitiesById.get(cmd.targetId) : null;
  // Rally flags point at SPOTS, not units: a flag dropped on a unit (own,
  // enemy, or a passing sheep) is just a flag on the ground underneath it —
  // fresh units shouldn't inherit chase/attack orders from whoever happened
  // to stand there. The flag snaps to the tile that unit is STANDING on
  // (clicking its sprite can resolve to a neighboring tile, since the art
  // extends above the feet). Building targets stay: rally into a garrison,
  // a trade-cart route onto a market, builders onto a foundation.
  if (rTarget && rTarget.type === 'unit') {
    // round, not floor: resting units sit on integer path nodes, so a unit
    // mid-step at x=5.6 is walking onto tile 6 — floor put the flag one
    // tile behind it (and missed the resource tile it stands on).
    rx = Math.max(0, Math.min(MAP - 1, Math.round(rTarget.x)));
    ry = Math.max(0, Math.min(MAP - 1, Math.round(rTarget.y)));
    rTarget = null;
  }
  // Building rally targets are kept only where the BUILDING is the point:
  // one you can go INSIDE (TC / guard tower garrison, canGarrisonIn), a
  // Market (trade-cart route), an own foundation (builders), or an enemy
  // building (attack). A flag on any other friendly building is just a
  // flag on the ground there.
  if (rTarget && rTarget.type === 'building' && !isRallyBuildingTarget(rTarget, bldg.team)) {
    rTarget = null;
  }
  bldg.rallyX = rx;
  bldg.rallyY = ry;
  if (rTarget) {
    bldg.rallyTargetId = rTarget.id;
    bldg.rallyResourceType = null;
  } else {
    let t0 = map[ry] && map[ry][rx];
    if (t0 && (t0.t === TERRAIN.FOREST || t0.t === TERRAIN.GOLD || t0.t === TERRAIN.STONE || t0.t === TERRAIN.BERRIES || t0.t === TERRAIN.FARM)) {
      bldg.rallyResourceType = t0.t;
      bldg.rallyTargetId = null;
    } else {
      bldg.rallyResourceType = null;
      bldg.rallyTargetId = null;
    }
  }
}

// Right-click unit command: attack / build-repair / follow / gather / move.
// Targets were resolved to ids at input time on the issuer's client (with
// ITS fog); here they're re-fetched by id and revalidated against live state.
function execUnitCommand(cmd){
  let tileX = cmd.tileX, tileY = cmd.tileY;
  let target = cmd.targetId != null ? entitiesById.get(cmd.targetId) : null;
  if (target && (target.hp <= 0 || target.garrisonedIn)) target = null;
  // Re-validate: an attack target must still be attackable by this team
  // (enemy or gaia animal) — never a friendly or allied unit.
  if (target && sameSide(target.team, myTeam) && target.utype !== 'sheep' && target.utype !== 'sheep_carcass') target = null;
  let buildTarget = cmd.buildTargetId != null ? entitiesById.get(cmd.buildTargetId) : null;
  if (buildTarget && (buildTarget.team !== myTeam || buildTarget.type !== 'building')) buildTarget = null;
  let followTarget = cmd.followId != null ? entitiesById.get(cmd.followId) : null;
  if (followTarget && (followTarget.hp <= 0 || followTarget.team !== myTeam)) followTarget = null;

  let movers = selected.filter(s => s.type === 'unit');
  let offsets = getFormation(movers.length);
  // AoE2 formation pace: a group order moves everyone at the slowest
  // member's speed (see unitMoveSpeed, js/logic.js) so the group arrives
  // together instead of trickling in fastest-first. Solo orders run free.
  let groupSpeed = movers.length > 1
    ? Math.min(...movers.map(m => m.speed || 1)) : undefined;
  let idx = 0;
  movers.forEach(s => {
    s.groupSpeed = groupSpeed;
    s.gatherX = -1; s.gatherY = -1; s.prevTask = null; s.savedTask = null; // fully clear old state
    s.buildTarget = null;
    s.buildQueue = [];
    s.followId = undefined;
    s.defendX = s.x; s.defendY = s.y;
    s.explicitAttack = false;
    s.autoScout = false; // any manual order cancels Auto Scout
    // The guard post is NOT cleared by manual orders — a plain ground move
    // RELOCATES it instead ("this is your temp spot", assigned below at the
    // move sites); attack/follow orders leave it where it was, and the unit
    // walks back after the fight. An ESCORT (guard-on-unit) does end here,
    // mirroring followId: the post freezes at its last synced spot.
    s.guardTargetId = null;
    if (s.utype === 'tradecart') {
      // Trade carts route to a Market, they don't attack. Resolve the clicked
      // entity directly from cmd (NOT the `target` var, which is nulled for
      // allied/friendly buildings above) so trading with an ALLIED market — not
      // just an enemy one — works, per AoE2. Any non-market order cancels the
      // route and becomes a plain move.
      let mkt = cmd.targetId != null ? entitiesById.get(cmd.targetId) : null;
      let validMkt = mkt && mkt.type === 'building' && mkt.btype === 'MARKET' && mkt.complete && mkt.hp > 0 && mkt.team !== s.team && isPlayerTeam(mkt.team);
      if (validMkt) {
        let home = nearestMarket(s, true);
        if (!home) {
          feedbackFor(s.team, () => showMsg('Build your own Market before trading.'));
        } else {
          s.tradeDestId = mkt.id; s.tradeHomeId = home.id; s.tradePhase = 'toDest';
          s.target = null; s.task = null; clearUnitPath(s);
          let pt = nearestBldgPerimeter(s.x, s.y, mkt, s.id);
          pathUnitTo(s, pt.x, pt.y);
        }
      } else {
        s.tradeDestId = null; s.tradeHomeId = null; s.tradePhase = null;
        s.carrying = 0; s.carryType = null; s.target = null; s.task = null;
        let ox = offsets[idx] ? offsets[idx][0] : 0, oy = offsets[idx] ? offsets[idx][1] : 0;
        s.task = null; issueMoveOrder(s, tileX + ox, tileY + oy);
        idx++;
      }
      return;
    }
    if (buildTarget && s.utype === 'villager') {
      s.target = null; s.task = 'build'; s.buildTarget = buildTarget.id;
      let b = BLDGS[buildTarget.btype];
      let pt = b.isFarm ? { x: buildTarget.x, y: buildTarget.y } : (typeof nearestBldgPerimeter === 'function' ? nearestBldgPerimeter(s.x, s.y, buildTarget, s.id) : { x: buildTarget.x + buildTarget.w, y: buildTarget.y + buildTarget.h });
      pathUnitTo(s, pt.x, pt.y);
    } else if (target) {
      if (s.utype === 'sheep') { return; } // sheep don't attack
      if ((target.utype === 'sheep' || target.utype === 'sheep_carcass') && s.utype !== 'villager') {
        // Sheep or carcass targeted by military unit: treat as move command!
        s.target = null;
        let ox = offsets[idx] ? offsets[idx][0] : 0, oy = offsets[idx] ? offsets[idx][1] : 0;
        s.task = null; issueMoveOrder(s, tileX + ox, tileY + oy);
        idx++;
      } else {
        s.target = target.id; s.task = null; clearUnitPath(s); s.buildTarget = null;
        s.explicitAttack = true;
      }
    } else if (followTarget && followTarget.id !== s.id && s.utype !== 'sheep') {
      // AoE2-style "Follow": keep pathing toward the followed unit's current
      // position (see updateUnit() in logic.js for the continuous re-pathing).
      s.target = null; s.task = null; s.followId = followTarget.id;
      pathUnitTo(s, Math.round(followTarget.x), Math.round(followTarget.y));
    } else {
      s.target = null;
      let t = map[tileY] && map[tileY][tileX];
      if (s.utype === 'villager' && t) {
        // Group spread (AoE2 DE): each villager claims its own tile of the
        // clicked resource — claims are visible to the next villager in this
        // same loop via gatherX, so the group fans out tile by tile.
        let TASK_BY_TERRAIN = { [TERRAIN.FOREST]: 'chop', [TERRAIN.GOLD]: 'mine_gold', [TERRAIN.STONE]: 'mine_stone', [TERRAIN.BERRIES]: 'forage', [TERRAIN.FARM]: 'farm' };
        let gTask = TASK_BY_TERRAIN[t.t];
        // A villager can only be TASKED onto a resource it can actually see:
        // if the tile is still UNEXPLORED for this (human) team, the player
        // doesn't know what's there, so the click is a plain WALK — the
        // villager goes and stands idle instead of auto-gathering an unseen
        // resource. Deterministic (teamExploredGrid is sim state); AI keeps
        // its proximity-vision exemption, same rule as canPlace (js/logic.js).
        let unseen = tileHiddenForTeam(s.team, tileY*MAP + tileX);
        if (gTask && !unseen) {
          let g = claimGatherTileNear(s, t.t, tileX, tileY);
          s.task = gTask; s.gatherX = g.x; s.gatherY = g.y; pathUnitTo(s, g.x, g.y);
        } else {
          // Move command (also the unexplored-tile case): use formation offset
          let ox = offsets[idx] ? offsets[idx][0] : 0, oy = offsets[idx] ? offsets[idx][1] : 0;
          s.task = null; issueMoveOrder(s, tileX + ox, tileY + oy);
          idx++;
        }
      } else {
        // Military move: use formation offset. The guard-post relocation
        // ("this is your temp spot") lives inside issueMoveOrder itself, so
        // every plain-move site gets it without a paired re-pin line.
        let ox = offsets[idx] ? offsets[idx][0] : 0, oy = offsets[idx] ? offsets[idx][1] : 0;
        s.task = null; issueMoveOrder(s, tileX + ox, tileY + oy);
        idx++;
      }
    }
  });
}

// Building placement (moved verbatim from doPlace's mutation half —
// `placing` global replaced by cmd.btype, screen coords by cmd tile).
function execBuildPlacement(cmd){
  let btype = cmd.btype;
  if (!BLDGS[btype]) return;
  let tile = { x: cmd.tileX, y: cmd.tileY };
  let vils = selected.filter(s => s.type === 'unit' && s.utype === 'villager');
  if (vils.length === 0) return;
  if (canPlace(btype, tile.x, tile.y, myTeam)) {
    let b = BLDGS[btype];
    let gw = b.w, gh = b.h;
    let ox = tile.x, oy = tile.y;
    if (isGateBtype(btype)) {
      let wallB = GATE_WALL_MATCH[btype];
      let isWall = (tx, ty) => !!entities.find(en => en.type === 'building' && en.x === tx && en.y === ty && en.btype === wallB && en.team === myTeam);
      ({ ox, oy, gw, gh } = gateFootprint(tile.x, tile.y, isWall));
    }
    let wallsToRemove = [];
    for (let dy = 0; dy < gh; dy++) {
      for (let dx = 0; dx < gw; dx++) {
        let w = entities.find(en => en.type === 'building' && en.x === ox + dx && en.y === oy + dy && isWallBtype(en.btype) && en.team === myTeam);
        if (w) wallsToRemove.push(w);
      }
    }
    let actualCost = { ...b.cost };
    // Refund each consumed wall's OWN cost (palisades refund wood, stone
    // walls refund stone) against whatever this building costs.
    let refundWalls = (walls) => {
      walls.forEach(w2 => {
        Object.entries(BLDGS[w2.btype].cost).forEach(([k, amt]) => {
          actualCost[k] = Math.max(0, (actualCost[k] || 0) - amt);
        });
      });
    };
    if (isGateBtype(btype)) {
      refundWalls(wallsToRemove);
    } else if (btype === 'SWALL') {
      // Stone-on-palisade upgrade: the footprint loop already collected the
      // palisade being replaced — refund its wood against the stone's cost.
      refundWalls(wallsToRemove);
    } else if (isTowerBtype(btype)) {
      let existing = entities.find(en => en.type === 'building' && en.x === tile.x && en.y === tile.y && isWallBtype(en.btype) && en.team === myTeam);
      if (existing) {
        wallsToRemove.push(existing);
        refundWalls([existing]);
      }
    }
    if (!canAfford(myTeam, actualCost)) { feedbackFor(myTeam, () => showMsg('Not enough resources!')); return; }
    spendCost(myTeam, actualCost);
    if (wallsToRemove.length > 0) {
      let ids = new Set(wallsToRemove.map(w => w.id));
      entities = entities.filter(en => !ids.has(en.id));
      selected = selected.filter(s => !ids.has(s.id));
      ids.forEach(id => entitiesById.delete(id));
    }
    let bldg = createBuilding(btype, ox, oy, myTeam, gw, gh);
    bldg.complete = false; bldg.buildProgress = 0;
    bldg.hp = 1; // AoE2: foundations start at ~no HP and gain it as construction progresses
    if (wallsToRemove.length > 0) {
      bldg.wasWall = true;
    }
    vils.forEach(v => {
      v.buildQueue = v.buildQueue || [];
      v.buildQueue.push(bldg.id);
      // Start construction task immediately if not already building
      if (v.task !== 'build' || !v.buildTarget) {
        v.task = 'build'; v.buildTarget = bldg.id; v.target = null; v.savedTask = null;
        let pt = b.isFarm ? { x: ox, y: oy } : (typeof nearestBldgPerimeter === 'function' ? nearestBldgPerimeter(v.x, v.y, bldg, v.id) : { x: ox + gw, y: oy + gh });
        pathUnitTo(v, pt.x, pt.y);
      }
    });
  } else {
    feedbackFor(myTeam, () => { showMsg('Can\'t build here!'); if (window.playSound) playSound('error'); });
  }
}

// Wall drag (moved verbatim from finalizeWallDrag's mutation half).
function execWallDrag(cmd){
  let vils = selected.filter(s => s.type === 'unit' && s.utype === 'villager');
  if (vils.length === 0) return;
  let line = getWallElbowTiles(cmd.start, cmd.corner || cmd.end, cmd.end);
  let wallB = isWallBtype(cmd.btype) ? cmd.btype : 'WALL';
  let b = BLDGS[wallB];
  let placedCount = 0;
  let lastBldg = null;
  line.forEach(t => {
    if (canPlace(wallB, t.x, t.y, myTeam)) {
      let actualCost = { ...b.cost };
      if (canAfford(myTeam, actualCost)) {
        spendCost(myTeam, actualCost);
        let bldg = createBuilding(wallB, t.x, t.y, myTeam);
        bldg.complete = false;
        bldg.buildProgress = 0;
        lastBldg = bldg;
        placedCount++;
        vils.forEach(v => {
          v.buildQueue = v.buildQueue || [];
          v.buildQueue.push(bldg.id);
        });
      } else {
        feedbackFor(myTeam, () => { showMsg('Not enough stone!'); if (window.playSound) playSound('error'); });
      }
    }
  });
  if (placedCount > 0 && lastBldg) {
    vils.forEach(v => {
      if (v.task !== 'build' || !v.buildTarget) {
        v.task = 'build';
        v.buildTarget = lastBldg.id;
        v.target = null;
        pathUnitTo(v, lastBldg.x + 1, lastBldg.y + 1);
      }
    });
  }
}

// Train / cancel (moved from ui.js's trainUnit/cancelQueue mutation halves).
function execTrainUnit(bldg, utype){
  let result = queueUnit(bldg, utype);
  feedbackFor(myTeam, () => {
    if (result.reason === 'pop') showMsg('Need more houses!');
    else if (result.reason === 'resources') showMsg('Not enough resources!');
    else if (result.reason === 'age') showMsg('Requires the ' + AGES[ageReq(utype)].name + '!');
    if (result.reason && window.playSound) playSound('error');
  });
}

// Start advancing to the next age at this TC. The research is a plain
// field on the TC entity ({target, tick}) so it rides saves and lockstep
// rollbacks automatically, and dies (unrefunded, AoE2-style) with the TC.
// While researching, the TC's unit queue is paused (js/logic.js).
function execResearchAge(tc){
  if (tc.btype !== 'TC' || !tc.complete || tc.research) return;
  let next = teamAge[tc.team] + 1;
  if (next >= AGES.length) return;
  let cost = AGES[next].cost;
  // feedbackFor handles the AI calling this directly from the sim
  // (js/ai.js) — the human must not see the AI's advancement toasts.
  if (!canAfford(tc.team, cost)) {
    feedbackFor(tc.team, () => { showMsg('Not enough resources to advance!'); if (window.playSound) playSound('error'); });
    return;
  }
  spendCost(tc.team, cost);
  tc.research = { target: next, tick: 0 };
  feedbackFor(tc.team, () => showMsg('Advancing to the ' + AGES[next].name + '…'));
  if (typeof updateUI === 'function') updateUI();
}

// Upgrade completed palisade WALL/GATE pieces to their stone counterpart
// (SWALL/SGATE), and a Palisade Watch Tower to a Watch Tower — an instant
// replacement: the old piece is salvaged on the spot (refund = its cost ×
// remaining-HP fraction, `upgradeSalvage` — credited before the target's
// full cost is charged, so surplus wood pays out and helps afford mixed
// costs) and swaps into a construction site of the target type that
// villagers build up at normal build rate. Its tiles keep blocking, but at
// foundation HP it's fragile — upgrading mid-siege is a gamble, not a heal.
// The `upgrading` flag marks it committed: once started an upgrade just
// proceeds (no cancel/refund — see deleteOwnedEntity and the cancel UI in
// js/ui.js), which is what keeps it from being an instant free salvage.
const WALL_STONE_MATCH = { WALL: 'SWALL', GATE: 'SGATE', PTOWER: 'TOWER' };
// Shared by the exec below and the UI button's net-cost preview (js/ui.js).
function upgradeSalvage(en){
  let frac = Math.min(1, en.hp / en.maxHp), refund = {};
  Object.entries(BLDGS[en.btype].cost).forEach(([k, v]) => { refund[k] = Math.floor(v * frac); });
  return refund;
}
function execUpgradeWalls(cmd, team){
  let pieces = (cmd.unitIds || []).map(id => entitiesById.get(id))
    .filter(en => en && en.type === 'building' && WALL_STONE_MATCH[en.btype] && en.team === team && en.complete && en.hp > 0);
  if (!pieces.length) return;
  let locked = pieces.find(en => !isUnlocked(team, WALL_STONE_MATCH[en.btype]));
  if (locked) {
    feedbackFor(team, () => { showMsg('Requires the ' + AGES[ageReq(WALL_STONE_MATCH[locked.btype])].name + '!'); if (window.playSound) playSound('error'); });
    return;
  }
  let cost = {}, refund = {};
  pieces.forEach(en => {
    Object.entries(BLDGS[WALL_STONE_MATCH[en.btype]].cost)
      .forEach(([k, v]) => { cost[k] = (cost[k] || 0) + v; });
    Object.entries(upgradeSalvage(en))
      .forEach(([k, v]) => { refund[k] = (refund[k] || 0) + v; });
  });
  // Afford check counts the salvage credit (it lands before the charge).
  let store = resourceStore(team);
  if (!Object.entries(cost).every(([k, v]) => store[resourceName(k)] + (refund[k] || 0) >= v)) {
    feedbackFor(team, () => { showMsg('Not enough resources!'); if (window.playSound) playSound('error'); });
    return;
  }
  Object.entries(refund).forEach(([k, v]) => { store[resourceName(k)] += v; });
  spendCost(team, cost);
  pieces.forEach(w => {
    let upType = WALL_STONE_MATCH[w.btype];
    if (w.garrison && w.garrison.length) ejectGarrison(w); // a tower under rebuild shelters no one
    w.btype = upType; // gates keep their footprint/door state (w/h, gateProgress)
    // A rebuilt gate starts UNLOCKED — the lock is a per-gate toggle the
    // player set on the OLD piece; the new one shouldn't silently inherit it
    // (a locked foundation would also seal pathing while it builds).
    w.locked = false;
    // Re-stamp the fields createBuilding snapshots from BLDGS (armor/range/
    // garrisonCap are read live, but atk and buildTime are entity fields).
    w.atk = BLDGS[upType].atk || 0;
    w.buildTime = BLDGS[upType].buildTime || 200;
    w.maxHp = buildingMaxHpFor(team, upType);
    // Fresh construction site, same as execBuildPlacement foundations, but
    // committed: `upgrading` blocks cancel/refund so it can't be undone.
    w.complete = false; w.buildProgress = 0; w.hp = 1; w.wasWall = true; w.upgrading = true;
    markMapDirty(w.x, w.y);
  });
  feedbackFor(team, () => {
    let allTowers = pieces.every(p => p.btype === 'TOWER');
    showMsg((allTowers
      ? (pieces.length > 1 ? pieces.length + ' towers' : 'Tower') + ' salvaged — Watch Tower'
      : pieces.length + ' wall piece' + (pieces.length > 1 ? 's' : '') + ' salvaged — stone')
      + ' under construction, send villagers to build');
    if (window.playSound) playSound('build', pieces[0].x, pieces[0].y);
  });
  if (typeof updateUI === 'function') updateUI();
}

// Lock/unlock the selected own gates (AoE2). A locked gate seals the doorway to
// everyone — pathfinding (js/pathfinding.js) refuses the centre tile and the
// gate driver (js/loop.js) holds it shut — so the owner can wall a raider out
// through its own gate. Re-validates ownership/type on the exec tick.
function execGateLock(cmd, team){
  let gates = (cmd.bldgIds || []).map(id => entitiesById.get(id))
    .filter(g => g && g.type === 'building' && isGateBtype(g.btype) && g.team === team && g.complete && g.hp > 0);
  if (!gates.length) return;
  let locked = !!cmd.locked;
  gates.forEach(g => { g.locked = locked; markMapDirty(g.x, g.y); });
  feedbackFor(team, () => {
    showMsg((locked ? 'Gate locked' : 'Gate unlocked') + (gates.length > 1 ? ' ×' + gates.length : ''));
    if (window.playSound) playSound('click');
  });
  if (typeof updateUI === 'function') updateUI();
}

function execCancelResearch(tc){
  if (!tc.research) return;
  let cost = AGES[tc.research.target].cost;
  let store = resourceStore(tc.team);
  Object.entries(cost).forEach(([key, amount]) => { store[resourceName(key)] += amount; });
  tc.research = undefined;
  feedbackFor(tc.team, () => showMsg('Age research cancelled (refunded)'));
  if (typeof updateUI === 'function') updateUI();
}

function execCancelQueue(bldgId, idx, team){
  let bldg = entitiesById.get(bldgId);
  if (!bldg || bldg.type !== 'building' || bldg.team !== team) return;
  let utype = bldg.queue[idx];
  if (!utype) return;
  bldg.queue.splice(idx, 1);
  let cost = UNITS[utype].cost;
  let store = resourceStore(bldg.team);
  Object.entries(cost).forEach(([key, amount]) => { store[resourceName(key)] += amount; });
  if (idx === 0) bldg.trainTick = 0;
  feedbackFor(myTeam, () => showMsg(UNITS[utype].name + ' cancelled (refunded)'));
}

// Farm economy (moved from ui.js's prepayFarm/reactivateFarm mutation halves).
function prepayFarmNow(){
  let cost = { w: 60 };
  if (!canAfford(myTeam, cost)) {
    feedbackFor(myTeam, () => { showMsg('Not enough wood!'); if (window.playSound) playSound('error'); });
    return;
  }
  spendCost(myTeam, cost);
  let store = resourceStore(myTeam);
  store.prepaidFarms = (store.prepaidFarms || 0) + 1;
  feedbackFor(myTeam, () => showMsg(`Farm reseed prepaid (Queue: ${store.prepaidFarms})`));
  if (typeof updateUI === 'function') updateUI();
}

// Cancel one banked reseed — refunds the 60 wood it was prepaid with, exactly
// like cancelling a queued unit refunds its cost (queue parity). No-op when
// the queue is empty.
function cancelReseedNow(){
  let store = resourceStore(myTeam);
  if ((store.prepaidFarms || 0) <= 0) return;
  store.prepaidFarms--;
  store.wood += 60;
  feedbackFor(myTeam, () => showMsg(`Reseed cancelled (+60 Wood). Queue: ${store.prepaidFarms}`));
  if (typeof updateUI === 'function') updateUI();
}

function reactivateFarmNow(farm){
  if (!farm.exhausted) return;
  let cost = { w: 60 };
  if (!canAfford(myTeam, cost)) {
    feedbackFor(myTeam, () => { showMsg('Not enough wood!'); if (window.playSound) playSound('error'); });
    return;
  }
  spendCost(myTeam, cost);
  farm.exhausted = false;
  farm.complete = true;
  farm.hp = farm.maxHp;
  let tile = map[farm.y][farm.x];
  tile.t = TERRAIN.FARM;
  tile.res = BLDGS.FARM.food; // same refill as every other reseed path (fresh/prepaid/walk-up/AI)
  markMapDirty(farm.x, farm.y);
  feedbackFor(myTeam, () => showMsg('Farm reactivated!'));
  if (typeof updateUI === 'function') updateUI();
}
