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
// Roles today (host-authoritative sync still in place):
//   host / single-player: submitCommand schedules locally at tick+delay.
//   guest: submitCommand relays the resolved world-space cmd to the host
//     (js/net-cmd.js), which schedules it on ITS queue as team 1.
// The lockstep cutover only changes WHO schedules — both peers will
// schedule everything; the resolver/executor split stays as-is.

// ~67ms at the default GAME_SPEED=2 (60 ticks/sec): imperceptible for an
// RTS (AoE2 ran 250ms command turns) but enough headroom for the peer's
// command to arrive before its execution tick on a healthy link. Mutable:
// on a laggy real link the adaptive controller (js/lockstep.js) raises it
// via the 'set-delay' command so both peers switch at the same tick —
// otherwise the gating window stalls the sim in bursts (felt as lag).
let INPUT_DELAY_TICKS = 4;
const INPUT_DELAY_MIN = 2, INPUT_DELAY_MAX = 16;

let commandQueue = new Map(); // execTick -> [{team, seq, cmd}]
let localCmdSeq = 0;

function submitCommand(cmd){
  cmd.team = myTeam;
  if (typeof lockstepEnabled === 'function' && lockstepEnabled()) {
    // Lockstep: BOTH peers schedule the command at the issuer-stamped tick
    // and the issuer broadcasts it; the peer schedules it verbatim
    // (js/lockstep.js's 'cmd-ls' handler).
    let execTick = tick + INPUT_DELAY_TICKS;
    let seq = ++localCmdSeq;
    scheduleCommand(execTick, myTeam, seq, cmd);
    sendToPeer({ type: 'cmd-ls', execTick, seq, cmd });
    return;
  }
  if (netRole === 'guest') { sendCommand(cmd); return; }
  scheduleCommand(tick + INPUT_DELAY_TICKS, myTeam, ++localCmdSeq, cmd);
}

function scheduleCommand(execTick, team, seq, cmd){
  let arr = commandQueue.get(execTick);
  if (!arr) { arr = []; commandQueue.set(execTick, arr); }
  arr.push({ team, seq, cmd });
  detRecordCommand(execTick, team, seq, cmd); // no-op unless a replay log is active
}

// Called at the top of update() for the tick just started. Canonical order
// (team asc, then per-sender seq) so arrival order can never matter.
function runScheduledCommands(){
  let arr = commandQueue.get(tick);
  if (!arr) return;
  commandQueue.delete(tick);
  arr.sort((a, b) => a.team - b.team || a.seq - b.seq);
  arr.forEach(c => execCommand(c.cmd, c.team));
}

function clearCommandQueue(){
  commandQueue.clear();
  localCmdSeq = 0;
}

// Run fn with `selected`/`myTeam` swapped to the command's own units/team.
// The mutation code below (and the shared helpers it calls: canAfford,
// spendCost, resourceStore, canPlace...) reads those globals for every
// ownership/affordability check; swapping them lets one executor serve any
// team. Generalizes net-cmd.js's old withRemoteSelection to both roles.
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

// Dispatch one command. isReplayingRemoteCommand (js/net-cmd.js) gates all
// issuer-only feedback (showMsg/sounds/markers) inside the mutation code:
// true exactly when this command came from the OTHER player, so the local
// player never gets feedback for actions they didn't take.
function execCommand(cmd, team){
  if (!cmd || !cmd.kind) return;
  isReplayingRemoteCommand = (team !== myTeam);
  try {
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
      case 'prepay-farm':
        withCommandContext(team, [], () => prepayFarmNow());
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
        // Adaptive lockstep input delay (host-initiated; see the stall
        // controller in js/lockstep.js). Executes at the same tick on both
        // peers; lockstepApplyDelay handles the safe gating transition.
        if (team === 0 && cmd.d >= INPUT_DELAY_MIN && cmd.d <= INPUT_DELAY_MAX
            && typeof lockstepApplyDelay === 'function' && lockstepEnabled()) {
          lockstepApplyDelay(cmd.d);
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
      case 'dev-spawn':
        // Test-only scenario injection for multiplayer measurement: spawns
        // a deterministic army through the queue so both lockstep peers
        // create identical entities at the same tick. Requires an explicit
        // console opt-in on BOTH peers (window.DEV_TEST_COMMANDS = true);
        // inert otherwise. Used by tests/mp-lockstep-perf.js.
        if (window.DEV_TEST_COMMANDS) {
          let types = ['militia', 'archer', 'spearman', 'scout'];
          for (let i = 0; i < (cmd.n | 0) && i < 400; i++) {
            let t = findSpawnTile(cmd.x + (i % 20), cmd.y + ((i / 20) | 0), 12);
            if (t) createUnit(types[i % 4], t.x, t.y, i % 2);
          }
        }
        break;
      case 'town-bell':
        if (cmd.ringing) ringTownBell(team); else soundAllClear(team);
        if (typeof updateUI === 'function') updateUI();
        break;
    }
  } finally {
    isReplayingRemoteCommand = false;
  }
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
  bldg.rallyX = cmd.tileX;
  bldg.rallyY = cmd.tileY;
  let rTarget = cmd.targetId != null ? entitiesById.get(cmd.targetId) : null;
  if (rTarget) {
    bldg.rallyTargetId = rTarget.id;
    bldg.rallyResourceType = null;
  } else {
    let t0 = map[cmd.tileY] && map[cmd.tileY][cmd.tileX];
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
  // (enemy or gaia animal) — never a friendly unit.
  if (target && target.team === myTeam && target.utype !== 'sheep' && target.utype !== 'sheep_carcass') target = null;
  let buildTarget = cmd.buildTargetId != null ? entitiesById.get(cmd.buildTargetId) : null;
  if (buildTarget && (buildTarget.team !== myTeam || buildTarget.type !== 'building')) buildTarget = null;
  let followTarget = cmd.followId != null ? entitiesById.get(cmd.followId) : null;
  if (followTarget && (followTarget.hp <= 0 || followTarget.team !== myTeam)) followTarget = null;

  let movers = selected.filter(s => s.type === 'unit');
  let offsets = getFormation(movers.length);
  let idx = 0;
  movers.forEach(s => {
    s.gatherX = -1; s.gatherY = -1; s.prevTask = null; s.savedTask = null; // fully clear old state
    s.buildTarget = null;
    s.buildQueue = [];
    s.followId = undefined;
    s.defendX = s.x; s.defendY = s.y;
    s.explicitAttack = false;
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
        if (gTask) {
          let g = claimGatherTileNear(s, t.t, tileX, tileY);
          s.task = gTask; s.gatherX = g.x; s.gatherY = g.y; pathUnitTo(s, g.x, g.y);
        } else {
          // Move command: use formation offset
          let ox = offsets[idx] ? offsets[idx][0] : 0, oy = offsets[idx] ? offsets[idx][1] : 0;
          s.task = null; issueMoveOrder(s, tileX + ox, tileY + oy);
          idx++;
        }
      } else {
        // Military move: use formation offset
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
    if (btype === 'GATE') {
      let isWall = (tx, ty) => {
        let w = entities.find(en => en.type === 'building' && en.x === tx && en.y === ty && en.btype === 'WALL' && en.team === myTeam);
        return !!w;
      };
      if (isWall(tile.x, tile.y) && isWall(tile.x + 1, tile.y)) {
        ox = tile.x; oy = tile.y; gw = 2; gh = 1;
      } else if (isWall(tile.x - 1, tile.y) && isWall(tile.x, tile.y)) {
        ox = tile.x - 1; oy = tile.y; gw = 2; gh = 1;
      } else if (isWall(tile.x, tile.y) && isWall(tile.x, tile.y + 1)) {
        ox = tile.x; oy = tile.y; gw = 1; gh = 2;
      } else if (isWall(tile.x, tile.y - 1) && isWall(tile.x, tile.y)) {
        ox = tile.x; oy = tile.y - 1; gw = 1; gh = 2;
      }
    }
    let wallsToRemove = [];
    for (let dy = 0; dy < gh; dy++) {
      for (let dx = 0; dx < gw; dx++) {
        let w = entities.find(en => en.type === 'building' && en.x === ox + dx && en.y === oy + dy && en.btype === 'WALL' && en.team === myTeam);
        if (w) wallsToRemove.push(w);
      }
    }
    let actualCost = { ...b.cost };
    if (btype === 'GATE') {
      actualCost.s = Math.max(0, (actualCost.s || 0) - wallsToRemove.length * 5);
    } else if (btype === 'TOWER') {
      let existing = entities.find(en => en.type === 'building' && en.x === tile.x && en.y === tile.y && en.btype === 'WALL' && en.team === myTeam);
      if (existing) {
        actualCost.s = Math.max(0, (actualCost.s || 0) - 5);
        wallsToRemove.push(existing);
      }
    }
    if (!canAfford(myTeam, actualCost)) { if (!isReplayingRemoteCommand) showMsg('Not enough resources!'); return; }
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
    if (!isReplayingRemoteCommand) { showMsg('Can\'t build here!'); if (window.playSound) playSound('error'); }
  }
}

// Wall drag (moved verbatim from finalizeWallDrag's mutation half).
function execWallDrag(cmd){
  let vils = selected.filter(s => s.type === 'unit' && s.utype === 'villager');
  if (vils.length === 0) return;
  let line = getWallElbowTiles(cmd.start, cmd.corner || cmd.end, cmd.end);
  let b = BLDGS['WALL'];
  let placedCount = 0;
  let lastBldg = null;
  line.forEach(t => {
    if (canPlace('WALL', t.x, t.y, myTeam)) {
      let actualCost = { ...b.cost };
      if (canAfford(myTeam, actualCost)) {
        spendCost(myTeam, actualCost);
        let bldg = createBuilding('WALL', t.x, t.y, myTeam);
        bldg.complete = false;
        bldg.buildProgress = 0;
        lastBldg = bldg;
        placedCount++;
        vils.forEach(v => {
          v.buildQueue = v.buildQueue || [];
          v.buildQueue.push(bldg.id);
        });
      } else {
        if (!isReplayingRemoteCommand) { showMsg('Not enough stone!'); if (window.playSound) playSound('error'); }
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
  if (!isReplayingRemoteCommand) {
    if (result.reason === 'pop') showMsg('Need more houses!');
    else if (result.reason === 'resources') showMsg('Not enough resources!');
    if (result.reason && window.playSound) playSound('error');
  }
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
  if (!isReplayingRemoteCommand) showMsg(UNITS[utype].name + ' cancelled (refunded)');
}

// Farm economy (moved from ui.js's prepayFarm/reactivateFarm mutation halves).
function prepayFarmNow(){
  let cost = { w: 60 };
  if (!canAfford(myTeam, cost)) {
    if (!isReplayingRemoteCommand) { showMsg('Not enough wood!'); if (window.playSound) playSound('error'); }
    return;
  }
  spendCost(myTeam, cost);
  let store = resourceStore(myTeam);
  store.prepaidFarms = (store.prepaidFarms || 0) + 1;
  if (!isReplayingRemoteCommand) showMsg(`Farm reseed prepaid (Queue: ${store.prepaidFarms})`);
  if (typeof updateUI === 'function') updateUI();
}

function reactivateFarmNow(farm){
  if (!farm.exhausted) return;
  let cost = { w: 60 };
  if (!canAfford(myTeam, cost)) {
    if (!isReplayingRemoteCommand) { showMsg('Not enough wood!'); if (window.playSound) playSound('error'); }
    return;
  }
  spendCost(myTeam, cost);
  farm.exhausted = false;
  farm.complete = true;
  farm.hp = farm.maxHp;
  let tile = map[farm.y][farm.x];
  tile.t = TERRAIN.FARM;
  tile.res = 300;
  markMapDirty(farm.x, farm.y);
  if (!isReplayingRemoteCommand) showMsg('Farm reactivated!');
  if (typeof updateUI === 'function') updateUI();
}
