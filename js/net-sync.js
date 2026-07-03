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
//   1. fog is never sent at all — multiplayer forces window.fogDisabled
//      (see js/init.js's onNetConnectionOpen), so updateFog() always fills
//      every tile with the same constant on both sides anyway; the guest
//      just runs that fill locally instead of receiving it over the wire.
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
  // it). The in-flight list is typically tiny (a handful at once), so this
  // is cheap regardless of sync rate.
  payload.projectiles = projectiles.map(p => ({
    x: p.x, y: p.y, startX: p.startX, startY: p.startY,
    startH: p.startH, tx: p.tx, ty: p.ty, totalDist: p.totalDist
  }));

  if (full) {
    guestNeedsFullSync = false;
    dirtyMapCells = []; // the full map already covers everything queued so far
  } else {
    delete payload.map;
    payload.mapDelta = dirtyMapCells.map(({x,y}) => ({x, y, cell: map[y][x]}));
    dirtyMapCells = [];
  }
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
      data.mapDelta.forEach(({x,y,cell}) => { if (map[y]) map[y][x] = cell; });
    }
    // fog is never sent (see the file-header comment above) — pre-allocate
    // it locally once so the unconditional updateFog() call below (which
    // fills every tile with the same constant under fogDisabled) has
    // somewhere to write.
    if (fog.length !== MAP) fog = Array.from({length: MAP}, () => new Array(MAP));
    let loadNow = performance.now();
    corpses = (data.corpses || []).map(c => ({...c, deathTime: loadNow - (c.ageAtSaveMs || 0)}));
    cmdMarkers = data.cmdMarkers || [];
    // Replaced wholesale each sync (see advanceGuestProjectiles() in
    // js/loop.js for the smooth per-frame flight in between syncs) —
    // whatever the host still has in flight, including "gone" = landed.
    projectiles = (data.projectiles || []).map(p => ({...p}));
    particles = [];

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
    // empty space nowhere near the actual map. Center it on one of the
    // guest's own units/buildings once, the same way init() does for a
    // normal local game start; never again after that so it doesn't fight
    // the guest's own manual panning on later syncs.
    if (!window.__netCameraCentered) {
      let own = entities.find(e => e.team === myTeam);
      if (own) {
        let iso = toIso(own.x, own.y);
        camX = iso.ix; camY = iso.iy;
        window.__netCameraCentered = true;
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
});
