# Multiplayer — what's built, and what's next

A quick reference for the 1v1 PeerJS multiplayer feature: how it works,
what's been verified, and where the obvious next improvements are.

## How it works

**Host-authoritative.** One peer ("host") runs the actual simulation,
exactly like single-player — team 0 is the host, team 1 is normally the
AI. The other peer ("guest") replaces the AI on team 1: it never
simulates the world itself, it just sends its clicks to the host and
renders whatever the host sends back.

**Connection**: PeerJS over WebRTC, using PeerJS's free public cloud
signaling server (no custom backend). The host generates a shareable link
(`?join=<peerId>`); the guest opens it and auto-connects.

**Files**:
- `js/net.js` — PeerJS connection plumbing (host/join, message envelope)
- `js/net-sync.js` — host → guest world-state broadcast
- `js/net-cmd.js` — guest → host command relay (move/attack/gather, build
  placement, wall drag, train unit, cancel queue, town bell)
- `myTeam` (in `js/core.js`) — the one variable that makes "which team am
  I" work throughout `input.js`/`ui.js`/`logic.js`; 0 for host/single-player,
  1 for a connected guest

**Sync payload**: originally reused the file-based Save/Load feature's
full-snapshot serializer verbatim (`serializeGame()`), sent ~6×/sec. That
came out to ~290KB/sync (~1.7MB/s continuous) because `map`+`fog` are both
full `MAP×MAP` arrays. Optimized down to ~13KB/sync by:
- never sending `fog` at all (it's always uniform in multiplayer — fog is
  disabled entirely, see below)
- sending `map` in full only once (on connect/reconnect), then only the
  small list of cells that actually changed since the last sync
  (`markMapDirty()`, hooked at every map-mutating call site: building
  placement, resource gathering, farm reseed/exhaustion, demolition)
- rounding entity coordinates to 2 decimals on the wire
- PeerJS's more compact `binary` serialization instead of the `json` default

Further compressed every message (`js/net.js`) with the browser's built-in
`CompressionStream('deflate-raw')` before it hits the wire — JSON's
repeated key names/structure compress far better than any hand-rolled
scheme would, for no ongoing maintenance cost. Measured on the real
connection: ~1.8KB/sync average (down from ~13-14.5KB), taking sustained
bandwidth from ~210KB/s to **~26.5KB/s** at the current ~15 syncs/sec
target. Applied uniformly to 'cmd' messages too, not just 'sync', for one
code path. Both directions use their own strict-order promise queue
(`queueSend`/`queueReceive`) since compression is async and two overlapping
compress/decompress calls aren't guaranteed to resolve in the order they
were started — without that, a later-sent-but-faster-to-compress message
could get dispatched before an earlier one, which the rest of the system
(e.g. "the next sync always corrects/overwrites the previous one") assumes
can't happen. One PeerJS gotcha hit along the way: `serialization:'none'`
looked like the cleanest fit (we're already handing over fully-encoded
bytes) but isn't an actual registered serializer in this PeerJS build
(`this._serializers[t.serialization] is not a constructor`) — stuck with
`serialization:'binary'` instead, which still wraps a `Uint8Array` as an
efficient binary blob with only small framing overhead.

## What works today

Verified end-to-end with real two-browser-context testing (not just code
review) at every stage:
- Connection over PeerJS's real cloud signaling server, including with
  deliberately mismatched viewport sizes between host and guest
- Move/attack/gather commands, building placement (including walls/gates),
  unit training, queue cancellation, town bell — all correctly relayed and
  applied on the host, synced back to the guest
- Reconnect forces a fresh full map resync rather than assuming the guest
  already has current state
- Single-player is completely unaffected (confirmed via regression tests)
- Mid-match disconnect (in-page drop, and a guest fully closing/reopening
  their tab) — game pauses, a full-screen alert shows on both sides, and
  reconnecting resumes the match in place, verified functional afterward
  (not just "connected")

## Recently completed

- **Guest-side particle effects — same "derive it locally instead of
  needing the host to send anything new" idea as fog-of-war, applied to
  the whole particle system.** Particles were never networked at all
  (deliberately, per `js/net-sync.js`'s payload-building comment), so a
  guest previously never saw blood on death, hit-particles during combat,
  smoke/fire on damaged buildings, or resource-gather puffs — all of
  those are host-only simulation side-effects. Fixed by having the guest
  independently notice the same underlying state changes it already
  receives every sync (an hp decrease, a new corpse, a changed map-tile
  resource value) and spawn the identical particle locally:
  - Death blood-burst and combat hit-particles: `js/net-sync.js`'s
    `applyNetSync()` now diffs each new sync's entity hp against the
    previous one (`guestPrevHp`, `js/core.js`) and reacts to each new
    corpse id once (`guestReactedCorpses`) — same colors/counts as
    `js/logic.js`'s `damageEntity()`/`handleDeath()`.
  - Gather-tile depletion puff: hooked into the existing `mapDelta`
    application loop in the same function — a resource-tile `res`
    decrease in a delta already tells us a gather cycle just happened,
    no new signal needed.
  - Damaged-building smoke/fire: `js/loop.js`'s new
    `advanceGuestBuildingEffects()`, called once per rendered frame from
    `js/init.js`'s guest loop, replicating `update()`'s existing hp-
    threshold logic but throttled by `guestBuildingFxTick` (per-building,
    per-effect last-fired tick) rather than a bare `tick % N` check —
    the guest's `tick` advances fractionally every frame (unlike the
    host's once-per-simulation-step integer), so the naive version would
    fire on every frame within the same multiple-of-N window instead of
    once, flooding the screen with particles.
  - This surfaced a real prerequisite bug: nothing was aging or moving
    the guest's own particles at all (`update()`'s particle-physics tick,
    where a particle's position/drag/gravity/life-countdown normally
    happen, never runs on the guest), and `applyNetSync()` was
    unconditionally resetting `particles = []` on every sync — harmless
    when the guest never spawned any, but would have cut every new
    particle's ~0.7-2s intended lifespan down to a few dozen
    milliseconds. Added `js/loop.js`'s `advanceGuestParticles()` (same
    physics as `update()`'s block, scaled by `elapsedMs/timeStep` like
    the other guest-side interpolation functions instead of per whole
    tick) and removed the blanket reset.
  - Two smaller, same-shape bugs found and fixed in the same pass: the
    corpse ground-impact dust puff (`c.impactFx`) and the one-impact-per-
    work-swing wood-chip/mining-spark particle (`e._swingCyc`) both lived
    directly on objects that get wholesale-replaced by every sync
    (corpses/entities respectively) — re-triggering repeatedly on the
    guest instead of once. Moved to `corpseImpactFxDone`/`workSwingCycles`
    (`js/core.js`), same pattern as `treeFellTicks` below. Also found
    (and fixed) the write side of the minimap "recently hit, blink white"
    flag was hardcoded `if (target.team === 0)` — never set at all for
    team 1, so a guest's own units never blinked when hit regardless of
    the myTeam-relative read side already in place; same "host-only
    simulation, myTeam is constant there" trap as the rally-point bug —
    fixed by recording it for either team unconditionally.
  - Verified directly: death/hit particles appear on the guest at the
    right counts/colors, particles actually decay to zero within a few
    seconds rather than persisting forever or vanishing within one sync
    interval, sustained building damage produces a bounded (not runaway-
    growing) particle count over several seconds, and a gather-tile delta
    produces the matching puff. Full regression suite still passes.

- **Tree-falling animation repeated forever once a tree dropped below its
  fall threshold, guest-side only.** `js/render-terrain.js` stored
  `fellTick` directly on the map tile object — but every wood-chop
  decrements that tile's `res`, which calls `markMapDirty()` and sends it
  as a dirty-cell delta; applying that delta on the guest replaces the
  whole tile object (`map[y][x] = cell`) with a fresh one from the wire,
  wiping whatever `fellTick` had been set. Since the trigger is `res<=60
  && fellTick===undefined`, every subsequent chop below that threshold
  saw a fresh `undefined` and restarted the fall animation from scratch —
  exactly the "keeps repeating over and over" reported. Same bug shape as
  `scoutedByMe` earlier this session: moved to `treeFellTicks`
  (`js/core.js`), a plain `Map` keyed by tile coordinate, entirely outside
  the synced map data. Verified directly: simulated 5 more chops on the
  same tile after crossing the threshold and confirmed the guest's
  recorded fall-start tick stays identical instead of resetting each time.

- **Full audit for the same bug shapes, after finding 5 real instances in
  one session** — systematically searched every `.team === 0/1` /
  `!== 0/1` literal and every input.js/ui.js action handler for the two
  patterns that kept recurring. Found and fixed ~15 more sites:
  - **Client-side "whose perspective" bugs (fixed with `myTeam`)**: building
    team color inverted for the guest (`js/render-buildings.js` — a guest
    would see their OWN buildings in enemy red), same for units/corpses/
    minimap blink (`js/render-units.js`, `js/render-fx.js` — added a
    shared `teamColor()` helper in `js/core.js` so buildings/units/minimap
    are all consistently relative to `myTeam` instead of a mix of relative
    and absolute), build-ghost-preview validity/color and gate-wall-
    snapping (`js/render-fx.js`), building HP/progress-bar visibility and
    garrison-count label (`js/render-buildings.js`), rally-point flag/line
    indicator (`js/render.js`), camera-follow toggle (`js/init.js`), and
    adaptive music mood detection — danger/war were swapped for a guest
    (`js/audio.js`).
  - **Host-simulation bugs, NOT fixable with `myTeam`** (this runs during
    the host's normal per-tick processing of every entity regardless of
    team — `myTeam` is constant there, always 0, except briefly during a
    relayed-command callback where it's swapped but the underlying data
    it should govern isn't): a trained unit's rally point (garrison-on-
    rally and auto-command-on-rally) was hardcoded to team 0 only,
    silently doing nothing for a guest's buildings — fixed by applying it
    to both player teams unconditionally (`js/logic.js`), since a rally
    point is a universal mechanic, not a "my team" check. Exhausted farms
    auto-reseed for team 1 — correct when team 1 is genuinely the AI
    (single-player), but was also silently auto-spending a real guest's
    wood in multiplayer with no say in it — fixed by gating the auto-
    reseed on `netRole === null` (`js/logic.js`).
  - **A real regression caught only by re-running the existing build
    test, not by reasoning alone**: `canPlace()`'s "can't build on
    unexplored tiles" check was tried as `team===myTeam`, which looked
    right for the guest's own client-side preview — but broke the HOST's
    actual execution of a relayed guest build command, because the fog
    grid *itself* is only ever team 0's data on the host (the temporary
    `myTeam` swap during a relayed command doesn't make `fog` valid for
    team 1) — so it was comparing the guest's placement against the
    host's own vision, wrongly refusing builds the guest could clearly
    see. Reverted to `team===0` — same category as the already-documented
    combat-targeting limitation below, not a quick fix.
  - **Missing guest-relay guards** (same bug class as the Delete key,
    caught in the same audit): `prepayFarm()`/`reactivateFarm()`
    (`js/ui.js`) and the garrison-eject minimap-icon click handler had no
    `netRole==='guest'` check at all and no relay command defined —
    added `'prepay-farm'`/`'reactivate-farm'`/`'eject-garrison'` intent
    kinds (`js/net-cmd.js`).
  - Deliberately NOT fixed (documented, not silently missing): the many
    `showMsg`/sound-effect call sites in `js/logic.js` (farm reseeded,
    resource unreachable, under attack, training fanfare, etc.) are
    genuinely host-screen-only feedback with no way to reach the guest's
    own screen without a new server→guest notification message — a real
    but much larger feature, not a mechanical fix like everything else
    here.
  - Verified with a dedicated two-browser-context test per fix (team
    colors, rally point actually walking/garrisoning, prepay/reactivate/
    eject-garrison relaying and taking effect on the host, single-player's
    AI still auto-reseeding correctly, multiplayer's guest farm correctly
    NOT auto-reseeding) plus the full existing regression suite.

- **Delete/Backspace (killing your own unit/building — a real gameplay
  action, e.g. to free population cap) never worked for the guest.**
  `js/input.js`'s handler called `handleDeath()` directly, with no check
  for `netRole==='guest'` — since the guest is never authoritative, this
  only ever mutated the guest's own local (about-to-be-overwritten) copy;
  the next regular sync from the host, which never saw it happen,
  silently reverted it. Symptom exactly as reported: delete your own
  TC as the guest, "DEFEAT" flashes, then reverts back to a live match a
  moment later. Fixed the same way every other guest action already works
  — relayed as a `'delete-units'` command (`js/net-cmd.js`) that the host
  executes for real. Extracted the shared logic into `deleteOwnedEntity()`
  (`js/logic.js`), which also fixes a second bug found in the same
  code: the unfinished-foundation refund always credited `resourceStore(0)`
  regardless of whose building it was — a guest cancelling their own
  foundation was refunding the *host's* resources, not their own. Verified
  both directly: guest deleting their own villager (persists correctly,
  confirmed still gone 1s later) and guest deleting their own TC (correct
  defeat that stays defeated, not the flash-then-revert from before).

- **Two more team-0-hardcoded bugs found while investigating a report of
  "guest's idle villagers missing the '?' indicator."**
  1. The idle-villager `?` marker (`js/render-units.js`) was gated on
     `e.team===0` — exactly the same bug shape as the fog-of-war one
     above, just missed in that pass since it's rendering logic, not fog
     itself. Fixed to `e.team===myTeam`.
  2. **A more serious one found along the way, unrelated to what was
     reported**: `won` is computed and networked as a raw "did team 0
     win" boolean (`js/logic.js`'s `handleDeath`, copied verbatim by
     `js/net-sync.js`'s `applyNetSync`) — every UI site that read it
     directly (`js/ui.js`'s bottom panel, `js/init.js`'s full-screen
     victory/defeat banner and end-game music trigger) would show the
     **guest the exact inverse of their actual outcome**: win as the
     guest and see "DEFEAT", lose and see "VICTORY". Added `didIWin()`
     (`js/core.js`: `myTeam === 0 ? won : !won`) and swapped every
     UI-facing read to go through it instead of the raw flag.
  3. **Also found, same investigation**: `update()` (`js/loop.js`)
     early-returns the instant `gameOver` is true — meaning
     `hostSyncTick()` (called later inside it, on the normal cadence)
     never runs again after the game ends. Unless the exact tick the game
     ends on happens to coincide with a scheduled sync, the guest would
     never receive the final `gameOver`/`won` state at all — stuck
     forever not knowing the match had ended. Fixed by snapshotting
     `gameOver` at the top of `handleDeath()` and forcing one broadcast
     the instant it flips true, regardless of tick timing.
  - All three verified with a real two-browser-context test: killing a
    unit and checking the guest's corpse arrives with correctly-rebased
    death-animation timing (already worked, confirmed not broken — corpse
    `deathTime` rebasing via `ageAtSaveMs` already existed), destroying
    the host's own TC and confirming the guest's `gameOver` flips
    immediately and `didIWin()` correctly returns opposite values on each
    side despite sharing the same underlying `won` flag.

- **Real per-team fog of war** (previously the biggest item in Known
  Limitations). Both players used to see the entire map — `updateFog()`
  was hardcoded to `if (e.team !== 0) return;`, a leftover single-player
  assumption, worked around by forcing `window.fogDisabled = true` for MP.
  Turned out to need almost no new architecture: `updateFog()` now checks
  `e.team !== myTeam` (the same host-is-0/guest-is-1 indirection already
  used everywhere else), and since fog was already never sent over the
  network, each client just computes its OWN team's real vision locally
  from the fully-synced entities/map — no protocol change. Good news
  found during research: the AI (`js/ai.js`) already fully ignores fog for
  its own decisions (a stubbed-out scouting check that always returns
  `true`), so there was no AI/fog coupling to preserve.
  - **Two real bugs found only by actually connecting a host+guest and
    checking `fog`'s contents, not by reading the change in isolation**:
    (1) `net-sync.js` pre-allocated the guest's `fog` array with a bare
    `new Array(MAP)` per row — a sparse array of holes (`undefined`), not
    filled with `0`. Invisible for the entire time MP forced
    `fogDisabled` (that branch of `updateFog()` unconditionally overwrites
    every single cell, masking the gap), but the instant real fog
    computation only touches cells within someone's sight radius, every
    tile neither player ever visited stayed `undefined` forever instead of
    resting at "unexplored". Fixed by calling the real `initFog()`
    instead. (2) The `_seen` flag marking a scouted enemy building
    "remembered" (`js/render.js`/`js/loop.js`) lived directly on the
    shared entity object — which gets wholesale-replaced by every sync.
    Each client's own "have I personally scouted this" memory would have
    been silently clobbered by the other side's copy every ~65ms, same
    failure shape as an earlier session bug with unit-facing state.
    Replaced with `scoutedByMe` (`js/core.js`) — a plain `Set` of building
    ids kept entirely outside the synced entity data (same pattern as
    `entitiesById`/`selected`), so it's genuinely local and per-client:
    the host remembers what team 0 scouted, the guest independently
    remembers what team 1 scouted, and a sync can never touch either.
  - Verified with real fog-distribution counts on both sides (each
    ~228/8100 tiles visible at match start, correctly 0 at the *other*
    player's base), a scout physically walking 20 tiles and the target
    tile's fog transitioning from unexplored → visible exactly as it
    arrived, and screenshots of both players' actual rendered views
    showing properly limited vision instead of the whole map. Full
    existing regression suite still passes. One deliberately deferred
    correctness gap: see Known Limitations below (combat auto-acquire).

- **Load Game / Host Multiplayer Game row wasn't actually full-width.**
  The `Start | ?` row above it stretches edge-to-edge (`flex: 1 1 auto` on
  `#start-game-btn`), but `#load-game-btn`/`#host-game-btn` had no such
  rule — each just sat at its own natural content width, centered inside
  its half of `.menu-row-pair`, leaving visible gaps on both outer edges
  that didn't match the row above. Added both to the same
  `flex: 1 1 auto` rule (`styles.css`/`classic-style.css`) so the row now
  spans the exact same width as `Start | ?` above it. Verified with a
  screenshot — both rows now align edge-to-edge.

- **Pre-game setup grid: was never actually a grid at any screen width.**
  `.setup-row`/`.setup-col` (`styles.css`/`classic-style.css`) forced
  `flex-direction: column` unconditionally — a deliberate mobile-friendly
  stack — but that meant every setting (Difficulty, Map Size, Speed,
  Sound, Music) rendered as its own full-width row even on desktop,
  despite the HTML already grouping them into row-pairs
  (Difficulty+MapSize, Speed+Sound+Music) that were never actually laid
  out side by side. Result: a tall menu, and a visible asymmetry where
  Music's row (2 segments) split differently than every other row's
  (3 segments) with no shared column edges to compare against. Added a
  `@media (min-width: 700px)` override that turns each `.setup-row` into a
  real side-by-side grid (label-above-control per column, since
  label-left/control-right doesn't fit a narrower per-column width) —
  narrower screens keep the exact original stacked layout untouched.
  Verified at both 1300px (now 2 compact, symmetric rows instead of 5) and
  420px (pixel-identical to before).

- **Save button moved to fix a real layout asymmetry.** Once Restart/Load
  were dropped from the mid-game menu, whatever was left in
  `#save-load-row` was just Save Game alone — sitting small and
  off-center below the full-width Resume row, a visibly unbalanced
  two-tier stack. Moved `#save-game-btn` out of `#save-load-row` and into
  `#start-row` itself (next to Resume/Restart/Help — pure DOM move, no id
  changes, so none of the many `getElementById`-based show/hide call sites
  in `js/init.js` needed touching). Mid-game is now one clean row: Resume
  | Save | Help (single-player) or just Resume | Save (multiplayer, Help
  hidden there already). `#save-load-row` now only holds Load Game,
  pairing cleanly with `#mp-row`'s Host button via the existing
  `.menu-row-pair` from the earlier pre-game cleanup.

- **Pre-game and mid-game menus both cleaned up for conciseness.**
  - Pre-game setup screen: dropped Save Game entirely (no match exists
    yet, so there's nothing to save — `#save-game-btn` starts
    `display:none` in the HTML itself, `applyMenuMode`/`restoreMenuForMatch`
    show it back once a match genuinely exists) and put Load Game + Host
    Multiplayer Game on one visual line (`.menu-row-pair` in
    `styles.css`/`classic-style.css` — wraps `#save-load-row`/`#mp-row`
    without merging them, since both are independently toggled by several
    other places in `js/init.js`).
  - Mid-game pause menu (single-player, since multiplayer's version was
    already simplified earlier — see below): Restart and Load are now
    hidden entirely too, keeping just Resume/Save Game/Help
    (`applyMenuMode('ingame')`) — restarting a match is just as easy by
    reloading the tab, and Load mid-game has the same "why would this
    overwrite my current progress" awkwardness Restart does.

- **"Host Multiplayer Game" no longer shown once a match is already in
  progress** (`applyMenuMode('ingame')`, `js/init.js`) — the label reads
  as "start a fresh match to host," but mid-game it would actually take
  your CURRENT progress online (`mpHostingFromExistingGame`), which isn't
  what the button promises and was confusing to stumble into via the
  pause menu. That capability didn't need the button anyway: loading a
  `wasMultiplayerGame`-tagged save already triggers it automatically (see
  below) without the user ever clicking Host themselves. The button still
  shows on the pristine pre-game setup screen and after clicking Restart
  (`restart-ready` mode) — only the "already mid-game" case hides it, for
  both single-player and multiplayer alike.
  - Also hid it the moment Host is first clicked (`onHostClicked()`),
    added to the same `.setup-grid, #save-load-row, #start-row` hide list
    — previously just `disabled`, so it sat there visibly grayed out on
    the whole "waiting for opponent" screen, reading as "you could still
    click this" rather than "you're already hosting."

- **Loading a multiplayer save now auto-hosts immediately** instead of
  requiring the user to manually reopen the menu and click Host — since
  the file is already tagged `wasMultiplayerGame: true`, we already know
  that's what they want. `applySavedGame()` (`js/save.js`) keeps the menu
  open and calls `onHostClicked()` itself, landing the user directly on
  the shareable-link screen. A single-player save loads exactly as before
  (menu closes, "Game loaded" message) — this only triggers for the
  multiplayer-tagged case.
  - **Real bug found by testing this end-to-end with a save that
    originated from the GUEST side specifically** (not just a host-
    originated one): the guest's local `tick` is deliberately fractional
    (`js/init.js`'s `gameLoop()` nudges it every frame — `elapsed/timeStep`
    — purely so `render-units.js`'s tick-driven walk-cycle animations keep
    playing between syncs; never meant to be authoritative). A save taken
    from the guest's side captures that fractional value. Loading it and
    hosting from it left `tick` permanently fractional (every future tick
    is just `+= 1` from there) — and `tick % netSyncIntervalTicks === 0`
    (`js/loop.js`'s sync-cadence check) then **never evaluates true
    again**, silently breaking `hostSyncTick()` forever with no error
    anywhere: the new guest would connect successfully (`netConnected:
    true`) but sit at zero entities permanently. Host-originated saves
    never hit this (host's tick is always a clean integer), which is
    exactly why it stayed invisible until guest-save existed and was
    tested combined with auto-host. Fixed with `Math.round(data.tick)` on
    load.

- **Mid-match menu simplified to just Resume + Save Game, for both roles.**
  `restoreMenuForMatch()` (`js/init.js`) now hides everything else once a
  match starts — Restart (`restartGame()` regenerates the whole match;
  only the host's simulation is authoritative, and a live 1v1 shouldn't
  support restarting it mid-game for either role), Load (loading a file
  mid-connected-match would just get overwritten by the host's next sync,
  or corrupt the guest's mirror of it — the intended flow is save now,
  close, load-and-host fresh later), the difficulty/map/speed/sound/music
  pickers, Help, and the "Host Multiplayer Game" button (already
  mid-match). Single-player's mid-game menu is untouched (still has
  Restart/settings/Help via the existing `applyMenuMode()`), this only
  applies once `netRole` is set.
  - **Guest now has Save Game access too** (previously host-only) — the
    guest's entities/map are a live mirror of the host's
    (`js/net-sync.js`), so `serializeGame()` called from the guest's side
    produces an equally valid snapshot. `wasMultiplayerGame` (`js/save.js`)
    now tags a save from either role, not just the host — the point of the
    tag is the same either way: whoever loads it later can click Host and
    pick up as the new host from that exact state, regardless of who
    originally saved it.
  - Also removed the "Switch to Classic/Mobile UI" link from both
    `index.html` and `classic.html`.

- **Guest's menu now pauses the host too (was host-only, one-directional).**
  Opening the guest's own local menu previously only froze their own
  screen — the host kept simulating in real time (still building/training/
  fighting) while the guest sat unable to respond, a real one-sided
  advantage in a 1v1. `toggleMenu()`'s broadcast is now symmetric: guest
  sends `{type:'guest-menu', open}` to the host exactly like the host
  already sent `{type:'host-menu', open}` to the guest, both handled by
  one `remoteMenuOpen` reason flag (renamed from the host-only
  `hostMenuOpenForGuest`) feeding the same `recomputeGamePaused()`. Host
  sees "Your opponent has paused the game." on the same overlay.

- **Mid-match pause-menu hardening — two real bugs found by direct
  reproduction, not code review.**
  1. `applyNetSync()` (`js/net-sync.js`) had a line meant to dismiss the
     guest's pre-match "Connecting…" panel on the first sync, but it
     unconditionally re-ran on *every* sync (~15/sec) — so the instant the
     guest opened their own local pause menu, the very next sync (~65ms
     later) force-closed it again by directly touching the DOM, bypassing
     `toggleMenu()`'s own `gamePaused` bookkeeping entirely. Symptom:
     the menu "quickly turns off" on its own, and the game is stuck
     paused with no visible menu to un-pause it (this is what looked like
     "interpolation breaking" — it wasn't broken, `gamePaused` was just
     stuck `true`). Fixed with a one-shot guard (`guestInitialMenuHidden`)
     so that code only ever fires once per page load.
  2. That fix surfaced (and this session then also fixed) a whole *class*
     of bug: several places independently forced `gamePaused = false`
     assuming they were the only reason the game was paused — including
     the mirror case, where the host's menu closing could incorrectly
     resume the guest even if the *guest's own* local menu was still open.
     Replaced every such site with one unified model in `js/init.js`:
     three independent boolean reasons (`localMenuOpen`,
     `hostMenuOpenForGuest`, `disconnectedPause`) ORed together by a
     single `recomputeGamePaused()`, which every handler calls instead of
     ever touching `gamePaused` directly.
  3. Separately, reopening the menu mid-match (either role) showed the
     stale pre-connection status text ("Connected!.../Opponent connected!
     Starting match…") with **no visible Resume button at all** —
     `#start-row` (which contains it) was hidden by the initial
     setup-screen hides (`onHostClicked()`/`enterGuestJoinMode`) and
     nothing ever undid that once the match actually started, unlike
     `#save-load-row` which already had this fix. New
     `restoreMenuForMatch(showSaveLoad)` re-shows `#start-row` and hides
     the stale status panel for both roles (guest gets `#start-row` only,
     no save/load access).
  - All three verified via actual screenshots of the reopened mid-match
    menu (not just DOM property checks) for both host and guest, plus a
    compound-scenario test (guest's own menu + host's menu toggling
    independently) and the full existing regression suite.

- **Guest-side movement interpolation/extrapolation.** The guest never
  runs its own simulation tick, so between syncs everything used to be
  frozen and then snap to the new position. Fixed with three small
  guest-only, position/rendering-only functions that replay the host's own
  stepping math locally every rendered frame, self-correcting on the next
  real sync: `advanceGuestUnits`/`advanceGuestProjectiles` (`js/loop.js`)
  for movement/arrow flight, plus a `tick` nudge in `js/init.js`'s
  `gameLoop()` so limb/tool-swing animations (all driven by `tick` in
  `render-units.js`) keep playing instead of freezing mid-pose. Also fixed
  a related bug this surfaced: `applyNetSync` was clobbering each unit's
  rendering-only facing-hysteresis state (`dir`/`facing`/`lastX`/`lastY`,
  see `render-units.js:262-328`) with the host's unrelated copy every sync,
  causing visible facing "twitches" — fixed by preserving those fields
  across the entity-array swap in `js/net-sync.js`.
- **Sync rate now GAME_SPEED-invariant.** The old sync cadence was a fixed
  *tick* count, and ticks/sec scales with `GAME_SPEED` — so speed 4 was
  silently sending 4x the bandwidth of speed 1 for the same setting.
  `NET_SYNC_TARGET_PER_SEC` (`js/net-sync.js`) now targets a constant real
  syncs/sec (~15), with the tick-interval recomputed each tick in
  `js/loop.js`. Benchmarked up to syncing every tick (120/sec at
  `GAME_SPEED=4`) with zero dropped ticks — confirmed no engine/PeerJS
  ceiling exists; 15/sec is a bandwidth judgment call, not a technical one.
- **Generic message compression.** Every message (`js/net.js`) now goes
  through `CompressionStream('deflate-raw')` before hitting the wire.
  Measured on the real connection: ~210KB/s → **~26.5KB/s** (~8x). See the
  Sync payload section above for the mechanics and the two gotchas hit
  along the way (async ordering, and `serialization:'none'` not actually
  being a registered PeerJS serializer).
- **Mid-match disconnect handling.** On disconnect, both sides now pause
  (`gamePaused = true`) and show a full-screen alert (`#mp-disconnect-
  overlay` in `index.html`/`classic.html` + both stylesheets — reuses the
  `#tutorial-box` parchment look, since that menu itself is hidden for the
  whole match). The guest auto-retries `joinSession()` against the
  remembered host peer id every 3s; the host just keeps listening on its
  existing PeerJS connection. `onNetConnectionOpen` (`js/init.js`) now
  distinguishes first-connect from reconnect via a `mpMatchStarted` flag —
  reconnect resumes in place (unpause, force a fresh full sync) instead of
  re-running `restartGame()` and wiping the match.
  - **Real gotcha found by testing an actual tab close, not just a
    synthetic `conn.close()` call**: PeerJS's own `close` event is not
    reliable for an abrupt tab kill — WebRTC often can't signal a clean
    close when the page just vanishes. In testing, it never fired at all
    within 6 seconds, and worse, the host's stale connection reference
    blocked the reopened guest's rejoin attempt entirely (permanent
    stuck state, not just a slow one). Fixed with a self-managed
    heartbeat: both sides ping every `NET_HEARTBEAT_MS` (1000ms) through
    the same compressed pipeline, and a watchdog declares the connection
    dead after `NET_TIMEOUT_MS` (4000ms, a 4x margin — tight enough to
    detect quickly, loose enough to not misfire on a single dropped
    packet or a backgrounded tab's throttled timers) regardless of
    whether PeerJS's own `close` ever fires. The host's incoming-
    connection guard was also loosened to always accept a fresh
    connection (tearing down whatever stale reference it had) rather than
    rejecting it as a disallowed "second guest." Verified end-to-end with
    a real browser-context close + reopen: detected in ~3s, and the
    reopened tab's rejoin is fully functional afterward (a move command
    was confirmed reaching the host post-rejoin, not just "connected").
- **Save/Load for multiplayer** — host-only, scoped deliberately: the host
  can save an in-progress hosted match, and can load a save file to start
  hosting a *new* session from that state rather than always generating a
  fresh map. The guest never has its own save/load — it just receives the
  loaded state via the normal full-sync, same as any fresh join or
  reconnect, so no new sync protocol was needed. `serializeGame()` tags
  the file with `wasMultiplayerGame: true` when saved mid-hosted-match
  (`netRole === 'host'` at save time — always true or null, since Save is
  host-only UI) — surfaced visibly, not just as a hidden field: the
  downloaded filename gets a `-mp` marker, and loading it back shows a
  distinct "Multiplayer game loaded — open the menu and click Host to go
  back online" message instead of the generic one.
  - `js/init.js`: `mpHostingFromExistingGame` (captured the instant Host is
    clicked) tells `onHostClicked()` to skip overriding the loaded save's
    map size/speed/fog with whatever the setup screen's pickers happen to
    show, and tells `onNetConnectionOpen`'s host branch to skip
    `restartGame()` (which would wipe the loaded state) in favor of just
    hiding the menu and forcing a full sync — same mechanism a reconnect
    already uses to catch a guest up.
  - `js/save.js`: `applySavedGame()` now sets `guestNeedsFullSync = true`
    whenever `netRole === 'host'` — a load discontinuously replaces the
    whole world out from under the periodic dirty-cell delta sync, so the
    next broadcast must be a full one regardless of whether the load
    happened before hosting even started or (also now safely supported,
    though not the primary use case) mid-match with a guest already
    connected.
  - **Real bug caught by testing the full flow, not just each piece in
    isolation**: hosting from a loaded save requires the pause menu to
    have been open (that's how the user reaches the "Host" button after
    loading), which sets `gamePaused = true` — the normal fresh-start path
    implicitly clears this via `restartGame()`, but the "keep the loaded
    state" path skipped that call entirely and so never unpaused. Result:
    the guest connected successfully (`netConnected: true`) but sat with
    zero entities forever, because the host's own tick loop (and therefore
    `hostSyncTick()`) never ran while still paused. Fixed by explicitly
    clearing `gamePaused` in that branch too. Caught by an end-to-end
    two-browser-context test that actually drove the whole save → reload
    → host → guest-joins sequence — inspecting each function in isolation
    would have looked correct.
  - `#save-load-row` (hidden by `onHostClicked()` to make room for the
    waiting-for-opponent link panel) is explicitly re-shown once the match
    starts, host-only — the guest's existing `enterGuestJoinMode` already
    hides every `.menu-button-container`, so it never gains access.
- **Host's menu pause now propagates to the guest.** Previously, the host
  opening their local pause menu (`toggleMenu()`) only paused the host's
  own simulation — the guest kept playing live, sending commands into a
  game the host couldn't see or respond to. `toggleMenu()` now broadcasts
  `{type:'host-menu', open: true/false}` (host-only, gated on
  `netConnected`) whenever it opens/closes; the guest pauses and shows a
  "Game Paused — the host has paused the game" overlay in response,
  reusing the same overlay element as the disconnect case (generalized
  into `showMpOverlay(title, text, spinner)`/`hideMpOverlay()` — spinner
  hidden here, since nothing is being retried). One edge case handled: a
  `hostMenuOpenForGuest` flag stops the guest's own local Resume click
  from un-pausing them out from under a host menu that's still open.

**Verified as one continuous real end-to-end cycle** (not just each piece
tested in isolation): host starts → guest joins → host opens menu (guest
paused + alerted) → host saves *while paused* → host resumes → host's tab
closes (guest correctly alerted via the heartbeat watchdog, ~4s) → host
reopens from the saved `-mp` file on a fresh page → hosts again (getting a
genuinely new peer id, since a fresh `Peer()` is created either way) →
guest rejoins via the new link → confirmed fully functional afterward with
a real move command. Two harmless PeerJS console errors appeared mid-cycle
(a heartbeat ping racing the host tab's teardown, and the guest's own
background auto-reconnect loop correctly failing against the now-dead old
peer id until pointed at the new link) — expected noise from otherwise-
correct behavior, not failures.

## Known limitations / good next improvements

Roughly in order of "most worth doing next":

1. **Client-side prediction for the guest's own commands.** Right now a
   guest's click has to round-trip to the host and come back on the next
   sync before anything visibly happens (~1 sync interval + RTT, smaller
   now that sync rate is ~15/sec, but still a real round-trip). Locally
   applying an optimistic guess (e.g. start the unit walking immediately)
   and reconciling against the host's authoritative answer when it arrives
   would cut perceived input lag further. More complex than the
   interpolation work above — needs a reconciliation strategy for when the
   guess was wrong (unreachable tile, insufficient resources, etc.).

2. **TURN relay fallback.** Only STUN is configured (PeerJS's default) —
   strict NATs/corporate firewalls without a TURN server may simply fail
   to connect. Not something to build from scratch casually (needs a TURN
   server, free ones are limited), but worth documenting clearly if anyone
   hits it.

3. **Entity delta encoding.** Still not done, but now much lower priority
   than when first considered — generic compression already got the
   payload from ~13-14.5KB down to ~1.8KB/sync without any structural
   change or the bug-risk of hand-rolled diffing. Only worth revisiting if
   payload size becomes a real problem again (e.g. much larger player
   counts or unit caps).

4. **Several combat/placement rules still only fog-gate team 0, same root
   cause, all needing a real team-1 fog grid on the host to fix properly.**
   The host's own `fog` variable only ever holds team 0's vision — always,
   even momentarily during a relayed guest command, since the temporary
   `myTeam` swap changes who a check is evaluated *for* but not what data
   `fog` actually contains. Fixing any of these needs the host to compute
   a *second*, independent fog grid for team 1 purely for these checks
   (not for rendering — the guest already does that correctly, locally).
   Known sites, all currently exempting team 1 from a real vision check
   it should probably have as a genuine player:
   - Combat target de-acquire (`logic.js` — a unit tracking a target it
     can no longer see) and idle-military auto-engage scanning
     (`logic.js`) both only fog-gate team 0; team 1 keeps the AI's
     "cheat-vision" fallback (a flat radius check) even when team 1 is a
     real multiplayer guest.
   - `canPlace()`'s "can't build on unexplored tiles" restriction — same
     thing, only ever applied to team 0. (Tried making it `myTeam`-relative
     instead — broke host-side execution of the guest's own legitimate
     builds, since `team===myTeam` inside the relayed-command context
     compares team 1's placement against team 0's fog. Reverted.)
   All are the same narrower unfairness ("can act through fog you
   shouldn't be able to see through"), not "can't see the map at all" —
   scoped out of the per-team fog work to keep it focused, and out of the
   broader team-0-hardcoding audit above for the same reason.

5. **Spectator mode / more than 2 players.** Architecture is strictly 1v1
   host-vs-guest today; anything beyond that is a bigger design change.
