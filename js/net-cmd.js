// ---- MULTIPLAYER: command relay (guest -> host) ----
// The guest never mutates world state directly. Every action that would
// normally call doCommand/doPlace/finalizeWallDrag/trainUnit/cancelQueue/
// toggleTownBell locally instead calls sendCommand() (see the guest
// branches added at each of those call sites in input.js/ui.js) and the
// HOST re-runs the exact same function, reusing all of its targeting/
// validation/affordability logic rather than duplicating any of it —
// just temporarily substituting `selected` with the guest's own units
// first, via withRemoteSelection, so the reused code only acts on them.

function sendCommand(intent){
  sendToHost({ type: 'cmd', intent });
}

// Snapshot of the guest's own current viewport, attached to any intent
// whose kind resolves raw screen-pixel coordinates (command/
// build-placement) — see withRemoteViewport() below for why.
function currentViewSnapshot(){
  return { camX, camY, zoom: ZOOM, w: W, h: H, topH };
}

// Runs ONLY on the host. Temporarily swaps `selected` to the units the
// intent names (resolved by id against the HOST's own entitiesById — never
// trust object identity from across the network), runs fn(), then restores
// whatever the host's own player had selected locally. A guest's command
// must never disturb the host's own UI selection.
//
// Also temporarily swaps myTeam itself to 1 (the guest's fixed team in
// this 1v1 design — see js/init.js's enterGuestJoinMode). doCommand/
// doPlace/etc. use myTeam internally for every "is this mine" ownership
// check (movers filtering, rally-building ownership, build-target
// ownership...) — without this, those checks would filter everything
// against the HOST's own team (0) even while processing a command that's
// supposed to be acting on the guest's team-1 units, silently discarding
// all of them.
// Set true for the ENTIRE duration of applyRemoteCommand() below (every
// relayed command kind, not just the ones that happen to go through
// withRemoteSelection) — read by doCommand()/doPlace()/finalizeWallDrag()/
// trainUnit()/cancelQueue()/prepayFarm()/reactivateFarm() (js/input.js,
// js/ui.js) to suppress the local-acknowledgment sound/click-ripple marker/
// showMsg() status text those normally fire. Those exist to give feedback
// to whoever physically triggered the action; the guest already got its
// own instant local feedback in its own tab before this was ever sent, so
// the host replaying the same shared function to apply the actual
// game-logic effect shouldn't ALSO pop a sound/marker/message on the
// HOST's own screen for an action the host had nothing to do with.
let isReplayingRemoteCommand = false;

function withRemoteSelection(unitIds, fn){
  let hostSelected = selected;
  let hostTeam = myTeam;
  selected = (unitIds || []).map(id => entitiesById.get(id)).filter(Boolean);
  myTeam = 1;
  try { fn(); } finally { selected = hostSelected; myTeam = hostTeam; }
}

// doCommand()/doPlace() take raw screen-pixel coordinates and resolve them
// to world position/entities themselves (screenToTile, getUnitUnderCursor,
// etc.), all of which read the CURRENT camX/camY/ZOOM/W/H/topH globals.
// Host and guest each have their own independent camera and (possibly)
// window size, so calling doCommand(intent.sx, intent.sy) with the host's
// own viewport state would resolve the guest's click to a completely wrong
// world location. Fixed by having the guest snapshot its own viewport at
// send time (see the view:{...} field added at each sendCommand() call
// site) and having the host temporarily impersonate it for the one call.
function withRemoteViewport(view, fn){
  if (!view) { fn(); return; }
  let h = { camX, camY, ZOOM, W, H, topH };
  camX = view.camX; camY = view.camY; ZOOM = view.zoom; W = view.w; H = view.h; topH = view.topH;
  try { fn(); } finally { camX = h.camX; camY = h.camY; ZOOM = h.ZOOM; W = h.W; H = h.H; topH = h.topH; }
}

function applyRemoteCommand(intent){
  if (!intent || !intent.kind) return;
  isReplayingRemoteCommand = true;
  try {
  switch (intent.kind) {
    case 'command':
      withRemoteViewport(intent.view, () => {
        withRemoteSelection(intent.unitIds, () => doCommand(intent.sx, intent.sy));
      });
      break;
    case 'build-placement': {
      let hostPlacing = placing;
      placing = intent.placing;
      withRemoteViewport(intent.view, () => {
        withRemoteSelection(intent.unitIds, () => doPlace(intent.sx, intent.sy));
      });
      placing = hostPlacing;
      break;
    }
    case 'wall-drag': {
      let hostPlacing = placing;
      placing = 'WALL';
      withRemoteSelection(intent.unitIds, () => {
        window.wallDragStart = intent.start;
        window.wallDragEnd = intent.end;
        window.wallDragCorner = intent.corner;
        finalizeWallDrag();
      });
      placing = hostPlacing;
      break;
    }
    case 'train-unit': {
      let bldg = entitiesById.get(intent.bldgId);
      if (bldg) trainUnit(bldg, intent.utype);
      break;
    }
    case 'cancel-queue':
      cancelQueue(intent.bldgId, intent.idx);
      break;
    case 'delete-units':
      // Resolved by id against the HOST's own entitiesById (never trust
      // anything from across the network as an object reference). The
      // team check is enforced HERE, not just client-side in js/input.js:
      // deleteOwnedEntity() doesn't re-check ownership, and without this
      // a modified guest client could delete the host's entire army by
      // sending arbitrary ids — an instant win. The guest is always team
      // 1 in this 1v1 design.
      (intent.unitIds || []).forEach(id => {
        let en = entitiesById.get(id);
        if (en && en.team === 1) deleteOwnedEntity(en);
      });
      break;
    case 'prepay-farm':
      // prepayFarm()/reactivateFarm() internally use the shared myTeam
      // indirection (canAfford/spendCost/resourceStore(myTeam)) to know
      // whose resources to spend — same reason doCommand/doPlace need
      // withRemoteSelection's myTeam swap. No unit selection involved, so
      // an empty id list — only the myTeam swap matters here.
      withRemoteSelection([], () => prepayFarm());
      break;
    case 'reactivate-farm':
      withRemoteSelection([], () => {
        let farm = entitiesById.get(intent.bldgId);
        if (farm) reactivateFarm(farm);
      });
      break;
    case 'eject-garrison': {
      let bldg = entitiesById.get(intent.bldgId);
      if (bldg) ejectGarrison(bldg, gu => gu.id === intent.unitId);
      break;
    }
    case 'town-bell':
      // Guest is always team 1 in this 1v1 design (host stays team 0) — see
      // js/init.js's enterGuestJoinMode. window.aiBellActive is the same
      // flag ai.js sets for team 1's bell state, and is already part of the
      // sync payload (js/save.js), so the guest's bell icon updates on the
      // next sync via myBellActive() in ui.js.
      window.aiBellActive = !!intent.ringing;
      if (intent.ringing) ringTownBell(1); else soundAllClear(1);
      if (typeof updateUI === 'function') updateUI();
      break;
  }
  } finally {
    isReplayingRemoteCommand = false;
  }
}

onNetMessage((msg) => {
  if (msg.type === 'cmd' && netRole === 'host') {
    applyRemoteCommand(msg.intent);
  }
});
