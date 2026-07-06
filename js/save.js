// ---- SAVE / LOAD (to a local JSON file) ----
// Every piece of state below is plain data (no functions, no DOM refs, no
// circular structure) — entities/map/fog are already flat objects/arrays
// from createUnit/createBuilding/genMap, so a straight JSON.stringify of a
// snapshot object round-trips cleanly with no custom (de)serialization.
function serializeGame(){
  return {
    version: 2,
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
    // In-flight arrows carry real pending damage on the host (impact applies
    // damageEntity, js/loop.js) — plain data since attacker became an
    // id+snapshot, so a mid-volley save no longer silently loses those hits.
    projectiles,
    cmdMarkers,
    resources, popUsed, popCap,
    gameStarted, gameOver, won, aiDifficulty,
    // Per-team controller layout + AI plan state + last-hit record
    // (js/core.js) — all plain data, sized by numTeams.
    numTeams: NUM_TEAMS,
    teamControllers,
    aiStates: AI_STATES,
    lastTeamHit,
    teamAlliance,
    defeatedTeams,
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
    // Union of the legacy per-tick memory AND the deterministic sim grid:
    // teamExploredEver's guest-side updater for index 0 died with the
    // legacy snapshot sync, so under lockstep the OTHER team's history
    // lives (exactly) in teamExploredGrid — without it a host reloading
    // mid-match rebuilt its fog from an empty set and lost its explored
    // map (see applySavedGame's fromOpponentMirror branch).
    otherTeamExploredEver: (() => {
      let other = (typeof myTeam !== 'undefined' && myTeam === 1) ? 0 : 1;
      let ever = new Set(teamExploredEver[other]);
      if (teamExploredGrid && teamExploredGrid[other]) {
        let eg = teamExploredGrid[other];
        for (let k = 0; k < eg.length; k++) if (eg[k] === 1) ever.add(k);
      }
      return Array.from(ever);
    })(),
    bellRinging: window.bellRinging || Array.from({length: NUM_TEAMS}, () => false)
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

function applySavedGame(data, opts){
  if (!data || typeof data !== 'object' || !Array.isArray(data.entities) || !Array.isArray(data.map)) {
    if (window.showMsg) showMsg('Load failed: not a recognized save file');
    return;
  }
  // serializeGame stamps version:2 — actually check it (the net layer's
  // NET_PROTOCOL_VERSION exists for the same reason), so a future format
  // change fails loudly here instead of misloading silently.
  if (data.version !== 2) {
    if (window.showMsg) showMsg('Load failed: unsupported save version (' + data.version + ')');
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
    // Sized per-team structures follow the save's team count.
    NUM_TEAMS = data.numTeams || 2;
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
    // A guest-originated save (savedByTeam 1) loaded from a FILE: the
    // loader always becomes the HOST, and the host is team 0 everywhere in
    // this 1v1 design — so without correction the loading guest would
    // resume commanding their OPPONENT's civilization. Swap the two player
    // teams wholesale (gaia untouched) so the loader keeps their own
    // units/buildings/resources; they render blue now because team 0 IS
    // blue, but they command their own side. After the swap the save is
    // indistinguishable from a host-originated one (data.fog is the
    // loader's own grid = team 0's).
    // NOT for the crash-recovery handback (opts.fromOpponentMirror — see
    // the 'request-state' handler, js/net-sync.js): there the loader is
    // the ORIGINAL host recovering the world from the guest's live mirror,
    // the guest is still connected as team 1, and teams must stay put.
    if (data.savedByTeam === 1 && !(opts && opts.fromOpponentMirror)) {
      data.entities.forEach(e => {
        if (e.team === 0) e.team = 1;
        else if (e.team === 1) e.team = 0;
      });
      (data.corpses || []).forEach(c => {
        if (c.team === 0) c.team = 1;
        else if (c.team === 1) c.team = 0;
      });
      if (Array.isArray(data.resources) && data.resources.length >= 2) {
        [data.resources[0], data.resources[1]] = [data.resources[1], data.resources[0]];
      }
      if (Array.isArray(data.bellRinging) && data.bellRinging.length >= 2) {
        [data.bellRinging[0], data.bellRinging[1]] = [data.bellRinging[1], data.bellRinging[0]];
      }
      (data.projectiles || []).forEach(pr => {
        if (pr.attackerSnap) {
          if (pr.attackerSnap.team === 0) pr.attackerSnap.team = 1;
          else if (pr.attackerSnap.team === 1) pr.attackerSnap.team = 0;
        }
      });
      // Per-team controller/AI/hit state swaps with the teams (an AI
      // state's own `team` field must track its new slot).
      // (2-team swap by design — the whole savedByTeam model is 1v1.)
      ['teamControllers', 'aiStates', 'lastTeamHit', 'teamAlliance', 'defeatedTeams'].forEach(k => {
        if (Array.isArray(data[k]) && data[k].length >= 2) {
          [data[k][0], data[k][1]] = [data[k][1], data[k][0]];
        }
      });
      (data.aiStates || []).forEach((st, t) => { if (st) st.team = t; });
      // teamExploredEver[1] (the rejoining opponent's memory) now comes
      // from the saver's otherTeamExploredEver — same slot the
      // host-originated path expects it in.
      data.savedByTeam = 0;
    }
    if (data.savedByTeam === 1 && opts && opts.fromOpponentMirror) {
      // Guest-authored snapshot with teams left in place: data.fog is TEAM
      // 1's live grid and otherTeamExploredEver is team 0's explored-ever
      // memory (see serializeGame) — the mirror image of what the loading
      // host (team 0) needs. Rebuild this side's fog from team 0's memory
      // (explored, not currently-visible; updateFog() below re-lights the
      // live tiles) and team 1's memory from the guest's own fog grid.
      let hostEver = new Set(data.otherTeamExploredEver || []);
      fog = [];
      for (let y = 0; y < MAP; y++) {
        fog[y] = [];
        for (let x = 0; x < MAP; x++) fog[y][x] = hostEver.has(y * MAP + x) ? 1 : 0;
      }
      teamExploredEver[1] = new Set();
      (data.fog || []).forEach((row, y) => row.forEach((v, x) => {
        if (v > 0) teamExploredEver[1].add(y * MAP + x);
      }));
    } else {
      fog = data.fog || [];
      teamExploredEver[1] = new Set(data.otherTeamExploredEver || []);
    }
    teamExploredEver[0] = new Set();
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
    // paused on that screen indefinitely, and since hostSyncTick() only
    // ever runs inside the host's own update() loop (js/loop.js), which
    // doesn't run while gamePaused, the guest would see no updates
    // (resources, positions, anything) until the host happened to
    // manually dismiss it. Detected BEFORE the netRole/guestNeedsFullSync
    // block below (which is what would otherwise look identical for both
    // cases — a host that's about to (re-)host and a host that's already
    // mid-match).
    let alreadyConnectedHost = typeof netRole !== 'undefined' && netRole === 'host' && netConnected;

    // Seed the deterministic explored-grids from the save (they postdate
    // the save format): team 0 from the restored fog, team 1 from the
    // opponent's explored history. Approximate but deterministic — and a
    // connected guest immediately receives the exact grids via the
    // lockstep resume below, so both peers agree bit-for-bit.
    resetTeamVision();
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) {
      if (fog[y] && fog[y][x] > 0) teamExploredGrid[0][y * MAP + x] = 1;
    }
    teamExploredEver[1].forEach(k => { teamExploredGrid[1][k] = 1; });

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
