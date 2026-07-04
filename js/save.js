// ---- SAVE / LOAD (to a local JSON file) ----
// Every piece of state below is plain data (no functions, no DOM refs, no
// circular structure) — entities/map/fog are already flat objects/arrays
// from createUnit/createBuilding/genMap, so a straight JSON.stringify of a
// snapshot object round-trips cleanly with no custom (de)serialization.
function serializeGame(){
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    // A visible signature that this save came from a multiplayer match
    // (rather than single-player) — surfaced in the filename and the load
    // confirmation message below, not just a hidden field. Both host AND
    // guest can produce one: the guest's local entities/map are a live
    // mirror of the host's (kept in sync — see js/net-sync.js), so a save
    // taken from the guest's side is just as valid a snapshot. The point
    // of tagging it is the same either way — whoever loads it later can
    // click Host and pick up as the new host from that exact state,
    // regardless of which role originally saved it.
    wasMultiplayerGame: typeof netRole !== 'undefined' && (netRole === 'host' || netRole === 'guest'),
    // The host's PeerJS peer id active at save time — captured from
    // whichever side is doing the saving, since both know it (the host
    // has it directly; the guest cached it as __mpSession.hostPeerId when
    // it joined — see that object's comment, js/core.js). Letting a later
    // re-host request this SAME id back (js/net.js's hostSession()) is what
    // lets the original guest's own already-running reconnect loop succeed
    // silently after the host reloads its whole page and re-hosts from this
    // save, instead of being permanently stranded retrying against an id
    // that no longer exists.
    hostPeerId: typeof netRole !== 'undefined' && netRole === 'host' && typeof netPeer !== 'undefined' && netPeer
      ? netPeer.id
      : (typeof netRole !== 'undefined' && netRole === 'guest' ? (window.__mpSession.hostPeerId || null) : null),
    MAP, tick, camX, camY, ZOOM, GAME_SPEED,
    map, fog, entities, nextId,
    // Corpses fade out over CORPSE_LIFE (ms) measured against
    // performance.now() (see render.js/render-units.js), which restarts
    // near 0 every page load — saving deathTime as-is would make every
    // corpse look freshly killed (or worse, glitch on a negative age)
    // after a reload. Save each corpse's age-so-far instead of its raw
    // timestamp; applySavedGame rebases it against the new session's
    // performance.now().
    corpses: corpses.map(c => ({...c, deathTime: undefined, ageAtSaveMs: performance.now() - c.deathTime})),
    cmdMarkers,
    resources, popUsed, popCap, aiPop, aiPopCap, aiTick,
    gameStarted, gameOver, won, aiDifficulty,
    // What the player had selected and whether the camera was locked onto a
    // unit are saved by id (not object reference — see the matching restore
    // in applySavedGame, which re-resolves these against the freshly
    // rebuilt entitiesById rather than trusting stale object identity).
    selectedIds: selected.map(s => s.id),
    cameraFollowId: window.cameraFollowId != null ? window.cameraFollowId : null,
    currentVillagerMenu: window.currentVillagerMenu || 'main',
    settingRally: !!window.settingRally,
    fogDisabled: !!window.fogDisabled,
    // Which enemy buildings THIS client has ever scouted — js/core.js's
    // scoutedByMe Set, not stored on individual entities (see its comment
    // for why). Saved as a plain array since Sets aren't JSON-safe.
    scoutedByMe: Array.from(scoutedByMe),
    // `fog` above is always THIS session's own team's live grid (team 0's
    // if saved from the host, team 1's if saved from the guest) — but
    // whoever LOADS this save always becomes the new host (see
    // applySavedGame's comment), regardless of which side originally saved
    // it. So a guest-originated save's `fog` is actually the WRONG team's
    // grid for that future host. `savedByTeam` records which team `fog`
    // actually belongs to, and `otherTeamExploredEver` carries the OTHER
    // team's persistent "ever explored" memory (js/core.js's
    // teamExploredEver/updateTeamExploredEver — whichever index this
    // session tracks depends on whether it's host or guest) so
    // applySavedGame can reconstruct team 0's fog correctly either way.
    savedByTeam: typeof myTeam !== 'undefined' ? myTeam : 0,
    otherTeamExploredEver: Array.from(teamExploredEver[myTeam === 1 ? 0 : 1]),
    bellActive: !!window.bellActive,
    aiBellActive: !!window.aiBellActive,
    aiWallPlan: window.aiWallPlan || null,
    aiGateBuilt: !!window.aiGateBuilt,
    aiGateTile: window.aiGateTile || null,
    aiIntel: window.aiIntel || null,
    aiWaveCount: window.aiWaveCount || 0,
    aiLastWaveTick: window.aiLastWaveTick || null
  };
}

// A world snapshot safe to JSON.stringify: same as serializeGame() but with
// every live Set anywhere in it replaced by null (see saveGameToFile's
// comment below for why that's a correctness no-op). Used both by the save
// file below and by the guest→host state handback over the network
// (js/net-sync.js's 'request-state' handler) — the wire path stringifies
// too (compressMessage, js/net.js), so it needs the exact same treatment.
function serializeGameForWire(){
  return JSON.parse(JSON.stringify(serializeGame(), (k, v) => v instanceof Set ? null : v));
}

function saveGameToFile(){
  try {
    let data = serializeGame();
    // A couple of villager pathfinding-retry fields (failedGatherTiles/
    // failedDrops in logic.js) are live Set objects sitting directly on
    // unit entities. JSON.stringify silently turns a Set into "{}", which
    // then blows up the first time gather/drop-off retry logic calls
    // .add()/.has() on it post-load. Rather than track down every such
    // field by name (and every future one like it), null out any Set
    // anywhere in the snapshot — matching the "null" reset state that
    // code already falls back on (e.g. `e.failedGatherTiles = e.failedGatherTiles || new Set()`),
    // so losing it is a correctness no-op, not a bug.
    let blob = new Blob([JSON.stringify(data, (k, v) => v instanceof Set ? null : v)], {type: 'application/json'});
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    let stamp = data.savedAt.replace(/[:.]/g, '-');
    a.href = url;
    a.download = `aoe2-save${data.wasMultiplayerGame ? '-mp' : ''}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Deferred, not immediate: revoking synchronously can race the browser
    // actually starting the download in some cases.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (window.showMsg) showMsg(data.wasMultiplayerGame ? 'Multiplayer game saved' : 'Game saved');
  } catch (err) {
    console.error('Save failed:', err);
    if (window.showMsg) showMsg('Save failed');
  }
}

function triggerLoadDialog(){
  let input = document.getElementById('load-file-input');
  if (input) input.click();
}

function loadGameFromFile(file){
  if (!file) return;
  let reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch (err) {
      console.error('Save file is not valid JSON:', err);
      if (window.showMsg) showMsg('Load failed: not a valid save file');
      return;
    }
    applySavedGame(data);
  };
  reader.onerror = () => { if (window.showMsg) showMsg('Load failed: could not read file'); };
  reader.readAsText(file);
}

function applySavedGame(data){
  if (!data || typeof data !== 'object' || !Array.isArray(data.entities) || !Array.isArray(data.map)) {
    if (window.showMsg) showMsg('Load failed: not a recognized save file');
    return;
  }
  try {
    MAP = data.MAP;
    // Math.round, not a bare assignment: a save taken from the GUEST side
    // can have a fractional tick (js/init.js's gameLoop() deliberately
    // nudges the guest's own local `tick` by a fractional amount every
    // frame — elapsed/timeStep — purely so render-units.js's tick-driven
    // walk-cycle/limb animations keep playing between syncs; it was never
    // meant to be authoritative). Loading straight into a fresh host
    // session and never rounding it leaves `tick` permanently fractional
    // (every future tick is just += 1 from there) — and
    // `tick % netSyncIntervalTicks === 0` (js/loop.js's sync-cadence
    // check) then never evaluates true again, silently breaking
    // hostSyncTick() forever with no error anywhere. Caught by an actual
    // end-to-end test hosting from a guest-originated save, not by
    // inspecting the load code in isolation.
    tick = Math.round(data.tick) || 0;
    camX = data.camX || 0;
    camY = data.camY || 0;
    ZOOM = data.ZOOM || ZOOM;
    if (data.GAME_SPEED) setGameSpeed(data.GAME_SPEED);

    map = data.map;
    // Whoever loads a save always becomes the new host (see below), so the
    // new session's `fog` must end up holding TEAM 0's grid regardless of
    // which side originally saved. If the save came from the host
    // (savedByTeam 0, or an older save predating this field), data.fog
    // already IS team 0's grid — use it directly, and the saved
    // otherTeamExploredEver is team 1's ("guest") memory. If it came from
    // the guest (savedByTeam 1), data.fog is team 1's grid instead — that
    // becomes the new teamExploredEver[1], while the saved
    // otherTeamExploredEver (the guest's own locally-tracked team-0 memory)
    // is what rebuilds team 0's fog here.
    if (data.savedByTeam === 1) {
      initFog();
      (data.otherTeamExploredEver || []).forEach(key => {
        let tx = key % MAP, ty = Math.floor(key / MAP);
        if (fog[ty]) fog[ty][tx] = 1;
      });
      teamExploredEver[1] = new Set();
      (data.fog || []).forEach((row, y) => row.forEach((cell, x) => {
        if (cell > 0) teamExploredEver[1].add(y * MAP + x);
      }));
      teamExploredEver[0] = new Set();
    } else {
      fog = data.fog || [];
      teamExploredEver[1] = new Set(data.otherTeamExploredEver || []);
      teamExploredEver[0] = new Set();
    }
    // Rebase each corpse's saved age-so-far against THIS session's
    // performance.now() epoch (see the matching comment in serializeGame).
    let loadNow = performance.now();
    corpses = (data.corpses || []).map(c => ({...c, deathTime: loadNow - (c.ageAtSaveMs || 0)}));
    cmdMarkers = data.cmdMarkers || [];
    // In-flight projectiles/particles hold direct references to entity
    // objects (e.g. a projectile's attacker/target) that are about to be
    // thrown away in favor of the freshly-deserialized ones below — keeping
    // them around would have their flight/impact logic acting on entities
    // no longer in the world. They're both sub-second cosmetic effects, so
    // just drop them rather than trying to re-point them at the new objects.
    projectiles = [];
    particles = [];

    entities = data.entities;
    entitiesById.clear();
    entities.forEach(e => entitiesById.set(e.id, e));
    nextId = data.nextId || (entities.reduce((m, e) => Math.max(m, e.id), 0) + 1);
    // Re-resolve the saved selection/camera-lock against the just-rebuilt
    // entitiesById (by id, not by trusting any stale object reference) —
    // .filter(Boolean) drops anything that no longer exists (shouldn't
    // happen for a save/load round trip, but would for a hand-edited file).
    selected = (data.selectedIds || []).map(id => entitiesById.get(id)).filter(Boolean);

    resources = data.resources || resources;
    popUsed = data.popUsed || 0;
    popCap = data.popCap || 0;
    aiPop = data.aiPop || 0;
    aiPopCap = data.aiPopCap || 0;
    aiTick = data.aiTick || 0;

    gameOver = !!data.gameOver;
    won = !!data.won;
    gameStarted = data.gameStarted !== undefined ? !!data.gameStarted : true;
    gamePaused = false;
    aiDifficulty = AI_LEVELS[data.aiDifficulty] ? data.aiDifficulty : aiDifficulty;

    window.fogDisabled = !!data.fogDisabled;
    scoutedByMe = new Set(data.scoutedByMe || []);
    window.bellActive = !!data.bellActive;
    window.aiBellActive = !!data.aiBellActive;
    window.aiWallPlan = data.aiWallPlan || null;
    window.aiGateBuilt = !!data.aiGateBuilt;
    window.aiGateTile = data.aiGateTile || null;
    window.aiIntel = data.aiIntel || null;
    window.aiWaveCount = data.aiWaveCount || 0;
    window.aiLastWaveTick = data.aiLastWaveTick || null;

    // Camera-lock only makes sense if the locked unit is both saved and
    // still alive/present — entitiesById.has covers "still exists after
    // this exact load", which for a normal save/load round trip is always
    // true for an id that was there at save time.
    window.cameraFollowId = (data.cameraFollowId != null && entitiesById.has(data.cameraFollowId))
      ? data.cameraFollowId : null;
    window.settingRally = !!data.settingRally;
    window.currentVillagerMenu = data.currentVillagerMenu || 'main';
    // Genuinely session-only — not meaningful to carry over regardless of
    // what was happening when the file was saved.
    window.playedGameOverSound = false;
    window.lastUIState = null;
    window.lastSelListKey = null;
    window.lastSelGridDetails = null;
    window.lastSelKey = null;
    lastSelKey = '';

    if (window.stopGameOverMusic) stopGameOverMusic();
    try {
      if (window.initAudio) initAudio();
      if (gameStarted && !gameOver && window.startAmbientMusic) startAmbientMusic();
    } catch (err) {
      console.warn('Music failed to start on load:', err);
    }

    // A load discontinuously replaces the whole world (map, entities, ids)
    // out from under whatever the periodic delta sync (js/net-sync.js) was
    // tracking — a plain dirty-cell delta against the OLD map would be
    // nonsense applied to the guest's now-stale copy. Force the next sync
    // to be a full one, exactly like a fresh join/reconnect, regardless of
    // whether this load happened before hosting even started (the normal
    // "load a save, then host from it" flow) or mid-match with a guest
    // already connected (not the primary use case, but safe for free).
    // A guest already connected mid-match, loading a save right out from
    // under them, is a real (if secondary) use case — but calling
    // onHostClicked() below unconditionally in that case would spin up a
    // whole NEW hostSession()/peer id and show a "waiting for opponent"
    // screen the already-connected guest will never see or use. The
    // existing DataConnection keeps working fine regardless (confirmed by
    // an actual two-browser-context test — the underlying RTCDataChannel
    // survives a new Peer object being created), but the host would sit
    // paused on that screen indefinitely, and since hostSyncTick() only
    // ever runs inside the host's own update() loop (js/loop.js), which
    // doesn't run while gamePaused, the guest would see no updates
    // (resources, positions, anything) until the host happened to
    // manually dismiss it. Detected BEFORE the netRole/guestNeedsFullSync
    // block below (which is what would otherwise look identical for both
    // cases — a host that's about to (re-)host and a host that's already
    // mid-match).
    let alreadyConnectedHost = typeof netRole !== 'undefined' && netRole === 'host' && netConnected;

    if (typeof netRole !== 'undefined' && netRole === 'host') guestNeedsFullSync = true;
    // One-shot signal riding the next full sync (js/net-sync.js's
    // buildSyncPayload/applyNetSync) so a (re)connecting guest knows this
    // isn't just an ordinary reconnect — it's a discontinuous state jump —
    // and should re-center its camera on its own units again, even though
    // it may already have centered once (see __mpSession's comment,
    // js/core.js). Set unconditionally on ANY multiplayer save load, not
    // just when already actively hosting: a save can just as easily be
    // loaded on a fresh page BEFORE hosting has (re)started (the normal
    // "reload the whole browser, then load, then re-host" flow), in which
    // case netRole isn't 'host' yet at this exact moment — but the flag
    // just sits harmlessly until the first full sync is ever built,
    // whenever hosting actually begins.
    if (data.wasMultiplayerGame) window.__mpSession.hostJustLoadedSave = true;

    if (window.updateBottomHeight) updateBottomHeight();
    if (typeof refreshPopulationCounts === 'function') refreshPopulationCounts();
    updateFog();
    updateUI();

    if (alreadyConnectedHost) {
      // Resume in place: the connection itself is still fine, only the
      // host's own local menu (opened by whatever UI flow triggered this
      // load) needs closing so its paused game loop resumes and actually
      // pushes the freshly loaded state out via the next hostSyncTick().
      let menu = document.getElementById('tutorial');
      if (menu) menu.style.display = 'none';
      if (typeof localMenuOpen !== 'undefined') {
        localMenuOpen = false;
        recomputeGamePaused();
      }
      if (window.showMsg) showMsg('Game loaded — resuming match');
    } else if (data.wasMultiplayerGame && typeof onHostClicked === 'function') {
      // Skip the manual "now open the menu and click Host yourself" step —
      // the file is already tagged as having come from a multiplayer
      // match, so we already know that's what the user wants. Keep the
      // menu open (mirroring what actually clicking the menu button would
      // do — same localMenuOpen/gamePaused bookkeeping, see js/init.js) and
      // kick off hosting immediately so the user lands directly on the
      // shareable-link screen instead of having to go find it themselves.
      let menu = document.getElementById('tutorial');
      if (menu) menu.style.display = 'flex';
      if (typeof localMenuOpen !== 'undefined') {
        localMenuOpen = true;
        recomputeGamePaused();
      }
      // One-shot: read by onHostClicked() (js/init.js) to request this
      // exact peer id back from PeerJS instead of a random one — see
      // hostPeerId's comment above (js/net.js's hostSession()).
      window.__mpSession.loadedHostPeerId = data.hostPeerId || null;
      onHostClicked();
    } else {
      let menu = document.getElementById('tutorial');
      if (menu) menu.style.display = 'none';
      if (window.showMsg) showMsg('Game loaded');
    }
  } catch (err) {
    console.error('Load failed:', err);
    if (window.showMsg) showMsg('Load failed: save file looked valid but couldn\'t be applied');
  }
}
