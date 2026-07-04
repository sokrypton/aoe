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

// Target REAL sync rate, not a tick count — ticks run at 30*GAME_SPEED/sec,
// so a fixed tick-count interval would silently give someone playing at
// speed 4 four times the bandwidth of someone at speed 1 for the same
// setting, with nobody having chosen that. Benchmarked (two-browser-context
// tests, see the scratchpad tuning scripts): payload is a near-constant
// ~14.5-14.8KB regardless of rate (it's driven by entity count, not
// frequency), and the host's own simulation clock stays in perfect
// lockstep even syncing every single tick (verified up to 120/sec at
// GAME_SPEED=4, zero dropped ticks) — so there's no engine/PeerJS ceiling
// here at all. The real constraint is bandwidth: 15/sec keeps this to
// ~220KB/s regardless of chosen game speed (computed below), comfortably
// under most home upload connections, while still being a correction
// every ~65ms — plenty responsive given position/tick interpolation
// already smooths the visuals *between* syncs (js/loop.js's
// advanceGuestUnits/advanceGuestProjectiles + the tick nudge in
// js/init.js's gameLoop). `let` so it's still tunable at runtime for
// future benchmarking without a reload.
let NET_SYNC_TARGET_PER_SEC = 15;

// See the one-shot guard inside applyNetSync() below.
let guestInitialMenuHidden = false;

// A naive reuse of serializeGame() sends the ENTIRE map+fog every single
// sync — for a medium map that's ~280KB of a ~290KB payload, 6x/sec
// (~1.7MB/s), which is almost certainly what "feels slow." Two fixes:
//   1. fog is never sent at all — each client computes its OWN team's real
//      fog-of-war locally from the fully-synced entities/map (updateFog()
//      in js/core.js, gated on the shared myTeam indirection: 0 for the
//      host, 1 for the guest). No network protocol needed for this at
//      all — the guest already receives every entity (both teams') every
//      sync, so it can independently work out its own team's vision
//      without the host ever needing to send a fog grid.
//   2. map is sent whole only once (guestNeedsFullSync, reset to true on
//      every fresh connection/reconnect in onNetConnectionOpen — so a
//      (re)joining guest always gets a complete base first). After that,
//      only the small list of cells actually changed since the last
//      broadcast (dirtyMapCells, appended to by markMapDirty() calls at
//      the handful of places gameplay code mutates a map cell — see
//      js/core.js) gets sent.
function buildSyncPayload(){
  let base = serializeGame();
  let full = guestNeedsFullSync;

  // Round entity coordinates for the wire only — continuous movement math
  // (separateUnits() etc. in js/loop.js) needs full float precision, but
  // that precision is visually meaningless over the network.
  let entities = base.entities.map(e =>
    (typeof e.x === 'number' && typeof e.y === 'number')
      ? {...e, x: Math.round(e.x*100)/100, y: Math.round(e.y*100)/100}
      : e
  );

  let payload = {...base, entities, full};
  delete payload.fog;

  // Projectiles are excluded from serializeGame() (js/save.js) because a
  // *saved file* would hold a stale entity reference in `attacker` — but
  // for a live sync, drawProjectiles() (js/render-fx.js) never actually
  // reads `attacker` at all, only x/y/startX/startY/startH/tx/ty/totalDist
  // (damage is already resolved on the host the instant a projectile lands
  // — js/loop.js — so the guest never needs to resolve anything, just draw
  // it).
  //
  // Both projectiles and corpses are fully deterministic once created —
  // constant-velocity straight-line flight to a fixed point (js/loop.js's
  // update(), replicated exactly by the guest's own advanceGuestProjectiles),
  // and a static position that just fades out over CORPSE_LIFE wall-clock
  // time (js/render.js, already computed independently per-client). Neither
  // needs a single correction resent after creation — only a FULL sync
  // (a fresh join/reconnect, with no local history to build on) needs the
  // complete current lists; every other sync only sends what's NEW since
  // the last one (newProjectilesSinceSync/newCorpsesSinceSync, js/core.js),
  // same "don't resend the unchanging part" idea as mapDelta below.
  let mapProjectile = p => ({
    id: p.id, x: p.x, y: p.y, startX: p.startX, startY: p.startY,
    startH: p.startH, tx: p.tx, ty: p.ty, totalDist: p.totalDist
  });

  if (full) {
    guestNeedsFullSync = false;
    dirtyMapCells = []; // the full map already covers everything queued so far
    payload.projectiles = projectiles.map(mapProjectile);
    // payload.corpses already carries the full current list via `base`
    // (serializeGame()) — nothing more to do for the full case.
    // Only worth sending on a full (re)sync — this is how a (re)joining
    // guest recovers previously-explored terrain it can no longer see (see
    // updateGuestExploredEver()'s comment, js/core.js): host-computed, so
    // it survives a guest tab close/reopen that would otherwise wipe the
    // guest's own local `fog` memory entirely.
    payload.exploredEver = Array.from(guestExploredEver);
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
    // its camera even though its own one-shot __netCameraCentered flag
    // already fired at original join.
    if (window.__hostJustLoadedSave) {
      payload.stateReloaded = true;
      window.__hostJustLoadedSave = false;
    }
  } else {
    delete payload.map;
    payload.mapDelta = dirtyMapCells.map(({x,y}) => ({x, y, cell: map[y][x]}));
    dirtyMapCells = [];
    delete payload.projectiles;
    delete payload.corpses;
    payload.newProjectiles = newProjectilesSinceSync.map(mapProjectile);
    payload.newCorpses = newCorpsesSinceSync;
    // Same treatment, same reason (see newCmdMarkersSinceSync's comment,
    // js/core.js) — a marker is create-once/fade-in-place, so only ever
    // send the new ones; the guest's OWN just-created markers (from its
    // own local doCommand()/finalizeWallDrag() call, js/input.js) already
    // live in its own `cmdMarkers` and must never be wholesale-overwritten
    // by this, or they'd disappear the instant the next sync arrives
    // instead of fading naturally like a host's own click does.
    delete payload.cmdMarkers;
    payload.newCmdMarkers = newCmdMarkersSinceSync;
  }
  newProjectilesSinceSync = [];
  newCorpsesSinceSync = [];
  newCmdMarkersSinceSync = [];
  return payload;
}

function hostSyncTick(){
  broadcastToGuest({ type: 'sync', data: buildSyncPayload() });
}

// Guest-side apply: same world-state fields applySavedGame() touches
// (js/save.js), but selection/camera/UI-mode fields from the payload are
// intentionally ignored — those describe the HOST's local UI, not
// anything the guest should inherit every sync tick.
function applyNetSync(data){
  if (!data || typeof data !== 'object' || !Array.isArray(data.entities)) return;
  // A full sync must actually carry a map; a delta sync needs somewhere to
  // apply onto. Either missing means there's nothing safe to do with this
  // message — wait for the next one rather than risk a half-built world.
  if (data.full ? !Array.isArray(data.map) : (!Array.isArray(data.mapDelta) || map.length === 0)) return;
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
    // updateGuestExploredEver()'s comment, js/core.js) before updateFog()
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
    // newCmdMarkersSinceSync's comment, js/core.js): a full sync replaces
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

    // render-units.js computes facing (dir/facing/facingNorth) purely from
    // rendering, comparing each entity's position against its OWN lastX/
    // lastY every frame — it even has deliberate multi-frame "turn
    // hysteresis" (pendingDir/pendingDirT) so a unit's sprite doesn't strobe
    // when the movement angle sits near a facing-sector boundary. That
    // state lives ON the entity object and needs to stay continuous with
    // THIS guest's own render history. But applyNetSync wholesale-replaces
    // `entities` with brand-new objects from the host every sync — so
    // without rescuing these fields first, the guest's own tracked facing
    // gets clobbered every sync by whatever unrelated snapshot the HOST's
    // own rendering happened to have for that entity, producing a spurious
    // facing flip/twitch right at each sync boundary (most visible on
    // units with a strong left/right profile, like the scout's horse).
    let oldFacingById = new Map();
    entities.forEach(e => {
      if (e.type === 'unit') {
        oldFacingById.set(e.id, {
          dir: e.dir, facing: e.facing, facingNorth: e.facingNorth,
          pendingDir: e.pendingDir, pendingDirT: e.pendingDirT,
          lastX: e.lastX, lastY: e.lastY
        });
      }
    });

    entities = data.entities;
    entitiesById.clear();
    entities.forEach(e => {
      let old = oldFacingById.get(e.id);
      if (old) Object.assign(e, old);
      entitiesById.set(e.id, e);
    });

    // Combat hit-particles (js/logic.js's damageEntity spawns them on the
    // host at the moment of each individual hit — same "host-only
    // simulation side-effect" gap as the death blood-burst above, but
    // per-hit instead of per-death, so a one-shot corpse-id Set doesn't
    // apply here). guestPrevHp (js/core.js) is the previous sync's hp per
    // entity id; any entity whose hp dropped since then took a hit in the
    // interim, however many actual hits that represents — this can only
    // ever detect "at least one," not the true hit count, since only hp is
    // sampled once per sync rather than every damageEntity() call, but a
    // single burst per sync reads as continuous combat feedback either way.
    entities.forEach(e => {
      let prevHp = guestPrevHp.get(e.id);
      if (prevHp !== undefined && e.hp < prevHp && e.hp > 0) {
        if (e.type === 'unit') {
          spawnParticles(e.x, e.y, '#990000', 4, 0.04, 1.5);
        } else {
          spawnParticles(e.x + (e.w||1)/2, e.y + (e.h||1)/2, '#8b6c43', 3, 0.03, 2);
        }
      }
    });
    guestPrevHp.clear();
    entities.forEach(e => guestPrevHp.set(e.id, e.hp));
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
    if (data.stateReloaded) window.__netCameraCentered = false;
    if (!window.__netCameraCentered) {
      // data.guestCam is only trustworthy for a genuine fresh join/reconnect
      // (this guest tab just started, so it has no camera history of its
      // own yet) — NOT for data.stateReloaded, where this SAME still-alive
      // guest tab already reported some now-stale pre-load camera position
      // that has nothing to do with wherever entities ended up after the
      // host's loaded save; that case must always recenter on the guest's
      // own unit instead, same as it always has.
      if (data.guestCam && !data.stateReloaded) {
        camX = data.guestCam.x; camY = data.guestCam.y;
        window.__netCameraCentered = true;
      } else {
        let own = entities.find(e => e.team === myTeam);
        if (own) {
          let iso = toIso(own.x, own.y);
          camX = iso.ix; camY = iso.iy;
          window.__netCameraCentered = true;
        }
      }
    }

    res = data.res || res;
    aiRes = data.aiRes || aiRes;
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

    if (window.updateBottomHeight && !window.__netBottomHeightSet) {
      updateBottomHeight();
      window.__netBottomHeightSet = true;
    }
    if (typeof refreshPopulationCounts === 'function') refreshPopulationCounts();
    updateFog();
    updateHostExploredEver(); // js/core.js — guest-side mirror of the host's updateGuestExploredEver()
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
    if (!guestInitialMenuHidden) {
      guestInitialMenuHidden = true;
      let menu = document.getElementById('tutorial');
      if (menu && menu.style.display !== 'none') menu.style.display = 'none';
    }
  } catch (err) {
    console.error('Failed to apply network sync:', err);
  }
}

onNetMessage((msg) => {
  if (msg.type === 'sync' && netRole === 'guest') {
    applyNetSync(msg.data);
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
  if (!window.__netCameraCentered) return;
  if (now - lastGuestViewReportAt < 1500) return;
  lastGuestViewReportAt = now;
  if (lastReportedGuestCam && lastReportedGuestCam.x === camX && lastReportedGuestCam.y === camY) return;
  lastReportedGuestCam = { x: camX, y: camY };
  sendToHost({ type: 'guest-view', camX, camY });
}
