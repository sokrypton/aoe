// ---- MULTIPLAYER: host-authoritative world-state sync ----
// The host is the only peer that actually simulates the match; it
// periodically broadcasts a full snapshot (reusing serializeGame(), the
// same function the file-based Save/Load feature already relies on — see
// js/save.js) and the guest just applies whatever arrives. This is
// deliberately NOT the same as applySavedGame(): that function is a
// one-shot "resume MY OWN session" restore and rightly overwrites
// selection/camera from the file. A live network sync arrives many times
// a second on the GUEST'S OWN already-running session, so it must never
// clobber the guest's local selection/camera — only world state.

// Target REAL sync rate, not a tick count — a fixed tick-count interval
// would give someone at speed 4 four times the bandwidth of speed 1 for
// the same setting. Benchmarked: payload size is driven by entity count,
// not frequency, and the host stays in lockstep even at 120/sec — no
// engine ceiling. 15/sec keeps bandwidth reasonable while still landing a
// correction every ~65ms (position/tick interpolation smooths the rest).
let NET_SYNC_TARGET_PER_SEC = 15;

// fog is never sent — each client computes its own team's fog locally from
// the synced entities (updateFog(), js/core.js). map is sent whole only
// once per (re)connection (guestNeedsFullSync); after that only changed
// cells (dirtyMapCells) go out.
//
// COMMON_SYNC_FIELDS is an explicit whitelist (not spread-then-delete) of
// what a live sync actually needs. Several serializeGame() fields
// (selectedIds/cameraFollowId/currentVillagerMenu/settingRally/
// scoutedByMe/savedByTeam/otherTeamExploredEver/aiDifficulty/version/
// savedAt/wasMultiplayerGame/hostPeerId/camX/camY/ZOOM) are save-file-only
// bookkeeping never read by applyNetSync() (confirmed by grep) — excluded
// here, still present in actual save files. `otherTeamExploredEver`
// especially: large and grows over a match, pure compounding waste to
// resend every sync when only a save load ever reads it.
const COMMON_SYNC_FIELDS = ['MAP', 'tick', 'GAME_SPEED',
  'resources', 'popUsed', 'popCap', 'aiPop', 'aiPopCap', 'aiTick',
  'gameStarted', 'gameOver', 'won', 'fogDisabled',
  'bellActive', 'aiBellActive', 'aiWallPlan', 'aiGateBuilt', 'aiGateTile',
  'aiIntel', 'aiWaveCount', 'aiLastWaveTick', 'nextId'];

function pickFields(obj, fields){
  let out = {};
  fields.forEach(f => { out[f] = obj[f]; });
  return out;
}

// An entity minus its per-tick movement-progress fields — the part the
// guest CAN'T derive on its own and must always be told about. `path` is
// deliberately core, not movement: a path change is either a new order
// (must send now) or a tile consumed en route (the natural ~1/sec
// re-anchor cadence for a moving unit). See the movement-skip in
// buildSyncPayload's delta branch below.
function entityCoreJson(e){
  let {x, y, fromX, fromY, moveT, ...core} = e;
  return JSON.stringify(core);
}
// Host-only, parallel to lastSentEntitySnapshot (js/core.js): id -> core
// JSON as of the last actual send. Rebuilt on every full sync.
let lastSentEntityCore = new Map();
// Counts delta syncs for the staggered keyframe below — every entity gets
// force-resent (movement fields included) once per KEYFRAME_EVERY deltas
// (~2s at 15/sec), offset by its id so keyframes spread evenly across
// syncs instead of all landing on the same payload.
const KEYFRAME_EVERY = 30;
let deltaSyncCounter = 0;

function buildSyncPayload(){
  let base = serializeGame();
  let full = guestNeedsFullSync;

  // Round entity coordinates for the wire (full precision is visually
  // meaningless over the network). Also strip render-only bookkeeping
  // fields (dir/facing/facingNorth/pendingDir/pendingDirT/lastX/lastY) that
  // render-units.js writes onto entities for its own animation — the host
  // renders its own view too, so these end up on the host's entities, but
  // the guest computes its own independently and never needs them. Worse
  // than wasted bytes: merging the host's copy onto the guest's object
  // would clobber the guest's own `pendingDirT` turn-hysteresis counter,
  // causing a spurious facing flip at sync boundaries — confirmed (by
  // grep) unused outside render-units.js, so stripping is safe.
  // sortVal joins the strip list for a subtler reason than the rest: it's
  // written by render.js every frame (draw-order key, recomputed from x/y
  // on every client independently), so on a MOVING unit it changes every
  // tick — leaving it in didn't just waste bytes, it made every moving
  // unit's "core" look changed every sync, completely defeating the
  // movement-skip in the delta branch below.
  let entities = base.entities.map(e => {
    let {dir, facing, facingNorth, pendingDir, pendingDirT, lastX, lastY, sortVal, ...stripped} = e;
    if (typeof stripped.x === 'number' && typeof stripped.y === 'number') {
      stripped.x = Math.round(stripped.x*100)/100;
      stripped.y = Math.round(stripped.y*100)/100;
    }
    return stripped;
  });

  let payload = pickFields(base, COMMON_SYNC_FIELDS);
  payload.full = full;
  // One boolean per sync so the guest's remoteMenuOpen mirror self-heals if
  // a one-shot 'host-menu' message is ever lost — see applyNetSync below.
  payload.hostMenuOpen = localMenuOpen;

  // Unlike SYNC_BUFFERS' create-once lists, entities constantly change —
  // but at true idle NOTHING about them changes, and resending the whole
  // array every ~65ms regardless (measured: ~85% of the idle payload) is
  // pure waste. A full sync still sends the complete list (a fresh join/
  // reconnect has no local history to diff against); every other sync only
  // sends entities whose serialized form actually differs from the last
  // snapshot actually sent (lastSentEntitySnapshot, js/core.js), plus the
  // ids of any that vanished (died/were deleted) since then.
  if (full) {
    payload.entities = entities;
    lastSentEntitySnapshot = new Map(entities.map(e => [e.id, JSON.stringify(e)]));
    lastSentEntityCore = new Map(entities.map(e => [e.id, entityCoreJson(e)]));
  } else {
    deltaSyncCounter++;
    let changedEntities = [];
    let currentIds = new Set();
    entities.forEach(e => {
      currentIds.add(e.id);
      let json = JSON.stringify(e);
      if (lastSentEntitySnapshot.get(e.id) !== json) {
        // A unit that's just walking its already-sent path changes
        // x/y/fromX/fromY/moveT every single tick — under the plain diff
        // above, marching units dominated the entire delta stream (resent
        // ~15x/sec each) even though the guest independently replays the
        // exact same path-stepping math (advanceGuestUnits, js/loop.js).
        // So: if the only thing that changed is that movement progress,
        // don't resend — the guest is already simulating it. Everything
        // else (the "core" — orders, combat, and crucially `path` itself)
        // still triggers an immediate send, and since path consumption
        // shrinks `path` each tile reached, a moving unit still re-anchors
        // about once per tile (~1/sec) instead of 15/sec, naturally
        // bounding guest drift. A slow keyframe (staggered by id so it
        // never bursts) additionally force-resends each entity every
        // KEYFRAME_EVERY deltas as a catch-all for any x/y write this
        // reasoning missed — costs almost nothing, caps any surprise at
        // ~2s. separateUnits() (js/loop.js) specifically only nudges x/y
        // on path.length===0 units, which never take this skip.
        let coreJson = entityCoreJson(e);
        let moving = e.type === 'unit' && Array.isArray(e.path) && e.path.length > 0;
        let keyframe = (deltaSyncCounter + e.id) % KEYFRAME_EVERY === 0;
        if (moving && !keyframe && lastSentEntityCore.get(e.id) === coreJson) {
          // movement-only progress — guest replays it locally
        } else {
          changedEntities.push(e);
          lastSentEntitySnapshot.set(e.id, json);
          lastSentEntityCore.set(e.id, coreJson);
        }
      }
    });
    let removedEntityIds = [];
    lastSentEntitySnapshot.forEach((json, id) => {
      if (!currentIds.has(id)) removedEntityIds.push(id);
    });
    removedEntityIds.forEach(id => { lastSentEntitySnapshot.delete(id); lastSentEntityCore.delete(id); });
    payload.changedEntities = changedEntities;
    payload.removedEntityIds = removedEntityIds;
  }

  // Projectiles/corpses/cmdMarkers are all "create-once" (see SYNC_BUFFERS's
  // comment, js/core.js) — fully deterministic or purely locally-aged once
  // created, so none of them ever need a correction resent after the fact.
  // A full sync (fresh join/reconnect, nothing local to build on yet) sends
  // each kind's COMPLETE current list; every other sync only sends what's
  // new since the last one, same "don't resend the unchanging part" idea as
  // mapDelta below. One loop over the shared registry instead of three
  // hand-copied full/delta branches.
  let capitalize = s => s[0].toUpperCase() + s.slice(1);
  for (let kind in SYNC_BUFFERS) {
    let buf = SYNC_BUFFERS[kind];
    if (full) {
      payload[kind] = buf.live().map(buf.map);
    } else {
      payload['new' + capitalize(kind)] = buf.pending.map(buf.map);
    }
    buf.pending = [];
  }

  if (full) {
    guestNeedsFullSync = false;
    dirtyMapCells = []; // the full map already covers everything queued so far
    payload.map = base.map;
    // Only worth sending on a full (re)sync — this is how a (re)joining
    // guest recovers previously-explored terrain it can no longer see (see
    // updateTeamExploredEver()'s comment, js/core.js): host-computed, so
    // it survives a guest tab close/reopen that would otherwise wipe the
    // guest's own local `fog` memory entirely.
    payload.exploredEver = Array.from(teamExploredEver[1]);
    // The guest's own last-reported camera position (js/core.js's
    // hostKnownGuestCam, kept updated by the 'guest-view' message handler
    // below) — lets a (re)connecting guest restore wherever it had
    // actually panned to instead of recentering on its own base every
    // time (see applyNetSync's camera-centering block below).
    if (hostKnownGuestCam) payload.guestCam = hostKnownGuestCam;
    // One-shot signal set by js/save.js's applySavedGame() when the HOST
    // just loaded a save mid-match (not an ordinary reconnect, which also
    // sets `full` but shouldn't yank the guest's camera around) — tells
    // the guest this is a discontinuous state jump, so it should re-center
    // its camera even though it may already have centered once (see
    // __mpSession's comment, js/core.js).
    if (window.__mpSession.hostJustLoadedSave) {
      payload.stateReloaded = true;
      window.__mpSession.hostJustLoadedSave = false;
    }
  } else {
    payload.mapDelta = dirtyMapCells.map(({x,y}) => ({x, y, cell: map[y][x]}));
    dirtyMapCells = [];
  }
  return payload;
}

// Every sync carries a sequence number so the guest can detect a hole in
// the stream (a message the receive pipeline dropped — decompress failure,
// handler exception) instead of silently applying deltas onto a state
// they no longer match. Assigned at SEND time, not per attempted tick —
// a tick skipped by the backpressure check below produces no gap, since
// its changes simply coalesce into the next payload (dirtyMapCells /
// SYNC_BUFFERS.pending / lastSentEntitySnapshot all accumulate naturally).
let netSyncSeq = 0;

// `force` (the gameOver broadcast in js/logic.js's handleDeath) bypasses
// the backpressure skip — it's the last sync the guest will ever get, and
// update() never runs again after gameOver to retry it.
function hostSyncTick(force){
  // Backpressure: the reliable-ordered DataChannel buffers unboundedly if
  // we produce faster than the real uplink drains (never visible on
  // same-machine loopback, the original 1v1 test setup — very visible
  // across two computers as ever-growing sync latency). Skipping a delta
  // is free: everything queued just rides the next one. A pending full
  // sync gets a bigger allowance (it IS the recovery payload) but still
  // defers rather than piling onto an already-choked channel.
  if (!force && netSendBuffered() > (guestNeedsFullSync ? 256 * 1024 : 64 * 1024)) return;
  broadcastToGuest({ type: 'sync', seq: ++netSyncSeq, data: buildSyncPayload() });
}

// ---- Guest-side resync safety net ----
// The guest can only bootstrap from a full sync, and the host only sends
// one unprompted per (re)connection (guestNeedsFullSync, js/init.js's
// onNetConnectionOpen). If that one message is ever lost or fails to
// apply, every later delta hits applyNetSync's "nothing safe to do" guard
// forever while pings keep the connection looking healthy — the exact
// "guest frozen until refresh, no error anywhere" failure. These three
// pieces (seq-gap detection in the handler below, apply-failure reporting,
// and the staleness watchdog) all funnel into one recovery action: ask the
// host for a fresh full sync.
let lastAppliedSyncSeq = 0;
let lastSyncAppliedAt = 0;
let lastFullSyncRequestAt = 0;
function requestFullSync(reason){
  let now = performance.now();
  // Rate-limited: one in-flight request is enough, and while the host's
  // reply is traveling every further sync we look at would "fail" too.
  if (now - lastFullSyncRequestAt < 2000) return;
  lastFullSyncRequestAt = now;
  console.warn('Requesting full resync from host:', reason);
  sendToHost({ type: 'request-full-sync' });
}

// Watchdog for the silent-wedge case where no sync arrives at all (or none
// applies) yet the connection itself stays alive. Skipped while paused —
// the host's update() (and therefore hostSyncTick()) legitimately doesn't
// run while gamePaused, so "no sync in 5s" is expected then, not a wedge.
setInterval(() => {
  if (netRole !== 'guest' || !netConnected || !mpMatchStarted || gameOver || gamePaused) return;
  if (map.length === 0) requestFullSync('no world state yet');
  else if (lastSyncAppliedAt && performance.now() - lastSyncAppliedAt > 5000) requestFullSync('no sync applied in 5s');
}, 1000);

// Guest-side apply: same world-state fields applySavedGame() touches
// (js/save.js), but selection/camera/UI-mode fields from the payload are
// intentionally ignored — those describe the HOST's local UI, not
// anything the guest should inherit every sync tick.
// Returns true if the payload was actually applied — false means the guest's
// world state did NOT advance and the caller must treat it as a hole in the
// sync stream (request a full resync), never silently move on: before this
// returned a value, a guest that missed its one full sync sat rejecting
// every delta forever with no visible error.
function applyNetSync(data){
  if (!data || typeof data !== 'object') return false;
  // A full sync must actually carry a complete entities list and map; a
  // delta sync needs a changedEntities list and somewhere (an existing map)
  // to apply mapDelta onto. Any missing means there's nothing safe to do
  // with this message — report failure rather than risk a half-built world.
  if (data.full
    ? (!Array.isArray(data.entities) || !Array.isArray(data.map))
    : (!Array.isArray(data.changedEntities) || !Array.isArray(data.mapDelta) || map.length === 0)) return false;
  try {
    MAP = data.MAP;
    tick = data.tick || 0;
    if (data.GAME_SPEED) setGameSpeed(data.GAME_SPEED);

    if (data.full) {
      map = data.map;
    } else {
      // A resource tile's `res` dropping is the guest-visible signature of
      // a successful gather cycle (js/logic.js's gatherFromTile spawns a
      // matching particle there on the host the instant it happens — a
      // host-only simulation side-effect the guest never otherwise sees).
      // Detected here, not with any new network message: the delta itself
      // already tells us exactly which tile changed and by how much.
      data.mapDelta.forEach(({x,y,cell}) => {
        if (!map[y]) return;
        let old = map[y][x];
        if (old && cell && cell.res < old.res && old.res > 0 &&
            (old.t === TERRAIN.FOREST || old.t === TERRAIN.GOLD || old.t === TERRAIN.STONE || old.t === TERRAIN.BERRIES || old.t === TERRAIN.FARM)) {
          let pColor = '#4a8c2a';
          if (old.t === TERRAIN.FOREST) pColor = '#8b5a2b';
          else if (old.t === TERRAIN.GOLD) pColor = '#ffd700';
          else if (old.t === TERRAIN.STONE) pColor = '#888';
          spawnParticles(x + 0.5, y + 0.5, pColor, 2, 0.02, 1.2);
        }
        map[y][x] = cell;
      });
    }
    // fog is never sent (see the file-header comment above) — pre-allocate
    // it locally once so the unconditional updateFog() call below has
    // somewhere to write real per-team vision into. initFog() (js/core.js),
    // not a bare `new Array(MAP)` — that leaves every row a sparse array
    // of holes (undefined), not filled with 0 (unexplored). Harmless back
    // when MP always forced fogDisabled (its branch of updateFog()
    // unconditionally overwrites every single cell to 2 regardless of
    // prior state) — but with real fog now computed, any tile neither
    // player's units ever visit stays a hole forever instead of correctly
    // resting at "unexplored". Caught by an actual two-browser-context
    // test checking the guest's fog distribution, not by reading the code.
    if (fog.length !== MAP) initFog();
    // Restore previously-explored terrain (host-computed — see
    // updateTeamExploredEver()'s comment, js/core.js) before updateFog()
    // below layers current live vision on top. Only present on a full
    // sync; a delta sync has nothing new to restore here.
    if (data.full && Array.isArray(data.exploredEver)) {
      data.exploredEver.forEach(key => {
        let tx = key % MAP, ty = Math.floor(key / MAP);
        if (fog[ty] && fog[ty][tx] === 0) fog[ty][tx] = 1;
      });
    }
    let loadNow = performance.now();
    // Death blood-burst (js/logic.js's handleDeath spawns it on the host the
    // instant a unit dies — the guest never otherwise sees it, since
    // particles aren't networked at all: js/net-sync.js's outgoing payload
    // just carries the resulting corpse). guestReactedCorpses (js/core.js)
    // makes this a one-shot per corpse id rather than re-firing on every
    // sync the way `c.impactFx` used to (see that comment).
    //
    // Corpses and projectiles are handled differently depending on full vs
    // delta (see buildSyncPayload's comment, js/net-sync.js, for why): a
    // full sync wholesale-replaces both lists (this guest tab has no local
    // history to build on — a fresh join/reconnect); a delta sync only ever
    // carries the NEW ones since last time, appended onto whatever this
    // guest is already independently aging/flying locally
    // (advanceGuestProjectiles in js/loop.js; render.js's CORPSE_LIFE fade
    // for corpses) — never resent, never wholesale-replaced.
    if (data.full) {
      (data.corpses || []).forEach(c => {
        if (!guestReactedCorpses.has(c.id)) {
          guestReactedCorpses.add(c.id);
          spawnParticles(c.x, c.y, '#990000', c.utype === 'bear' ? 12 : 7, 0.05, 1.8);
        }
      });
      corpses = (data.corpses || []).map(c => ({...c, deathTime: loadNow - (c.ageAtSaveMs || 0)}));
      projectiles = (data.projectiles || []).map(p => ({...p}));
    } else {
      (data.newCorpses || []).forEach(c => {
        guestReactedCorpses.add(c.id);
        spawnParticles(c.x, c.y, '#990000', c.utype === 'bear' ? 12 : 7, 0.05, 1.8);
        corpses.push({...c, deathTime: loadNow});
      });
      (data.newProjectiles || []).forEach(p => { projectiles.push({...p}); });
    }
    // Same full-vs-delta split as corpses/projectiles above (see
    // SYNC_BUFFERS's comment, js/core.js): a full sync replaces
    // wholesale (fresh join/reconnect, nothing local to preserve yet); a
    // delta sync only ever APPENDS the host's new markers onto this
    // guest's own already-existing list — critically, never overwrites it,
    // so a marker this guest just pushed for its OWN click (js/input.js)
    // keeps fading naturally via render.js's tick-based filter instead of
    // vanishing the instant the next ~65ms sync arrives.
    if (data.full) {
      cmdMarkers = data.cmdMarkers || [];
    } else {
      (data.newCmdMarkers || []).forEach(m => cmdMarkers.push(m));
    }
    // particles are never networked and used to be reset here every sync —
    // fine when the guest never spawned any of its own, but now it does
    // (advanceGuestParticles/the hit/death/gather/building-fx hooks below),
    // so wiping this on every ~65ms sync would cut every particle's
    // intended ~0.7-2s lifespan down to a few dozen milliseconds. Left
    // alone here; js/loop.js's advanceGuestParticles owns aging them out.

    // Combat hit-particles (js/logic.js's damageEntity spawns them on the
    // host at the moment of each individual hit — same "host-only
    // simulation side-effect" gap as the death blood-burst above, but
    // per-hit instead of per-death, so a one-shot corpse-id Set doesn't
    // apply here). Detected by comparing an entity's hp just before this
    // sync touches it against its incoming hp — this can only ever detect
    // "at least one" hit, not the true count, since only hp is sampled once
    // per sync rather than every damageEntity() call, but a single burst
    // per sync reads as continuous combat feedback either way.
    let spawnHitParticle = e => {
      if (e.type === 'unit') spawnParticles(e.x, e.y, '#990000', 4, 0.04, 1.5);
      else spawnParticles(e.x + (e.w||1)/2, e.y + (e.h||1)/2, '#8b6c43', 3, 0.03, 2);
    };

    if (data.full) {
      // Fresh join/reconnect — no local history to merge into, and
      // render-units.js's per-entity facing/turn-hysteresis state
      // (dir/facing/facingNorth/pendingDir/pendingDirT/lastX/lastY) has
      // nothing continuous to preserve yet either, so a wholesale replace
      // is correct and simplest here (unlike the delta case below, which
      // merges in place specifically to avoid clobbering that state).
      entities = data.entities;
      entitiesById.clear();
      entities.forEach(e => {
        let prevHp = guestPrevHp.get(e.id);
        if (prevHp !== undefined && e.hp < prevHp && e.hp > 0) spawnHitParticle(e);
        entitiesById.set(e.id, e);
      });
      guestPrevHp.clear();
      entities.forEach(e => guestPrevHp.set(e.id, e.hp));
    } else {
      // Merge changed entities into whatever this guest already has —
      // Object.assign onto the SAME existing object (not a replace)
      // preserves every guest-local-only field automatically (render-
      // units.js's facing/turn-hysteresis state chief among them), with no
      // rescue-and-reapply step needed the way the old wholesale-replace
      // approach required. A genuinely new id (a just-trained unit, a
      // just-placed building) has no existing object to merge into, so it's
      // simply added.
      (data.changedEntities || []).forEach(e => {
        let existing = entitiesById.get(e.id);
        if (existing) {
          let prevHp = existing.hp;
          let oldX = existing.x, oldY = existing.y;
          Object.assign(existing, e);
          // Soften the visual snap between the guest's own extrapolated
          // position (advanceGuestUnits, js/loop.js) and the host's
          // authoritative one — under real-network jitter the raw assign
          // reads as constant stuttering. Small corrections blend halfway
          // (spreading them over 2-3 syncs); anything bigger than ~1.5
          // tiles is a genuine discontinuity (teleport/garrison/death
          // cleanup) and must snap. Mid-path units re-derive x/y from
          // fromX/moveT next frame anyway, so for them this is a harmless
          // no-op — the blend mainly serves stationary/arriving units.
          if (existing.type === 'unit'
              && typeof oldX === 'number' && typeof existing.x === 'number') {
            let dx = existing.x - oldX, dy = existing.y - oldY;
            if (dx * dx + dy * dy < 1.5 * 1.5) {
              existing.x = oldX + dx * 0.5;
              existing.y = oldY + dy * 0.5;
            }
          }
          if (prevHp !== undefined && existing.hp < prevHp && existing.hp > 0) spawnHitParticle(existing);
        } else {
          entities.push(e);
          entitiesById.set(e.id, e);
        }
      });
      (data.removedEntityIds || []).forEach(id => entitiesById.delete(id));
      if ((data.removedEntityIds || []).length) {
        entities = entities.filter(e => entitiesById.has(e.id));
      }
    }
    nextId = data.nextId || (entities.reduce((m, e) => Math.max(m, e.id), 0) + 1);
    // Re-resolve the GUEST's OWN pre-sync selection by id against the
    // freshly rebuilt entitiesById — not data.selectedIds (that's the
    // host's selection). Same "select by id, not object identity"
    // technique js/save.js already uses, just keyed off different ids.
    let myPreSyncIds = selected.map(s => s.id);
    selected = myPreSyncIds.map(id => entitiesById.get(id)).filter(Boolean);

    // The guest never runs init() (which normally centers camX/camY on
    // your own starting base — see js/init.js), so on the very first sync
    // its camera is still sitting at the core.js default (0,0), looking at
    // empty space nowhere near the actual map. Restore wherever this guest
    // had actually panned to last (data.guestCam — host-remembered, since
    // the host survives a guest's own reload/refresh) if available;
    // otherwise fall back to centering on one of the guest's own units/
    // buildings, the same way init() does for a normal local game start.
    // Only ever done once per page load — never again after that so it
    // doesn't fight the guest's own manual panning on later syncs — except
    // when data.stateReloaded explicitly asks for it again (a host-loaded
    // save is a discontinuous jump, not something to just quietly ignore).
    if (data.stateReloaded) window.__mpSession.cameraCentered = false;
    if (!window.__mpSession.cameraCentered) {
      // data.guestCam is only trustworthy for a genuine fresh join/reconnect
      // (this guest tab just started, so it has no camera history of its
      // own yet) — NOT for data.stateReloaded, where this SAME still-alive
      // guest tab already reported some now-stale pre-load camera position
      // that has nothing to do with wherever entities ended up after the
      // host's loaded save; that case must always recenter on the guest's
      // own unit instead, same as it always has.
      if (data.guestCam && !data.stateReloaded) {
        camX = data.guestCam.x; camY = data.guestCam.y;
        window.__mpSession.cameraCentered = true;
      } else {
        let own = entities.find(e => e.team === myTeam);
        if (own) {
          let iso = toIso(own.x, own.y);
          camX = iso.ix; camY = iso.iy;
          window.__mpSession.cameraCentered = true;
        }
      }
    }

    resources = data.resources || resources;
    popUsed = data.popUsed || 0;
    popCap = data.popCap || 0;
    aiPop = data.aiPop || 0;
    aiPopCap = data.aiPopCap || 0;
    aiTick = data.aiTick || 0;

    gameOver = !!data.gameOver;
    won = !!data.won;
    gameStarted = data.gameStarted !== undefined ? !!data.gameStarted : true;

    window.fogDisabled = !!data.fogDisabled;
    window.bellActive = !!data.bellActive;
    window.aiBellActive = !!data.aiBellActive;
    window.aiWallPlan = data.aiWallPlan || null;
    window.aiGateBuilt = !!data.aiGateBuilt;
    window.aiGateTile = data.aiGateTile || null;
    window.aiIntel = data.aiIntel || null;
    window.aiWaveCount = data.aiWaveCount || 0;
    window.aiLastWaveTick = data.aiLastWaveTick || null;

    // camX/camY/ZOOM/currentVillagerMenu/settingRally/cameraFollowId are
    // deliberately NOT touched here — all local UI state, untouched by
    // the network (see file header comment).

    if (window.updateBottomHeight && !window.__mpSession.bottomHeightSet) {
      updateBottomHeight();
      window.__mpSession.bottomHeightSet = true;
    }
    if (typeof refreshPopulationCounts === 'function') refreshPopulationCounts();
    updateFog();
    updateTeamExploredEver(0); // js/core.js — guest-side: remembers team 0's (host's) explored history
    markScoutedBuildings(); // js/core.js — host's equivalent runs every tick in js/loop.js's update()
    // Force updateUI() to actually rebuild rather than skip via its
    // dirty-check cache, since this "tick" never ran through the normal
    // update() path that keeps that cache honest tick-to-tick. Deliberately
    // NOT touching window.lastSelListKey here: updateUI() uses that
    // specifically to detect an actual *selection change* and reset
    // currentVillagerMenu back to 'main' when it does — resetting it on
    // every sync (this runs ~5x/sec) made that fire every single sync
    // regardless of whether the selection actually changed, permanently
    // bouncing the guest back out of any build submenu the instant they
    // opened it.
    window.lastUIState = null;
    updateUI();

    // One-shot, not "every sync": this only exists to dismiss the guest's
    // pre-match "Connecting… waiting for game state" panel the moment real
    // gameplay data starts arriving. Left unconditional, it fought any
    // LATER legitimate reason the guest's own #tutorial menu might be open
    // (their own local pause menu) — the very next sync (~65ms later)
    // would force it closed again, completely bypassing toggleMenu()'s own
    // gamePaused bookkeeping, leaving the game stuck paused with no menu
    // visible to un-pause it (reported as "interpolation breaks" — it
    // wasn't broken, gamePaused was just stuck true with nothing on screen
    // to explain why).
    if (!window.__mpSession.guestInitialMenuHidden) {
      window.__mpSession.guestInitialMenuHidden = true;
      let menu = document.getElementById('tutorial');
      if (menu && menu.style.display !== 'none') menu.style.display = 'none';
    }

    // Menu-pause state rides along on every sync as a single boolean so it
    // self-heals: the one-shot 'host-menu' messages (js/init.js) are the
    // prompt notification, but if an open:false is ever lost the guest used
    // to stay stuck gamePaused forever with nothing on screen to explain
    // why. Any applied sync now reconciles the mirror. (The reverse case —
    // a lost open:true — can't be healed this way since a paused host stops
    // syncing entirely, but a guest that missed a pause just keeps
    // cosmetically extrapolating; harmless by comparison.)
    if (typeof data.hostMenuOpen === 'boolean' && data.hostMenuOpen !== remoteMenuOpen) {
      setRemoteMenuOpen(data.hostMenuOpen);
    }
    return true;
  } catch (err) {
    console.error('Failed to apply network sync:', err);
    return false;
  }
}

onNetMessage((msg) => {
  if (msg.type === 'sync' && netRole === 'guest') {
    // A delta that isn't exactly the next seq means something between it
    // and the last applied sync was lost in the receive pipeline (the
    // transport itself is reliable-ordered, but a decompress/apply failure
    // drops a message after delivery) — its changes are gone for good, so
    // applying this one would silently diverge from the host. Don't apply;
    // recover. A FULL sync is self-contained and always applies (it also
    // re-anchors the counter). Before the first full sync ever lands,
    // lastAppliedSyncSeq is 0 and any delta fails this check — which is
    // exactly right: deltas are useless until a full sync bootstraps us.
    if (!msg.data || !msg.data.full) {
      if (msg.seq !== lastAppliedSyncSeq + 1) { requestFullSync('sync seq gap'); return; }
    }
    if (applyNetSync(msg.data)) {
      if (typeof msg.seq === 'number') lastAppliedSyncSeq = msg.seq;
      lastSyncAppliedAt = performance.now();
    } else {
      requestFullSync('sync failed to apply');
    }
  }
  // Guest detected a wedged/holey sync stream — resend the complete world
  // on the next hostSyncTick, same mechanism a reconnect uses.
  if (msg.type === 'request-full-sync' && netRole === 'host') {
    guestNeedsFullSync = true;
  }
  // Host-side: remember the guest's own reported camera position (see
  // hostKnownGuestCam's comment, js/core.js) so it can be handed back on a
  // future full sync.
  if (msg.type === 'guest-view' && netRole === 'host') {
    hostKnownGuestCam = { x: msg.camX, y: msg.camY };
  }
});

// Guest-only: periodically tells the host where its camera actually is,
// so the host can hand it back on a future (re)connect (data.guestCam
// above). Not sent every frame — camera position only matters for a FUTURE
// reconnect, not the live match, so a coarse interval is plenty and keeps
// this off the hot path entirely. Skips sending when nothing changed
// since the last report, same "only send what's new" spirit as the fog
// exploration reporting elsewhere in this file.
let lastGuestViewReportAt = 0;
let lastReportedGuestCam = null;
function reportGuestViewIfChanged(now){
  if (netRole !== 'guest') return;
  // Before the camera has ever actually been centered/restored (see
  // applyNetSync's camera-centering block), camX/camY still hold whatever
  // meaningless pre-connection default core.js started with — reporting
  // THAT would race the very first full sync's restore and stomp the
  // host's correctly-remembered position with garbage before it's ever
  // used, on every fresh join/reconnect.
  if (!window.__mpSession.cameraCentered) return;
  if (now - lastGuestViewReportAt < 1500) return;
  lastGuestViewReportAt = now;
  if (lastReportedGuestCam && lastReportedGuestCam.x === camX && lastReportedGuestCam.y === camY) return;
  lastReportedGuestCam = { x: camX, y: camY };
  sendToHost({ type: 'guest-view', camX, camY });
}
