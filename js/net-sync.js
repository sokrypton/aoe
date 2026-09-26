// ---- MULTIPLAYER: host-crash recovery ----
// The live sync machinery that used to fill this file is gone — matches
// run deterministic lockstep with rollback (js/lockstep.js), where each
// peer's own simulation is authoritative and only commands cross the wire.
//
// What remains is the one flow lockstep can't cover by itself: a HOST page
// that crashed/reloaded mid-match (?host= resume link, js/init.js) has no
// world at all. The guest's simulation is a complete copy — it hands the
// whole thing back as a save-grade snapshot, and the recovered host
// re-enters lockstep from it via the same resync machinery desync
// recovery uses (lockstepResumeGuest), which pushes the exact
// post-normalization state right back to the guest so both peers are
// bit-identical again.

onNetMessage((msg) => {
  if (msg.type === 'request-state' && netRole === 'guest') {
    let hasWorld = gameStarted && map.length > 0 && entities.length > 0;
    sendToHost({ type: 'state-snapshot', data: hasWorld ? serializeGameForWire() : null });
  }
  if (msg.type === 'state-snapshot' && netRole === 'host' && window.__mpSession.awaitingStateFromGuest) {
    window.__mpSession.awaitingStateFromGuest = false;
    if (window.__mpSession.stateRequestTimer) {
      clearInterval(window.__mpSession.stateRequestTimer);
      window.__mpSession.stateRequestTimer = null;
    }
    mpMatchStarted = true;
    window.fogDisabled = false;
    if (msg.data && typeof msg.data === 'object') {
      try {
        // fromOpponentMirror: WE are the original host recovering from the
        // guest's live copy — the guest stays team 1, no team swap (see
        // applySavedGame, js/save.js).
        applySavedGame(msg.data, { fromOpponentMirror: true });
        // The snapshot was authored by the GUEST — drop its UI leftovers
        // and look at our own base instead of wherever they were looking.
        selected = [];
        window.cameraFollowId = null;
        let own = entities.find(en => en.team === 0 && en.btype === 'TC') || entities.find(en => en.team === 0);
        if (own) {
          let iso = toIso(own.x + (own.w || 1) / 2, own.y + (own.h || 1) / 2);
          camX = iso.ix; camY = iso.iy;
        }
        // Re-enter lockstep from the recovered state on BOTH peers.
        lockstepActive = true;
        lockstepResetState();
        DET.enabled = true;
        lockstepResumeGuest();
        showMsg('Match recovered! Battle on');
      } catch (err) {
        console.error('Failed to apply recovered state:', err);
        showMpStatus('Could not recover the match state — see console.');
        return;
      }
    } else {
      // Guest had nothing to hand back — behave like a first connection.
      hostStartLockstepMatch();
    }
    restoreMenuForMatch();
  }
});
