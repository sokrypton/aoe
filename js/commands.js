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
// (js/lockstep.js) a late command just triggers a rewind, so this stays
// small and fixed — it only sets how often rollbacks happen.
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
const COMMAND_KEEP_TICKS = T30(600);
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
    case 'research': {
      let bldg = entitiesById.get(cmd.bldgId);
      if (bldg && bldg.type === 'building' && bldg.team === team) {
        withCommandContext(team, [], () => execResearch(bldg, cmd.target));
      }
      break;
    }
    case 'cancel-research': {
      let bldg = entitiesById.get(cmd.bldgId);
      if (bldg && bldg.type === 'building' && bldg.team === team) {
        withCommandContext(team, [], () => execCancelResearch(bldg));
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
        // cmd.all → release EVERYONE (falsy filter ejects all); else one unit.
        ejectGarrison(bldg, cmd.all ? null : gu => gu.id === cmd.unitId);
        if (team === myTeam && typeof updateUI === 'function') updateUI();
      }
      break;
    }
    case 'set-delay':
      // Manual lockstep input-delay override (host-only); under rollback
      // the delay only tunes how often rewinds happen.
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
        // Difficulty is stamped into the command payload by the host at submit
        // time (see kickDisconnectedPlayers) so every peer applies the SAME
        // value. Reading the client-local `aiDifficulty` global here instead
        // would desync: it's set independently per peer from menus/lobby/saves.
        let diff = AI_LEVELS[cmd.diff] ? cmd.diff : 'standard';
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
      // Test-only deterministic kill (same DEV_TEST_COMMANDS gate) — an
      // out-of-band hp write on one peer is an instant desync.
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
    case 'set-stance':
      execSetStance(cmd, team);
      break;
    case 'garrison':
      execGarrison(cmd, team);
      break;
  }
}

// The 4 AoE2 stances (must match STANCES in js/editor.js and the reads in
// js/logic.js). Set from the HUD stance buttons (js/ui.js) via this command —
// lockstep-safe like auto-scout/guard: queued to a shared tick, ids re-resolved
// against the local entitiesById + ownership-filtered on every peer.
const VALID_STANCES = new Set(['aggressive', 'defensive', 'standground', 'passive']);
function execSetStance(cmd, team){
  if (!VALID_STANCES.has(cmd.stance)) return; // never trust a wire value
  let units = (cmd.unitIds || []).map(id => entitiesById.get(id))
    .filter(u => u && u.type === 'unit' && u.team === team && u.hp > 0 &&
                 typeof isSoldierUnit === 'function' && isSoldierUnit(u));
  if (!units.length) return;
  units.forEach(u => {
    u.stance = cmd.stance;
    // Postures are mutually exclusive: picking a stance clears Guard/Auto
    // Scout (mirrors execGuard/execAutoScout clearing each other), keeping
    // the behavior matching the UI's single highlighted posture.
    if (u.order && (GUARD_ORDER_KINDS.has(u.order.kind) || u.order.kind === 'scout')) issueOrder(u, null);
    // No Attack must DISENGAGE, not just stop acquiring: the passive gate in
    // js/logic.js only blocks the auto-acquire scan, so drop the current
    // FIGHT too (AoE2 does the same; explicit attack orders issued to a
    // passive unit are still obeyed). ONLY the fight: a unit merely walking
    // keeps its move order.
    if (cmd.stance === 'passive' && (u.target != null || u.explicitAttack)) {
      u.target = null; u.explicitAttack = false;
      if (typeof clearUnitPath === 'function') clearUnitPath(u);
    }
  });
  feedbackFor(team, () => { if (window.playSound) playSound('click'); });
  if (team === myTeam && typeof updateUI === 'function') updateUI();
}

// Which units carry a guard post: SOLDIERS only. A ram already holds
// position by nature (never auto-engages), and its Guard tile read as a
// second garrison button; rams remain escort TARGETS and riders still
// garrison inside. THE single eligibility filter: allGuardable (js/ui.js),
// the rally-spawn anchor (js/logic.js) and the move-order re-pin
// (issueMoveOrder, js/pathfinding.js) all call this.
function guardEligible(u){
  return isSoldierUnit(u);
}

// THE free-seat count for a garrison container: seats already taken PLUS
// riders already WALKING to board count against the cap — shared by the
// player's ram-click boarding and the AI's wave rider planner, so the two
// can never double-book seats differently.
function ramSeatsFree(container){
  let walkers = 0;
  for (const u of entities) if (u.type === 'unit' && u.task === 'garrison' && u.garrisonTarget === container.id) walkers++;
  return Math.max(0, garrisonCap(container) - garrisonCount(container) - walkers);
}

// Garrison INTO a container (TC/tower/ram) — the container-first "load mode"
// (Garrison button js/ui.js + garrisonLoadTap js/input.js). canGarrisonIn is the
// per-unit gate (ANY unit into a complete own building; only riders into a ram);
// ramSeatsFree caps and counts walkers so repeated taps never double-book seats.
// Writes the SAME field-set as the ram-board branch, so updateGarrisonWalk/
// enterGarrison drive it with no new sim code.
function execGarrison(cmd, team){
  let b = cmd.bldgId != null ? entitiesById.get(cmd.bldgId) : null;
  if (!(b && b.team === team && b.hp > 0 && garrisonCap(b) > 0 &&
        (b.type !== 'building' || b.complete))) return; // never trust the wire
  let room = ramSeatsFree(b), sent = 0;
  (cmd.unitIds || []).forEach(id => {
    if (room <= 0) return;
    let u = entitiesById.get(id);
    if (!(u && u.type === 'unit' && u.team === team && u.hp > 0 &&
          !u.garrisonedIn && u.task !== 'garrison' && canGarrisonIn(b, team, u))) return;
    if (u.order) issueOrder(u, null);        // LAST ORDER WINS (mirrors execUnitCommand)
    u.target = null; u.buildTarget = null; u.buildQueue = []; u.explicitAttack = false;
    u.task = 'garrison'; u.garrisonTarget = b.id;
    // A ram is a moving point (no footprint); a building routes to its edge.
    if (b.type === 'unit') pathUnitTo(u, Math.round(b.x), Math.round(b.y));
    else pathToContact(u, b);
    room--; sent++;
  });
  feedbackFor(team, () => { if (!sent && typeof showMsg === 'function') showMsg('No room to garrison'); });
  if (team === myTeam && typeof updateUI === 'function') updateUI();
}

// THE attack assignment — the ONE way any controller (a human command OR
// js/ai.js) points a unit at a target, so AI attacks carry exactly the
// semantics a player's attack-click does (parity: the AI can't do anything
// a human couldn't):
//   - LAST ORDER WINS: the standing order is replaced (a guard picket must
//     never leash a committed attacker home);
//   - explicitAttack: committed — leash-exempt, survives fog loss per the
//     human rules, mop-up on target death (human teams);
//   - the ANCHOR moves to the target ("hold the ground you take"): a
//     DEFENSIVE unit that finishes the assault leashes to the battlefield,
//     not back to wherever it stood when ordered;
//   - task/build/path cleared like any redirect.
function assignAttack(u, target){
  if (u.order) issueOrder(u, null);
  u.target = target.id; u.task = null; clearUnitPath(u); u.buildTarget = null;
  u.explicitAttack = true;
  u.defendX = Math.round(target.x); u.defendY = Math.round(target.y);
}

// ---- THE EXCLUSIVE ORDER SLOT ----
// One standing order per unit (e.order); issuing ANY order replaces the old
// one — "last order wins", no pairwise interaction rules. Kinds:
//   {kind:'move', x, y}              multi-leg walk goal
//   {kind:'follow', id, x, y}        keep up with a friendly unit (x/y =
//                                    this follower's formation offset from it)
//   {kind:'guard', x, y}             hold a ground post (zone acquire + leash)
//   {kind:'guardBuilding', id, x, y}  perimeter watch; x,y = assigned post tile
//   {kind:'escort', id, x, y}        guard a moving unit (zone rides on it;
//                                    x/y = this escort's ring offset)
//   {kind:'scout'}                   auto-explore, ignores combat
// TEAM-AGNOSTIC by construction (no isHumanTeam/myTeam in here): the human
// command executors and js/ai.js both call this. Stance stays the unit's
// REACTION POLICY (STANCES, js/logic.js) — orders say WHAT, stance HOW.
const ORDER_KINDS = new Set(['move','follow','guard','guardBuilding','escort','scout']);
const GUARD_ORDER_KINDS = new Set(['guard','guardBuilding','escort']);
function issueOrder(e, order){
  if (order != null && !ORDER_KINDS.has(order.kind)) return false;
  // A guard-family order un-passives (a passive guard is an inert
  // contradiction — it could neither acquire nor retaliate at its post).
  // Postures are mutually exclusive both ways: set-stance clears guard
  // orders, and a guard order un-passives — a passive guard could neither
  // acquire nor retaliate (the "inert guard" bug).
  if (order != null && GUARD_ORDER_KINDS.has(order.kind) && e.stance === 'passive') e.stance = 'aggressive';
  e.order = order || null;
  // Fresh order → fresh guard-return attempts (a unit that backed off at an
  // old post must not ignore its new one for the T30(600) back-off).
  if (e.retry && e.retry['guardret']) e.retry['guardret'].n = 0;
  return true;
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
// THE formation concept — one function, used by every group order: a
// group's destination shape IS its own current arrangement, translated to
// the anchor. Offsets are unit − centroid, uniformly COMPACTED to a
// ~sqrt(n) radius when the group is strung out (a loose gather line
// arrives as a group, not a 20-tile string), and rounded collisions walk
// the diamond ring outward to the nearest free tile (stacked rally output
// fans out; excludeCenter keeps the anchor tile itself free — the leader's
// tile under a follow/escort). Consumers: group moves (anchor = click),
// ground guard flags + AI pickets (anchor = the flag/rally point — the
// compaction is what forms scattered units into a tight post cluster),
// and follow/escort stations (anchor = the moving leader, offsets ride
// the order's hashed x/y fields).
// Slot-assignment formations are structurally arbitrary — for a distant
// anchor every slot is roughly equidistant from every unit — so translating
// the group's own shape sidesteps the assignment problem entirely.
// Deterministic: command-payload/scan unit order, exact-order float math.
// AoE2 LINE formation: crisp RANKS perpendicular to the march direction —
// melee front, archers behind, siege rear, everyone else last; each rank a
// centered row, rows stacked from the front and centered on the target.
// `dir` (optional world vector) orients the front; omitted → SE. Replaces
// the compact-own-arrangement scheme, under which a scattered selection
// arrived still scattered — "formations don't work" (user caught it).
function formationOffsets(units, excludeCenter, dir){
  let off = new Map();
  if (!units.length) return off;
  let dx = (dir && (dir.dx || dir.dy)) ? dir.dx : 1;
  let dy = (dir && (dir.dx || dir.dy)) ? dir.dy : 1;
  let L = simHypot(dx, dy) || 1; dx /= L; dy /= L;
  let px = -dy, py = dx;                       // the rank (row) axis
  const rankOf = u => u.utype === 'archer' ? 1 : u.utype === 'ram' ? 2 : isArmyUnit(u.utype) ? 0 : 3;
  let sorted = [...units].sort((a, b) => rankOf(a) - rankOf(b) || a.id - b.id);
  let W = Math.max(2, Math.ceil(Math.sqrt(sorted.length) * 1.6));
  // Rows fill to W and break at class boundaries so ranks stay pure.
  let rows = [], row = [], rowRank = rankOf(sorted[0]);
  for (const u of sorted) {
    let r = rankOf(u);
    if (row.length >= W || r !== rowRank) { rows.push(row); row = []; rowRank = r; }
    row.push(u);
  }
  if (row.length) rows.push(row);
  let taken = new Set(excludeCenter ? ['0,0'] : []);
  let R = Math.ceil(Math.sqrt(units.length)) + 1;
  rows.forEach((r, ri) => {
    let back = ri - (rows.length - 1) / 2;     // rows centered on the target
    r.forEach((u, ci) => {
      let side = ci - (r.length - 1) / 2;
      let ox = Math.round(px * side - dx * back), oy = Math.round(py * side - dy * back);
      if (taken.has(ox + ',' + oy)) {
        outer: for (let rr = 1; rr <= R + 2; rr++) {
          for (let i = 0; i < 4 * rr; i++) {
            let sideq = Math.floor(i / rr), j = i % rr, qx, qy;
            if (sideq === 0) { qx = rr - j; qy = j; }
            else if (sideq === 1) { qx = -j; qy = rr - j; }
            else if (sideq === 2) { qx = -(rr - j); qy = -j; }
            else { qx = j; qy = -(rr - j); }
            if (!taken.has((ox + qx) + ',' + (oy + qy))) { ox += qx; oy += qy; break outer; }
          }
        }
      }
      taken.add(ox + ',' + oy);
      off.set(u.id, [ox, oy]);
    });
  });
  return off;
}

function execGuard(cmd, team){
  let units = (cmd.unitIds || []).map(id => entitiesById.get(id))
    .filter(u => u && u.team === team && u.hp > 0 && !u.garrisonedIn && guardEligible(u));
  if (!units.length) return;
  // Re-resolve and validate the flagged target: own/allied only — a tap on
  // an enemy or gaia thing falls through to a ground post at that spot.
  let target = cmd.targetId != null ? entitiesById.get(cmd.targetId) : null;
  if (target && (target.hp <= 0 || target.garrisonedIn || !sameSide(target.team, team))) target = null;
  let finish = (u, order, px, py) => {
    issueOrder(u, order); // replaces any standing order; un-passives (no inert guards)
    u.target = null; u.task = null;
    u.explicitAttack = false;
    clearUnitPath(u);
    pathUnitTo(u, Math.round(px), Math.round(py));
  };
  if (target && target.type === 'unit') {
    // ESCORT: the zone rides on the escortee (guardZoneOf reads its live
    // position); updateFollowOrder does the walking off order.id, aiming at
    // escortee + this escort's station offset (order x/y — hashed) so a
    // large escort holds a compact arrangement around the cart instead of
    // dogpiling its tile (excludeCenter keeps the escortee's tile free).
    let eOff = formationOffsets(units.filter(u => u.id !== target.id), true);
    units.forEach(u => {
      if (u.id === target.id) return; // can't escort yourself
      let [ox, oy] = eOff.get(u.id) || [0, 0];
      finish(u, {kind:'escort', id: target.id, x: ox, y: oy}, target.x + ox, target.y + oy);
    });
  } else if (target && target.type === 'building') {
    // Fan the guards OUT around the footprint (claimed set) so they cover the
    // whole building instead of piling onto its nearest corner — the leash
    // (js/logic.js) anchors each to the building as a whole, but the RETURN
    // walk targets each guard's own assigned tile (order.x/y).
    let claimed = new Set();
    units.forEach(u => {
      let pt = nearestBldgPerimeter(u.x, u.y, target, u.id, claimed);
      claimed.add(pt.x + ',' + pt.y);
      finish(u, {kind:'guardBuilding', id: target.id, x: pt.x, y: pt.y}, pt.x, pt.y);
    });
  } else {
    let x = Math.max(0, Math.min(MAP - 1, Math.round(cmd.x)));
    let y = Math.max(0, Math.min(MAP - 1, Math.round(cmd.y)));
    let gOff = formationOffsets(units, false);
    units.forEach(u => {
      let [ox, oy] = gOff.get(u.id) || [0, 0];
      let px = Math.max(0, Math.min(MAP - 1, x + ox)), py = Math.max(0, Math.min(MAP - 1, y + oy));
      finish(u, {kind:'guard', x: px, y: py}, px, py);
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
    if (on) {
      issueOrder(u, {kind:'scout'}); // replaces any standing order — exploring IS the new order
      u.target = null; u.explicitAttack = false; u.task = null; clearUnitPath(u);
    } else if (u.order && u.order.kind === 'scout') {
      // Toggle-off clears ONLY a scout order — never an unrelated order
      // issued between the two commands in the same input-delay window.
      issueOrder(u, null);
    }
  });
  feedbackFor(team, () => { if (window.playSound) playSound('click'); });
  if (team === myTeam && typeof updateUI === 'function') updateUI();
}

// Commodity exchange: buy or sell 100 of a resource for gold at the GLOBAL
// price (marketPrices, js/core.js — one shared table, AoE2-style: everyone's
// trades move the same market). Mutation MUST run here in the deterministic
// executor, never client-side. Integer math.
function execMarketTrade(cmd, team){
  let res = cmd.resType;
  if (res !== 'food' && res !== 'wood' && res !== 'stone') return;
  // Authoritative gate: the team must actually own a completed Market.
  let hasMarket = entities.some(b => b.type === 'building' && b.btype === 'MARKET' && b.team === team && b.complete && b.hp > 0);
  if (!hasMarket) return;
  let store = resourceStore(team);
  // marketSellRatio bakes in the per-team Guilds discount.
  let mp = marketPrices;
  let price = mp[res];
  if (cmd.dir === 'buy') {
    if (store.gold < price) { feedbackFor(team, () => showMsg('Not enough gold.')); return; }
    store.gold -= price;
    store[res] += MARKET_LOT;
    mp[res] = Math.min(MARKET_PRICE_MAX, price + MARKET_PRICE_STEP);
  } else if (cmd.dir === 'sell') {
    if (store[res] < MARKET_LOT) { feedbackFor(team, () => showMsg('Not enough ' + res + ' to sell.')); return; }
    store[res] -= MARKET_LOT;
    store.gold += Math.floor(price * marketSellRatio(team) / 100);
    mp[res] = Math.max(MARKET_PRICE_MIN, price - MARKET_PRICE_STEP);
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
  // Building targets: kept only where the BUILDING is the point (see
  // isRallyBuildingTarget above); a flag on any other friendly building is
  // just a flag on the ground there.
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

  // Garrison-in-ram (AoE2 garrison-rams): a right-click on an OWN ram with
  // melee infantry selected loads them in (js/input.js ships the ram as
  // targetId for exactly this case). Resolved directly from cmd (like the
  // trade-cart Market click) because `target` is nulled for own-team
  // entities above.
  let ramTarget = cmd.targetId != null ? entitiesById.get(cmd.targetId) : null;
  if (!(ramTarget && ramTarget.type === 'unit' && ramTarget.utype === 'ram'
        && ramTarget.team === myTeam && ramTarget.hp > 0 && !ramTarget.garrisonedIn)) ramTarget = null;
  // Slot accounting across the whole selection (same idea as ringTownBell's
  // per-container reservations): seats already taken plus riders already
  // WALKING to board count against the cap, and each boarding order issued
  // below consumes one — surplus infantry fall through to the follow branch
  // (escort) instead of marching to a full ram and idling there.
  let ramRoom = ramTarget ? ramSeatsFree(ramTarget) : 0;

  let movers = selected.filter(s => s.type === 'unit');
  // Group-move destinations / follow stations: the shared formation
  // concept (formationOffsets above). Following a unit anchors the
  // arrangement on the LEADER (excludeCenter keeps its own tile free —
  // otherwise a big group dogpiles the leader's exact tile).
  // Ranks face the march: toward the clicked tile (or the followed leader).
  let fcx = 0, fcy = 0;
  movers.forEach(m => { fcx += m.x; fcy += m.y; });
  fcx /= movers.length || 1; fcy /= movers.length || 1;
  let fDir = followTarget ? { dx: followTarget.x - fcx, dy: followTarget.y - fcy }
           : { dx: (tileX + 0.5) - fcx, dy: (tileY + 0.5) - fcy };
  let formOff = formationOffsets(movers, !!followTarget, fDir);
  let slotFor = m => formOff.get(m.id) || [0, 0];
  // CONVOY: a plain group move marches as a BODY — the most central unit
  // leads with the move order, the rest hold their formation offsets
  // relative to it via FOLLOW stations (updateFollowOrder), so the group
  // musters at once and travels together instead of each unit walking its
  // own line and only meeting at the destination (user caught the
  // scattered march). Deterministic leader: smallest slot, id tiebreak.
  let convoyLeader = null, leaderSlot = [0, 0];
  if (!target && !buildTarget && !followTarget && !ramTarget) {
    let mil = movers.filter(m => isArmyUnit(m.utype) || m.utype === 'ram');
    if (mil.length > 1) {
      let best = null, bestD = Infinity;
      for (const m of mil) {
        let [ox, oy] = slotFor(m), d = Math.abs(ox) + Math.abs(oy);
        if (d < bestD || (d === bestD && best && m.id < best.id)) { best = m; bestD = d; }
      }
      convoyLeader = best;
      leaderSlot = slotFor(convoyLeader);
    }
  }
  // AoE2 formation pace: a group order moves everyone at the slowest
  // member's speed (see unitMoveSpeed, js/logic.js) so the group arrives
  // together instead of trickling in fastest-first. Solo orders run free.
  let groupSpeed = movers.length > 1
    ? Math.min(...movers.map(m => m.speed || 1)) : undefined;
  movers.forEach(s => {
    s.groupSpeed = groupSpeed;
    s.gatherX = -1; s.gatherY = -1; s.prevTask = null; s.savedTask = null; // fully clear old state
    // LAST ORDER WINS: every manual command replaces the standing order —
    // the branch below issues the new one (move→move, follow→follow, …).
    if (s.order) issueOrder(s, null);
    s.buildTarget = null;
    s.buildQueue = [];
    s.defendX = s.x; s.defendY = s.y;
    s.explicitAttack = false;
    s.explicitReseed = false;
    if (ramTarget && s.id !== ramTarget.id && canRideRam(s) && canGarrisonIn(ramTarget, s.team, s) && ramRoom > 0) {
      // Ride the ram: same walk-to-container flow as the town bell
      // (task='garrison' + garrisonTarget; enterGarrison seats on arrival).
      ramRoom--;
      s.target = null; s.task = 'garrison'; s.garrisonTarget = ramTarget.id;
      pathUnitTo(s, Math.round(ramTarget.x), Math.round(ramTarget.y));
      return;
    }
    if (s.utype === 'tradecart') {
      // Trade carts route to a Market, they don't attack. Resolve the clicked
      // entity directly from cmd (NOT the `target` var, which is nulled for
      // allied/friendly buildings above) so trading with an ALLIED market — not
      // just an enemy one — works, per AoE2. Any non-market order cancels the
      // route and becomes a plain move.
      let mkt = cmd.targetId != null ? entitiesById.get(cmd.targetId) : null;
      // An UNDER-CONSTRUCTION market is a valid destination: the route is
      // set and the cart waits at the site until it completes
      // (updateTradeCart trades only against complete markets). Same for the
      // home market — a route ordered while your own market is still going
      // up starts the moment it finishes.
      let validMkt = mkt && mkt.type === 'building' && mkt.btype === 'MARKET' && mkt.hp > 0 && mkt.team !== s.team && isPlayerTeam(mkt.team);
      if (validMkt) {
        let home = nearestMarket(s, true, true);
        if (!home) {
          feedbackFor(s.team, () => showMsg('Build your own Market before trading.'));
        } else {
          s.tradeDestId = mkt.id; s.tradeHomeId = home.id; s.tradePhase = 'toDest';
          s.target = null; s.task = null; clearUnitPath(s);
          pathToContact(s, mkt);
        }
      } else {
        s.tradeDestId = null; s.tradeHomeId = null; s.tradePhase = null;
        s.carrying = 0; s.carryType = null; s.target = null; s.task = null;
        let [ox, oy] = slotFor(s);
        s.task = null; issueMoveOrder(s, tileX + ox, tileY + oy);
      }
      return;
    }
    if (buildTarget && s.utype === 'villager') {
      // Dispatch to a HEALTHY work building skips the build march: the
      // villager tasks straight onto the camp's resource at order time
      // (autoTaskBuilder) instead of walking to the camp first and
      // re-tasking there (user call). Anything needing work — unbuilt,
      // damaged, exhausted farm — keeps the build/repair order below.
      if (buildTarget.complete && buildTarget.hp >= buildTarget.maxHp
          && !(buildTarget.btype === 'FARM' && buildTarget.exhausted)) {
        s.target = null; s.task = null; s.buildTarget = null;
        autoTaskBuilder(s, buildTarget, !isAITeam(s.team));
        if (!s.task) { pathToBuilding(s, buildTarget); return; } // no resource found: plain walk to the camp
        // A MATCHING load banks first (the deposit is on the way — the
        // return leg resumes the gather via prevTask); a MISMATCHED one
        // is lost the instant the order lands (AoE2), so the carry
        // visual never survives into the new job (user call).
        if (s.carrying > 0) {
          let gres = GATHER_TASKS[s.task] && GATHER_TASKS[s.task].resource;
          if (s.carryType === gres && nearestDrop(s, s.carryType)) {
            s.prevTask = s.task; s.task = 'return'; clearUnitPath(s);
          } else if (s.carryType !== gres) {
            s.carrying = 0; s.carryType = null;
          }
        }
        return;
      }
      s.target = null; s.task = 'build'; s.buildTarget = buildTarget.id;
      // Clicking an exhausted farm is a deliberate "reseed it" order (like
      // clicking a damaged building to repair) — flag it so the reseed pays
      // wood directly, bypassing the Mill prepaid queue. Automatic reseed
      // paths (exhaustion-continuity, auto-wander) leave this false and stay
      // prepaid-only for humans, so wood is never spent behind their back.
      s.explicitReseed = buildTarget.btype === 'FARM' && buildTarget.exhausted;
      pathToBuilding(s, buildTarget);
    } else if (target) {
      if (s.utype === 'sheep') { return; } // sheep don't attack
      if ((target.utype === 'sheep' || target.utype === 'sheep_carcass') && s.utype !== 'villager') {
        // Sheep or carcass targeted by military unit: treat as move command!
        s.target = null;
        let [ox, oy] = slotFor(s);
        s.task = null; issueMoveOrder(s, tileX + ox, tileY + oy);
      } else {
        assignAttack(s, target);
        // Butchering yields FOOD: a mismatched load is lost the instant the
        // order lands (same AoE2 rule as the gather-task paths) — butcher is
        // target-based, so the GATHER_TASKS retask backstop never covers it.
        if (s.utype === 'villager' && (target.utype === 'sheep' || target.utype === 'sheep_carcass')
            && s.carrying > 0 && s.carryType !== 'food') {
          s.carrying = 0; s.carryType = null;
        }
      }
    } else if (followTarget && followTarget.id !== s.id && s.utype !== 'sheep') {
      // AoE2-style "Follow": keep pathing toward the followed unit's current
      // position PLUS this follower's formation offset (updateFollowOrder in
      // js/logic.js drives the re-pathing) — the group holds its arrangement
      // AROUND the leader instead of mobbing its tile. The offset rides the
      // order's x/y fields, which the detEntityHash order block already
      // hashes for every kind.
      s.target = null; s.task = null;
      let [fox, foy] = slotFor(s);
      issueOrder(s, {kind:'follow', id: followTarget.id, x: fox, y: foy});
      pathUnitTo(s, Math.max(0, Math.min(MAP - 1, Math.round(followTarget.x) + fox)),
                    Math.max(0, Math.min(MAP - 1, Math.round(followTarget.y) + foy)));
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
        // if the tile is still UNEXPLORED for this team, the player doesn't
        // know what's there, so the click is a plain WALK — the villager
        // goes and stands idle instead of auto-gathering an unseen resource.
        // Deterministic (teamExploredGrid is sim state); one rule for every
        // team (information parity), same gate as canPlace (js/logic.js)
        // and findNearTile's gather scan.
        let unseen = tileHiddenForTeam(s.team, tileY*MAP + tileX);
        if (gTask && !unseen) {
          let g = claimGatherTileNear(s, t.t, tileX, tileY);
          s.task = gTask; s.gatherX = g.x; s.gatherY = g.y;
          // AoE2: a mismatched load is lost the INSTANT the gather order
          // lands — zeroing on the next sim tick left one rendered frame
          // of the stale carry (user call).
          if (s.carrying > 0 && s.carryType && s.carryType !== GATHER_TASKS[gTask].resource) {
            s.carrying = 0; s.carryType = null;
          }
          // Ring the solid node evenly: goalBldg + contactClaims sends each
          // co-gatherer to a distinct cheapest contact tile.
          pathToContact(s, {x:g.x, y:g.y, w:1, h:1}, contactClaims(s, p=>p.gatherX===g.x && p.gatherY===g.y));
        } else {
          // Move command (also the unexplored-tile case): keep the
          // group's relative arrangement (see formOff above).
          let [ox, oy] = slotFor(s);
          s.task = null; issueMoveOrder(s, tileX + ox, tileY + oy);
        }
      } else {
        // Military move: keep the group's relative arrangement (formOff).
        // The guard-post relocation ("this is your temp spot") lives inside
        // issueMoveOrder itself, so every plain-move site gets it without a
        // paired re-pin.
        let [ox, oy] = slotFor(s);
        if (convoyLeader && s.id !== convoyLeader.id && (isArmyUnit(s.utype) || s.utype === 'ram')) {
          // Follower: station = leader + (own slot − leader slot); the
          // leader's arrival composes the exact destination formation.
          // Followers run at NATURAL speed (no group clamp) — station-
          // holding paces them, and the headroom is what lets stragglers
          // actually close on a moving leader.
          let rx = ox - leaderSlot[0], ry = oy - leaderSlot[1];
          s.task = null; s.groupSpeed = undefined;
          // gx/gy = this follower's OWN destination tile: a convoy follow is
          // a one-shot group move, not a standing bond — it converts to a
          // plain move if the leader dies (the destination must not die with
          // it) and dissolves on arrival (updateFollowOrder, js/logic.js).
          issueOrder(s, {kind:'follow', id: convoyLeader.id, x: rx, y: ry,
                         gx: Math.max(0, Math.min(MAP - 1, tileX + ox)),
                         gy: Math.max(0, Math.min(MAP - 1, tileY + oy))});
          pathUnitTo(s, Math.max(0, Math.min(MAP - 1, Math.round(convoyLeader.x) + rx)),
                        Math.max(0, Math.min(MAP - 1, Math.round(convoyLeader.y) + ry)));
        } else {
          // The leader marches at 85% of the slowest member (AoE2
          // formations move slower than solo units): equal speeds meant
          // followers chasing a moving station never closed the gap and
          // the "formation" only assembled on arrival.
          if (convoyLeader && s.id === convoyLeader.id && groupSpeed !== undefined)
            s.groupSpeed = groupSpeed * 0.85;
          s.task = null; issueMoveOrder(s, tileX + ox, tileY + oy);
        }
      }
    }
  });
}

// ---- Shared building-placement primitives ----
// The geometry + wall-replacement rules for placing a WALL/GATE/TOWER/any
// building live here so the player build command, the AI, and the scenario
// editor (js/editor.js) all place identically — no reinvented gate-footprint
// or wall-consume logic drifting between them. Two halves so a caller can
// price the placement (refund consumed walls, afford-check) BEFORE committing:
//   resolveBuildingPlacement() — PURE: where it sits + which walls it replaces.
//   commitBuildingPlacement()  — mutates: removes those walls, creates the bldg.
//
// A gate sizes to the run of matching same-team walls through the click
// (gateFootprint); a tower/stone-wall on a wall tile replaces it. `replaced`
// is the same wall set the old inline code removed (deduped; order doesn't
// affect the sim — removal is set-based and wall-cost refund is commutative).
function resolveBuildingPlacement(btype, tx, ty, team){
  let b = BLDGS[btype];
  let ox = tx, oy = ty, gw = b ? b.w : 1, gh = b ? b.h : 1;
  if (isGateBtype(btype)) {
    ({ ox, oy, gw, gh } = gateFootprint(tx, ty, (x, y) => gateBaseAt(x, y, btype, team)));
  }
  let replaced = [];
  for (let dy = 0; dy < gh; dy++) for (let dx = 0; dx < gw; dx++) {
    let w = entities.find(en => en.type === 'building' && en.x === ox + dx && en.y === oy + dy && isWallBtype(en.btype) && en.team === team);
    if (w && replaced.indexOf(w) < 0) replaced.push(w);
  }
  if (isTowerBtype(btype)) {
    // A tower consumes the wall it sits on (palisade→stone upgrades never reach
    // here — a complete counterpart swaps in place, an unbuilt one is overwritten;
    // both handled in execBuildPlacement).
    let ex = entities.find(en => en.type === 'building' && en.x === tx && en.y === ty && isWallBtype(en.btype) && en.team === team);
    if (ex && replaced.indexOf(ex) < 0) replaced.push(ex);
  }
  if (isGateBtype(btype)) {
    // A gate over an existing same-type gate (repair): collect it so it's
    // replaced. Occupancy grid → finds the multi-tile gate on any tile.
    for (let dy = 0; dy < gh; dy++) for (let dx = 0; dx < gw; dx++) {
      let row = map[oy + dy]; let id = row && row[ox + dx] && row[ox + dx].occupied;
      let g = id && entitiesById.get(id);
      if (g && g.type === 'building' && g.btype === btype && g.team === team && replaced.indexOf(g) < 0) replaced.push(g);
    }
  }
  return { ox, oy, gw, gh, replaced };
}
// Remove the replaced walls and create the building. `complete` → a finished
// building at full HP (scenario editor); otherwise a foundation at hp 1 that
// villagers build up (gameplay). Returns the new building (or null).
function commitBuildingPlacement(btype, plan, team, complete){
  if (plan.replaced.length) {
    let ids = new Set(plan.replaced.map(w => w.id));
    entities = entities.filter(en => !ids.has(en.id));
    selected = selected.filter(s => !ids.has(s.id));
    ids.forEach(id => entitiesById.delete(id));
  }
  let bldg = createBuilding(btype, plan.ox, plan.oy, team, plan.gw, plan.gh);
  if (!bldg) return null;
  if (complete) {
    // Instant, solid building (editor only — every gameplay caller passes
    // complete=false). The editor's canPlace(rejectUnits) already refuses to
    // place on an occupied tile, so the footprint is clear here: no shove.
    bldg.complete = true;
  } else {
    bldg.complete = false; bldg.buildProgress = 0;
    bldg.hp = 1; // AoE2: foundations start at ~no HP and gain it as construction progresses
    // foundation: stays walkable; the build-gate clears the footprint gently
    // when a builder commits (clearFootprintForBuild) — no placement shove.
  }
  return bldg;
}

function execBuildPlacement(cmd){
  let btype = cmd.btype;
  if (!BLDGS[btype]) return;
  let tile = { x: cmd.tileX, y: cmd.tileY };
  let vils = selected.filter(s => s.type === 'unit' && s.utype === 'villager');
  if (vils.length === 0) return;
  if (canPlace(btype, tile.x, tile.y, myTeam)) {
    let b = BLDGS[btype];
    // Dropping a stone piece on its wooden counterpart IS the upgrade. A COMPLETE
    // counterpart salvage-swaps in place via the shared applyStoneUpgrade (so
    // hand-placement and the Upgrade button behave identically); an UNBUILT one
    // is cancelled+refunded and overwritten with a fresh stone site (handled just
    // below). Everything else keeps the build-placement path.
    let counterpart = stoneCounterpartAt(tile.x, tile.y, btype, myTeam);
    if (counterpart && counterpart.complete) {
      if (applyStoneUpgrade([counterpart], myTeam)) dispatchBuilders(vils, counterpart);
      return;
    }
    let plan = resolveBuildingPlacement(btype, tile.x, tile.y, myTeam);
    // The unbuilt counterpart is refunded+removed by overwriteUnbuiltFoundation
    // below; drop it from plan.replaced (a 1x1 wall counterpart lands there via the
    // wall scan) so commit treats the new piece as a fresh site, not a wall-consume.
    if (counterpart) plan.replaced = plan.replaced.filter(w => w !== counterpart);
    let consumes = isGateBtype(btype) || isTowerBtype(btype);
    let actualCost = effectiveBuildCost(btype, consumes ? plan.replaced : null);
    if (!canAfford(myTeam, actualCost)) { feedbackFor(myTeam, () => showMsg('Not enough resources!')); return; }
    if (counterpart) overwriteUnbuiltFoundation(counterpart, myTeam); // cancel the unbuilt piece before placing fresh
    spendCost(myTeam, actualCost);
    let bldg = commitBuildingPlacement(btype, plan, myTeam, false);
    if (!bldg) return;
    dispatchBuilders(vils, bldg);
  } else {
    feedbackFor(myTeam, () => { showMsg('Can\'t build here!'); if (window.playSound) playSound('error'); });
  }
}
// Queue villagers onto a build target and send each idle one to it (pathToBuilding:
// farm plot, else cheapest-walk contact tile).
function dispatchBuilders(vils, target){
  vils.forEach(v => {
    v.buildQueue = v.buildQueue || [];
    v.buildQueue.push(target.id);
    if (v.task !== 'build' || !v.buildTarget) {
      v.task = 'build'; v.buildTarget = target.id; v.target = null; v.savedTask = null;
      pathToBuilding(v, target);
    }
  });
}
// Overwriting an UNBUILT foundation (a wall/gate/tower still under construction,
// not yet a real piece): cancel it — full refund of what was paid to place it
// (AoE2 foundation-cancel; the whole cost is spent up front), and drop the entity
// so the new piece takes its tile as a fresh construction site. A COMPLETE piece
// upgrades in place via applyStoneUpgrade instead. Direct delete, NOT handleDeath
// — it isn't dying, and it can't hold garrison (incomplete).
function overwriteUnbuiltFoundation(en, team){
  refundCost(team, BLDGS[en.btype].cost);
  entities = entities.filter(e => e !== en);
  entitiesById.delete(en.id);
  selected = selected.filter(s => s !== en);
}
// The allied wooden piece under (x,y) that `btype` upgrades (WALL_STONE_MATCH),
// or null. Shared by the placement + wall-drag paths so both detect an upgrade
// target identically (complete → salvage-swap, unbuilt → overwrite).
function stoneCounterpartAt(x, y, btype, team){
  let row = map[y]; let id = row && row[x] && row[x].occupied;
  let e = id && entitiesById.get(id);
  return (e && e.type === 'building' && e.team === team && WALL_STONE_MATCH[e.btype] === btype) ? e : null;
}

// Wall drag (resolver: finalizeWallDrag, js/input.js).
function execWallDrag(cmd){
  let vils = selected.filter(s => s.type === 'unit' && s.utype === 'villager');
  if (vils.length === 0) return;
  let line = getWallElbowTiles(cmd.start, cmd.corner || cmd.end, cmd.end);
  let wallB = isWallBtype(cmd.btype) ? cmd.btype : 'WALL';
  let b = BLDGS[wallB];
  let targets = [];   // new foundations + in-place upgrades, in drag order
  let upgrades = [];  // palisade counterparts to salvage-swap in one batch
  line.forEach(t => {
    if (!canPlace(wallB, t.x, t.y, myTeam)) return;
    // A stone wall dragged over an allied palisade IS the upgrade: a COMPLETE one
    // salvage-swaps in place (batched below), an UNBUILT one is cancelled+refunded
    // and overwritten fresh — either way nothing stacks on the tile.
    let counterpart = stoneCounterpartAt(t.x, t.y, wallB, myTeam);
    if (counterpart && counterpart.complete) {
      upgrades.push(counterpart); targets.push(counterpart);
      return;
    }
    let actualCost = { ...b.cost };
    if (canAfford(myTeam, actualCost)) {
      if (counterpart) overwriteUnbuiltFoundation(counterpart, myTeam); // cancel the unbuilt palisade first
      spendCost(myTeam, actualCost);
      let bldg = createBuilding(wallB, t.x, t.y, myTeam);
      bldg.complete = false;
      bldg.buildProgress = 0;
      bldg.hp = 1; // AoE2 foundation HP — the drag path skipped this and unbuilt walls soaked full maxHp (user caught it)
      targets.push(bldg);
    } else {
      feedbackFor(myTeam, () => { showMsg('Not enough stone!'); if (window.playSound) playSound('error'); });
    }
  });
  // Batch the counterpart upgrades (one afford/salvage pass, like the button). A
  // batch that can't afford aborts inside applyStoneUpgrade — drop those targets.
  if (upgrades.length && !applyStoneUpgrade(upgrades, myTeam)) targets = targets.filter(t => upgrades.indexOf(t) < 0);
  if (!targets.length) return;
  vils.forEach(v => {
    v.buildQueue = v.buildQueue || [];
    targets.forEach(t => v.buildQueue.push(t.id));
    if (v.task !== 'build' || !v.buildTarget) {
      let last = targets[targets.length - 1];
      v.task = 'build'; v.buildTarget = last.id; v.target = null;
      pathUnitTo(v, last.x + 1, last.y + 1);
    }
  });
}

// Train / cancel (resolvers: trainUnit/cancelQueue, js/ui.js).
function execTrainUnit(bldg, utype){
  let result = queueUnit(bldg, utype);
  feedbackFor(myTeam, () => {
    if (result.reason === 'pop') showMsg('Need more houses!');
    else if (result.reason === 'resources') showMsg('Not enough resources!');
    else if (result.reason === 'age') showMsg('Requires the ' + AGES[ageReq(utype)].name + '!');
    if (result.reason && window.playSound) playSound('error');
  });
}

// Start a research at this building — age advancement (target 'age', stored
// as the numeric next-age index; TC only) or a tech (target = an UPGRADES key,
// stored as the string; at the building that OWNS it). The research is a plain
// field on the building entity ({target, tick}) so it rides saves and lockstep
// rollbacks, and dies (unrefunded on death, AoE2-style) with the building. ONE
// research at a time per building; a second owner parallelizes. feedbackFor gates toasts so
// the human never sees an AI's research messages (the AI calls this directly).
function execResearch(bldg, target){
  // Age advancement runs at the TOWN CENTER; a tech runs at the building that
  // OWNS it (its BLDGS.researches list — Barracks/Mill/Lumber/Mining/Market/TC).
  let okBldg = target === 'age'
    ? bldg.btype === 'TC'
    : !!(BLDGS[bldg.btype].researches && BLDGS[bldg.btype].researches.includes(target));
  if (!okBldg || !bldg.complete || bldg.research) return;
  if (target === 'age') {
    let next = teamAge[bldg.team] + 1;
    if (next >= AGES.length) return;
    let cost = AGES[next].cost;
    if (!canAfford(bldg.team, cost)) {
      feedbackFor(bldg.team, () => { showMsg('Not enough resources to advance!'); if (window.playSound) playSound('error'); });
      return;
    }
    spendCost(bldg.team, cost);
    bldg.research = { target: next, tick: 0 }; // numeric target = age-up (timed at the TC)
    feedbackFor(bldg.team, () => showMsg('Advancing to the ' + AGES[next].name + '…'));
  } else {
    let c = UPGRADES[target];
    if (!c || !canResearch(bldg.team, target)) return; // unknown/owned/age-locked/prereq
    // TESTING: instant + free — click applies the upgrade immediately, no timer
    // and no cost (INSTANT_TECH_RESEARCH). The timed/paid path below returns
    // when we re-add research duration + prices.
    if (INSTANT_TECH_RESEARCH) {
      applyTech(bldg.team, target);
      feedbackFor(bldg.team, () => { showMsg(c.name + ' researched!'); if (window.playSound) playSound('build'); });
    } else {
      // TECH_PRICES gates cost — off = free (only the timed clock gates it).
      if (TECH_PRICES) {
        if (!canAfford(bldg.team, c.cost)) {
          feedbackFor(bldg.team, () => { showMsg('Not enough resources to research!'); if (window.playSound) playSound('error'); });
          return;
        }
        spendCost(bldg.team, c.cost);
      }
      bldg.research = { target: target, tick: 0 }; // string target = tech (timed on the owning building)
      feedbackFor(bldg.team, () => showMsg('Researching ' + c.name + '…'));
    }
  }
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
// The site is a normal foundation from here: villagers finish it and it
// cancels/refunds like any other building (deleteOwnedEntity, js/logic.js).
// WALL_STONE_MATCH (palisade→stone families) lives in js/core.js.
// Shared by the exec below and the UI button's net-cost preview (js/ui.js).
function upgradeSalvage(en){
  let frac = Math.min(1, en.hp / en.maxHp), refund = {};
  Object.entries(BLDGS[en.btype].cost).forEach(([k, v]) => { refund[k] = Math.floor(v * frac); });
  return refund;
}
// THE wood→stone mechanism. Salvage-swap palisade pieces to their stone
// counterparts IN PLACE: HP-scaled refund credited before the full stone charge,
// garrison ejected, each piece reset to a normal construction site villagers
// build up. The Upgrade button (execUpgradeWalls), build-over placement
// (execBuildPlacement) and wall-drag (execWallDrag) all funnel here, so a stone
// piece dropped on its wooden counterpart behaves identically everywhere. Returns
// true if the swap happened (a construction site now exists), false if it aborted
// (age-locked/unaffordable) so callers know whether to dispatch builders.
function applyStoneUpgrade(pieces, team){
  // De-dup + validate: a repeated piece would double-charge and, worse, a second
  // pass reads WALL_STONE_MATCH[already-swapped btype] === undefined and blanks
  // the btype. Only own, complete, living palisade counterparts qualify.
  pieces = [...new Set(pieces)].filter(en => en && en.type === 'building' && WALL_STONE_MATCH[en.btype] && en.team === team && en.complete && en.hp > 0);
  if (!pieces.length) return false;
  let locked = pieces.find(en => !isUnlocked(team, WALL_STONE_MATCH[en.btype]));
  if (locked) {
    feedbackFor(team, () => { showMsg('Requires the ' + AGES[ageReq(WALL_STONE_MATCH[locked.btype])].name + '!'); if (window.playSound) playSound('error'); });
    return false;
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
    return false;
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
    // A normal construction site, same as execBuildPlacement foundations:
    // villagers build it up, it cancels/refunds like any other, and (unbuilt)
    // its tile is a walkable gap in the wall line until construction begins.
    w.complete = false; w.buildProgress = 0; w.hp = 1;
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
  return true;
}
function execUpgradeWalls(cmd, team){
  // Button path: the selected pieces' ids → the shared salvage-swap.
  applyStoneUpgrade((cmd.unitIds || []).map(id => entitiesById.get(id)), team);
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

// Cancel the in-progress research with a full refund (AoE2 refunds cancelled
// research). Handles both target shapes: numeric = age (AGES cost), string =
// tech (UPGRADES cost).
function execCancelResearch(bldg){
  if (!bldg.research) return;
  let t = bldg.research.target;
  let cost = (typeof t === 'number') ? AGES[t].cost : UPGRADES[t].cost;
  let label = (typeof t === 'number') ? 'Age research' : UPGRADES[t].name;
  refundCost(bldg.team, cost);
  bldg.research = undefined;
  feedbackFor(bldg.team, () => showMsg(label + ' cancelled (refunded)'));
  if (typeof updateUI === 'function') updateUI();
}

function execCancelQueue(bldgId, idx, team){
  let bldg = entitiesById.get(bldgId);
  if (!bldg || bldg.type !== 'building' || bldg.team !== team) return;
  let utype = bldg.queue[idx];
  if (!utype) return;
  // Refund exactly what was paid: the free rescue villager (first villager while
  // 0 living) refunds nothing, so cancelling it can't mint resources.
  let refund = unitTrainCost(bldg.team, utype, bldg.queue.slice(0, idx));
  bldg.queue.splice(idx, 1);
  refundCost(bldg.team, refund);
  if (idx === 0) bldg.trainTick = 0;
  feedbackFor(myTeam, () => showMsg(UNITS[utype].name + ' cancelled (refunded)'));
}

// Farm economy (resolvers: prepayFarm/reactivateFarm, js/ui.js).
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
  farm.buildProgress = farm.buildTime; // match the other reseed paths (reseedFarmForFarmer) — no odd complete-but-unhardened state
  farm.hp = farm.maxHp;
  let tile = map[farm.y][farm.x];
  tile.t = TERRAIN.FARM;
  tile.res = farmFoodFor(farm.team); // include Horse Collar / Heavy Plow food bonuses, like every other reseed path
  markMapDirty(farm.x, farm.y);
  feedbackFor(myTeam, () => showMsg('Farm reactivated!'));
  if (typeof updateUI === 'function') updateUI();
}
