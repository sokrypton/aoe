// ---- SAVE / LOAD (to a local JSON file) ----
// Every piece of state below is plain data (no functions, no DOM refs, no
// circular structure) — entities/map/fog are already flat objects/arrays
// from createUnit/createBuilding/genMap, so a straight JSON.stringify of a
// snapshot object round-trips cleanly with no custom (de)serialization.
function serializeGame(){
  return {
    version: 3,
    savedAt: new Date().toISOString(),
    // A visible signature that this save came from a multiplayer match
    // (rather than single-player) — surfaced in the filename and the load
    // confirmation message below, not just a hidden field. MP FILE saves
    // are HOST-only (saveGameToFile refuses on a guest); serializeGame
    // itself still runs on guests for the crash-recovery wire handback
    // (js/net-sync.js), which is a live mirror, not a file.
    wasMultiplayerGame: typeof netRole !== 'undefined' && (netRole === 'host' || netRole === 'guest'),
    // The host's PeerJS peer id active at save time. Letting a later
    // re-host request this SAME id back (js/net.js's hostSession()) is what
    // lets the guests' own already-running reconnect loops succeed
    // silently after the host reloads its whole page and re-hosts from this
    // save, instead of being permanently stranded retrying against an id
    // that no longer exists.
    hostPeerId: typeof netRole !== 'undefined' && netRole === 'host' && typeof netPeer !== 'undefined' && netPeer
      ? netPeer.id
      : (typeof netRole !== 'undefined' && netRole === 'guest' ? (window.__mpSession.hostPeerId || null) : null),
    // Each guest's persistent identity token (js/net.js hello binding) —
    // host-side knowledge, so a re-host from this file can pre-seed the
    // registry and every rejoining guest lands back on its exact seat.
    // `tab` rides along so several tabs of ONE browser (same token — the
    // local-testing setup) still rebind to their exact seats on resume.
    seatTokens: (typeof netRole !== 'undefined' && netRole === 'host' && typeof netGuests !== 'undefined')
      ? [...netGuests.values()].map(r => ({ seat: r.seat, token: r.token, tab: r.tab, name: r.name, kicked: !!r.kicked }))
      : null,
    MAP, tick, camX, camY, ZOOM, GAME_SPEED,
    map, entities, nextId,
    // The sim PRNG cursor (js/core.js) IS sim state: it's checksummed and
    // rides lockstep snapshots, so a faithful snapshot must carry it too.
    // Without it a loaded save is NOT reproducible — the next simRandom()
    // draws from a fresh/stale cursor. matchSeed rides along for det-logging
    // and as the seed of record. (nextProjectileId is derived from the saved
    // projectiles in applySavedGame, so it needs no explicit field.)
    simRngState, matchSeed,
    // The EXACT deterministic per-team explored grids (sim state, all
    // teams) — the loader's fog and every rejoining guest's fog rebuild
    // from these, replacing the old lossy otherTeamExploredEver
    // reconstruction. Uint8Array -> plain array for JSON.
    teamExploredGrids: teamExploredGrid ? teamExploredGrid.map(g => Array.from(g)) : null,
    // Corpses fade out over CORPSE_LIFE (ms) measured against
    // performance.now() (see render.js/render-units.js), which restarts
    // near 0 every page load — saving deathTime as-is would make every
    // corpse look freshly killed (or worse, glitch on a negative age)
    // after a reload. Save each corpse's age-so-far instead of its raw
    // timestamp; applySavedGame rebases it against the new session's
    // performance.now().
    corpses: corpses.map(c => ({...c, deathTime: undefined, ageAtSaveMs: performance.now() - c.deathTime})),
    // In-flight arrows carry real pending damage on the host (impact applies
    // damageEntity, js/loop.js) — plain data since attacker became an
    // id+snapshot, so a mid-volley save no longer silently loses those hits.
    projectiles,
    cmdMarkers,
    resources, marketPrices, popUsed, popCap,
    gameStarted, gameOver, won, aiDifficulty,
    // Per-team controller layout + AI plan state + last-hit record
    // (js/core.js) — all plain data, sized by numTeams.
    numTeams: NUM_TEAMS,
    teamControllers,
    aiStates: AI_STATES,
    lastTeamHit,
    teamAlliance,
    defeatedTeams,
    teamAge,
    // Cosmetic per-team labels/colors chosen in the lobby (js/core.js). Not sim
    // state (excluded from the checksum/snapshots), but a loaded MP game should
    // still show the players' agreed names and colors, so they ride the save.
    teamNames,
    teamColorMap,
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
    bellRinging: window.bellRinging || Array.from({length: NUM_TEAMS}, () => false)
  };
}

// A world snapshot normalized through the same JSON round-trip the wire
// applies. Used both by the save file below and by the guest→host state
// handback over the network (js/net-sync.js's 'request-state' handler).
// Entity retry/avoid state is plain arrays/objects (js/logic.js primitives),
// so no Set→null normalization is needed anymore.
function serializeGameForWire(){
  return JSON.parse(JSON.stringify(serializeGame()));
}

function saveGameToFile(){
  // Host-only in multiplayer: only the host can later reload+re-host a
  // match (guests rejoin it by token), so a guest-side file would be a
  // dead end — the save surfaces are hidden on guests, and this guard
  // backstops any path that still calls it.
  if (typeof netRole !== 'undefined' && netRole === 'guest') {
    if (window.showMsg) showMsg('Only the host can save a multiplayer match');
    return;
  }
  try {
    let data = serializeGame();
    let blob = new Blob([JSON.stringify(data)], {type: 'application/json'});
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

// THE single entry point for loading a world from a parsed data object,
// transparently accepting either detail level of the unified format:
//   - a FULL snapshot (serializeGame) — has a 2D `map` grid + verbatim entities
//     → applySavedGame (exact restore incl. resources/age/controllers/rng/tick);
//   - a COMPACT/constructive spec (js/scenario.js) — string/absent `map` and
//     u/b-shorthand entities → loadScenario (rebuilds fresh, now also applies
//     any `resources`/`ages`/`controllers` the compact file carries).
// Route by the `map` shape. Used by the Load-Game button AND the editor, so
// both read either kind of file. Returns 'save' | 'scenario'.
function loadGame(data){
  if (typeof loadScenario === 'function' && !Array.isArray(data.map)) {
    loadScenario(data);
    window.fogDisabled = data.fog !== true; // reveal the authored map (loadScenario also sets this)
    if (window.updateUI) updateUI();
    return 'scenario';
  }
  applySavedGame(data);
  return 'save';
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
    let kind = loadGame(data);
    if (kind === 'scenario' && window.showMsg) showMsg('Scenario loaded');
  };
  reader.onerror = () => { if (window.showMsg) showMsg('Load failed: could not read file'); };
  reader.readAsText(file);
}

function applySavedGame(data, opts){
  if (!data || typeof data !== 'object' || !Array.isArray(data.entities) || !Array.isArray(data.map)) {
    if (window.showMsg) showMsg('Load failed: not a recognized save file');
    return;
  }
  // serializeGame stamps version:3 — actually check it (the net layer's
  // NET_PROTOCOL_VERSION exists for the same reason), so a format change
  // fails loudly here instead of misloading silently. v3 (exact per-team
  // explored grids, host-only MP saves) deliberately drops v2 support —
  // no back-compat shims.
  if (data.version !== 3) {
    if (window.showMsg) showMsg('Load failed: unsupported save version (' + data.version + ') — this build reads v3 saves only');
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
    // every `tick % N === 0` cadence check (lockstep snapshots, checksum
    // reports, watchdog sweeps) then never evaluates true again, silently
    // breaking them forever with no error anywhere. Caught by an actual
    // end-to-end test hosting from a guest-originated save, not by
    // inspecting the load code in isolation.
    tick = Math.round(data.tick) || 0;
    bumpSimGen(); // tick jumped — invalidate every registered sim cache (js/core.js)
    camX = data.camX || 0;
    camY = data.camY || 0;
    ZOOM = data.ZOOM || ZOOM;
    if (data.GAME_SPEED) setGameSpeed(data.GAME_SPEED);

    map = data.map;
    // Sized per-team structures follow the save's team count.
    NUM_TEAMS = data.numTeams || 2;
    // The loader is ALWAYS team 0: MP file saves are host-authored
    // (host = team 0) and the loader re-hosts from them; the
    // crash-recovery handback (opts.fromOpponentMirror, js/net-sync.js)
    // is applied by the original host recovering its own team-0 world
    // from a guest's mirror, teams in place. No team swap exists anymore.
    // Fog rebuilds from the save's EXACT per-team explored grids: this
    // viewer's own grid marks its explored tiles (updateFog() below
    // re-lights the currently-visible ones), and rejoining guests get the
    // same grids via the lockstep resume push.
    resetTeamVision();
    if (Array.isArray(data.teamExploredGrids)) {
      teamExploredGrid = data.teamExploredGrids.map(g => Uint8Array.from(g));
    }
    {
      const myEg = teamExploredGrid[myTeam] || teamExploredGrid[0];
      fog = [];
      for (let y = 0; y < MAP; y++) {
        fog[y] = [];
        for (let x = 0; x < MAP; x++) fog[y][x] = myEg[y * MAP + x] === 1 ? 1 : 0;
      }
    }
    // Rebase each corpse's saved age-so-far against THIS session's
    // performance.now() epoch (see the matching comment in serializeGame).
    let loadNow = performance.now();
    corpses = (data.corpses || []).map(c => ({...c, deathTime: loadNow - (c.ageAtSaveMs || 0)}));
    cmdMarkers = data.cmdMarkers || [];
    // Projectiles are plain data (attacker stored as id + snapshot, resolved
    // at impact against the freshly-rebuilt entitiesById) so in-flight
    // volleys — and their pending damage — survive the round-trip.
    // Particles are genuinely sub-second cosmetics; dropping them is fine.
    projectiles = data.projectiles || [];
    // Keep new projectile ids above the loaded ones — the guest's sync-merge
    // dedupes projectiles by id, so a collision would drop a real arrow.
    nextProjectileId = projectiles.reduce((m,p)=>Math.max(m,p.id||0), 0) + 1;
    particles = [];

    entities = data.entities;
    entitiesById.clear();
    entities.forEach(e => {
      // Buildings saved before atk was stamped at creation (createBuilding)
      // deal 0 damage on arrow impact (js/loop.js prefers the live shooter).
      if (e.type === 'building' && e.atk === undefined) e.atk = BLDGS[e.btype].atk || 0;
      entitiesById.set(e.id, e);
    });
    nextId = data.nextId || (entities.reduce((m, e) => Math.max(m, e.id), 0) + 1);
    // Restore the sim PRNG cursor so post-load randomness is reproducible and
    // matches the peer that saved. Older saves (pre-field) fall back to
    // reseeding from matchSeed, or leave the live cursor untouched as a last
    // resort — both keep peers mutually consistent because a lockstep resume
    // still force-pushes the host's simRngState afterward.
    if (typeof data.simRngState === 'number') simRngState = data.simRngState >>> 0;
    else if (typeof data.matchSeed === 'number') seedSimRng(data.matchSeed >>> 0);
    if (typeof data.matchSeed === 'number') matchSeed = data.matchSeed >>> 0;
    // Re-resolve the saved selection/camera-lock against the just-rebuilt
    // entitiesById (by id, not by trusting any stale object reference) —
    // .filter(Boolean) drops anything that no longer exists (shouldn't
    // happen for a save/load round trip, but would for a hand-edited file).
    selected = (data.selectedIds || []).map(id => entitiesById.get(id)).filter(Boolean);

    resources = data.resources || resources;
    // Global commodity exchange prices (js/core.js); older saves without it
    // fall back to fresh defaults so buy/sell still works.
    marketPrices = data.marketPrices || freshMarketPrices();
    popUsed = data.popUsed || 0;
    popCap = data.popCap || 0;

    gameOver = !!data.gameOver;
    won = !!data.won;
    gameStarted = data.gameStarted !== undefined ? !!data.gameStarted : true;
    gamePaused = false;
    aiDifficulty = AI_LEVELS[data.aiDifficulty] ? data.aiDifficulty : aiDifficulty;
    // Controller layout + per-team AI plan state + last-hit record. The
    // crash-recovery handback (fromOpponentMirror) keeps teams in place so
    // these apply verbatim; the file-load path team-swapped them above.
    // (After the aiDifficulty restore above so the no-field fallback picks
    // up the save's difficulty.)
    if (!data.teamControllers) data.teamControllers = defaultControllers(!!data.wasMultiplayerGame);
    restoreTeamState(data);

    window.fogDisabled = !!data.fogDisabled;
    if (opts && opts.fromOpponentMirror) {
      // data.scoutedByMe is the GUEST's memory — which of OUR buildings
      // they've scouted — useless to the recovering host, and without a
      // rebuild every enemy building the host had scouted vanishes from
      // its map/minimap (buildings under explored fog only render if in
      // scoutedByMe — js/render.js). Reconstruct: an enemy building with
      // any footprint tile in the host's just-restored explored fog counts
      // as scouted. Slightly generous (a building erected after the host
      // explored and left gets remembered too), but the alternative is
      // losing the whole scouting record.
      scoutedByMe = new Set();
      data.entities.forEach(e => {
        // Same "enemy building" test as markScoutedBuildings (js/core.js).
        if (e.type !== 'building' || e.team === myTeam) return;
        let bw = e.w || (BLDGS[e.btype] && BLDGS[e.btype].w) || 1;
        let bh = e.h || (BLDGS[e.btype] && BLDGS[e.btype].h) || 1;
        outer: for (let dy = 0; dy < bh; dy++) for (let dx = 0; dx < bw; dx++) {
          if (fog[e.y + dy] && fog[e.y + dy][e.x + dx] > 0) { scoutedByMe.add(e.id); break outer; }
        }
      });
    } else {
      scoutedByMe = new Set(data.scoutedByMe || []);
    }
    window.bellRinging = Array.from({length: NUM_TEAMS}, (_, t) => !!(data.bellRinging && data.bellRinging[t]));

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
    // paused on that screen indefinitely — and a paused host stops
    // simulating and reporting ticks, so the guest's match stalls until
    // the host happened to manually dismiss it. Detected BEFORE the netRole/guestNeedsFullSync
    // block below (which is what would otherwise look identical for both
    // cases — a host that's about to (re-)host and a host that's already
    // mid-match).
    let alreadyConnectedHost = typeof netRole !== 'undefined' && netRole === 'host' && netConnected;

    if (window.updateBottomHeight) updateBottomHeight();
    if (typeof refreshPopulationCounts === 'function') refreshPopulationCounts();
    updateFog();
    updateUI();

    if (alreadyConnectedHost) {
      // Resume in place: the connection itself is still fine — hand the
      // loaded world to the guest and re-enter lockstep from it (same
      // machinery as desync recovery), then close the host's own menu so
      // its game loop resumes.
      lockstepActive = true;
      lockstepResetState();
      DET.enabled = true;
      lockstepResumeGuest();
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
      // Pre-seed the guest registry from the save's seat tokens so every
      // returning guest's hello rebinds to its exact old seat (js/net.js);
      // unknown identities are denied once the match resumes.
      if (typeof netSeedGuestRecords === 'function') netSeedGuestRecords(data.seatTokens);
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
