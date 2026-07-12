// Shared page markup for BOTH index.html (mobile skin) and classic.html.
// The two pages used to be near-identical 292-line copies and had already
// drifted; now each is a thin shell that sets window.UI_VARIANT and loads
// this file, which injects the one true copy of the HUD/menus/overlays.
// Runs synchronously from a plain <script> at the top of <body>, so every
// element exists before any game script (core.js … init.js) queries it.
//
// The only variant difference left is the UI-switch link text (points at
// the OTHER skin) — the button strip, including the idle-villager button
// next to the bell, is identical in both skins.
// ---- Sprite-sheet cell registry: THE one place an icon gets a cell. ----
// sprites.png is a uniform 8x8 grid; every `.icon-<key>` rule is GENERATED
// from this table at boot and injected as a <style> shared by both skins.
// The background-position lists used to be hand-maintained in styles.css
// AND classic-style.css, plus more copies for the mini/tooltip variants —
// adding one unit meant four coordinated CSS edits. Now: draw into a spare
// cell, rename it here, done. (js/ui.js derives SPRITE_ICON_KEYS from this.)
window.SPRITE_CELLS = {
  // Sheet is grouped BY TYPE, with age progressions placed on adjacent cells
  // (e.g. militia→feudal→castle, TC wood→stone→castle, tower PTOWER→WT-feudal
  // →WT-castle, age crests dark→feudal→castle) so upgrades read left-to-right.
  // Icons are content-centered in their cells (see tools/resheet-sprites.py,
  // the one-shot that produced this layout). Age-variant buildings/units have
  // NO bare icon-<btype> cell — always age-suffixed, resolved via iconKey().
  // ---- rows 0-1: units. Row 0 infantry/archer lines (age variants adjacent).
  villager:[0,0], militia:[1,0], 'militia-feudal':[2,0], 'militia-castle':[3,0],
  spearman:[4,0], 'spearman-castle':[5,0], archer:[6,0], 'archer-castle':[7,0],
  // Row 1: cavalry / siege / trade / gaia.
  scout:[0,1], 'scout-castle':[1,1], knight:[2,1], ram:[3,1], tradecart:[4,1],
  sheep:[5,1], bear:[6,1], pop:[7,1],
  // ---- row 2: town / economy buildings (TC age progression first).
  'TC-dark':[0,2], 'TC-feudal':[1,2], 'TC-castle':[2,2], HOUSE:[3,2], MILL:[4,2],
  FARM:[5,2], LCAMP:[6,2], MCAMP:[7,2],
  // ---- row 3: military + defenses (Watch Tower progression + walls adjacent).
  BARRACKS:[0,3], MARKET:[1,3], PTOWER:[2,3], 'WT-feudal':[3,3], 'WT-castle':[4,3],
  WALL:[5,3], SWALL:[6,3], GATE:[7,3],
  // ---- row 4: gates (cont.) + resources.
  SGATE:[0,4], 'gate-lock':[1,4], 'gate-unlock':[2,4], food:[3,4], wood:[4,4],
  gold:[5,4], stone:[6,4],
  // ---- row 5: action glyphs.
  back:[0,5], cancel:[1,5], rally:[2,5], idle:[3,5], bell:[4,5], home:[5,5],
  map:[6,5], compass:[7,5],
  // ---- row 6: menu / tech glyphs + age crests (Dark→Feudal→Castle).
  econ:[0,6], mil:[1,6], research:[2,6], reseed:[3,6], logo:[4,6],
  'age-dark':[5,6], 'age-feudal':[6,6], 'age-castle':[7,6],
  // Home button by age = the TOP of each age's Town Center (keep + flag, base
  // cropped) so it reads clearly at button size. Base `home:[5,5]` is the
  // pre-match/no-age fallback. Resolved via iconKey('home') (ui.js).
  'home-dark':[0,7], 'home-feudal':[1,7], 'home-castle':[2,7],
  // ---- free slots for future icons (row 4 tail + row 7).
  spare1:[7,4], spare5:[3,7],
  spare6:[4,7], spare7:[5,7], spare8:[6,7], spare9:[7,7],
};
(function(){
  let css = '';
  for (const k in SPRITE_CELLS) {
    const cell = SPRITE_CELLS[k];
    css += `.icon-${k}{background-position:${(cell[0]/7*100).toFixed(4)}% ${(cell[1]/7*100).toFixed(4)}%;}\n`;
  }
  const st = document.createElement('style');
  st.id = 'sprite-cells';
  st.textContent = css;
  document.head.appendChild(st);
})();

(function(){
const variant = window.UI_VARIANT || 'mobile';

const SWITCH_LABEL = variant === 'classic' ? '📱 Switch to Mobile UI' : '🏰 Switch to Classic UI';

// Desktop controls differ per skin: classic keeps the AoE2 left-select /
// right-command contract; the mobile skin uses the TAP model on desktop
// too (a left-click selects OR commands by context — see the mouseup
// dispatch in js/input.js).
const DESKTOP_HELP_ROWS = variant === 'classic'
  ? `<div class="help-kv"><span class="help-k">Left-click</span><span class="help-v">select units</span></div>
     <div class="help-kv"><span class="help-k">Right-click</span><span class="help-v">do stuff</span></div>
     <div class="help-kv"><span class="help-k">Scroll wheel</span><span class="help-v">zoom</span></div>`
  : `<div class="help-kv"><span class="help-k">Click</span><span class="help-v">select, or command selected units</span></div>
     <div class="help-kv"><span class="help-k">Shift-click</span><span class="help-v">add/remove a unit</span></div>
     <div class="help-kv"><span class="help-k">Drag</span><span class="help-v">box-select</span></div>
     <div class="help-kv"><span class="help-k">Right-click</span><span class="help-v">also commands</span></div>
     <div class="help-kv"><span class="help-k">Scroll wheel</span><span class="help-v">zoom</span></div>`;

document.body.insertAdjacentHTML('afterbegin', `
<canvas id="game"></canvas>
<div id="ui">
<div id="topbar">
<div class="res"><div class="res-icon sprite-icon icon-food"></div><span class="res-vils" id="rv-food"></span><div class="res-val" id="r-food">200</div></div>
<div class="res"><div class="res-icon sprite-icon icon-wood"></div><span class="res-vils" id="rv-wood"></span><div class="res-val" id="r-wood">200</div></div>
<div class="res"><div class="res-icon sprite-icon icon-gold"></div><span class="res-vils" id="rv-gold"></span><div class="res-val" id="r-gold">100</div></div>
<div class="res"><div class="res-icon sprite-icon icon-stone"></div><span class="res-vils" id="rv-stone"></span><div class="res-val" id="r-stone">200</div></div>
<div class="res pop-res"><div class="res-icon sprite-icon icon-pop" aria-hidden="true"></div><div class="res-val" id="r-pop">4/10</div></div>
<div class="res age-res"><div class="res-icon sprite-icon icon-age-dark" aria-hidden="true"></div><div class="res-val" id="r-age">Dark</div></div>
<div id="net-stats" style="display:none;"></div>
</div>
</div>
<div id="pop-wrap">
  <div id="chat-btn" onclick="openChatInput()" style="display:none;" data-tip-label="Chat" data-tip-desc="Send a message to your opponent."><span class="btn-emoji">💬</span></div>
  <div id="idle-btn" style="display:none;" onclick="selectIdleVillager()"><span class="btn-emoji sprite-icon icon-idle"></span></div>
  <div id="bell-btn" style="display:none;" onclick="toggleTownBell()"><span class="btn-emoji sprite-icon icon-bell"></span></div>
  <div id="map-btn" onclick="toggleMinimap()" data-tip-label="Toggle Map" data-tip-desc="Show or hide the minimap."><span class="btn-emoji sprite-icon icon-map"></span></div>
  <div id="home-btn" onclick="focusTownCenter()" data-tip-label="Go to Town Center" data-tip-desc="Center the camera on your Town Center."><span class="btn-emoji sprite-icon icon-home"></span></div>
</div>
<div id="bottom">
<div id="actions"></div>
<div id="sel-info">
  <div id="sel-portrait" ondblclick="toggleCameraFollow()" title="Double-click to lock camera on this unit">⚔️</div>
  <!-- Classic-only HP readout slot, sits under the portrait (real AoE2
       placement). Mobile keeps HP inline in #sel-details and hides this. -->
  <div id="sel-hp"></div>
  <div id="sel-stats">
    <div id="sel-name">Age of Epochs II</div>
    <div id="sel-details">Tap to select, then tap map to command</div>
  </div>
  <div id="sel-grid"></div>
  <!-- Classic-only training-queue lane (real AoE2 shows the queue in the
       center panel). Mobile shows queue state on the train button badge
       instead and keeps this hidden. -->
  <div id="sel-queue"></div>
</div>
</div>
<div id="minimap-wrap"><canvas id="minimap"></canvas></div>
<div id="menu-btn" onclick="toggleMenu()" data-tip-label="Menu" data-tip-desc="Pause the game and open settings."><span class="btn-emoji">☰</span></div>
<div id="fs-btn" onclick="toggleFullscreen()" data-tip-label="Fullscreen" data-tip-desc="Enter or exit fullscreen mode."><span class="btn-emoji">⛶</span></div>
<div id="msg"></div>
<div id="chat-log"></div>
<div id="chat-input-wrap" style="display:none;">
  <span id="chat-input-prefix">To opponent:</span>
  <input id="chat-input" type="text" maxlength="200" autocomplete="off" spellcheck="false">
</div>
<!-- Standalone "See Map" button under the canvas VICTORY/DEFEAT banner. Shown
     on game over (js/init.js gameLoop); dismisses the banner to reveal the map.
     No menu is opened over the result. -->
<button type="button" id="see-map-btn" class="menu-action-btn" style="display:none;" onclick="seeMap()">🔍 See Map</button>
<div id="mp-disconnect-overlay" style="display:none;">
  <div id="mp-disconnect-box">
    <div id="mp-disconnect-title">Connection Lost</div>
    <div id="mp-disconnect-text"></div>
    <div id="mp-disconnect-spinner"></div>
    <button type="button" id="mp-disconnect-save" class="menu-action-btn" style="display:none;" onclick="saveGameToFile()">💾 Save Game</button>
    <button type="button" id="mp-disconnect-kick" class="menu-action-btn" style="display:none;" onclick="kickDisconnectedPlayers()">🤖 Continue without them (AI takes over)</button>
  </div>
</div>
<div id="help-hint"></div>
<div id="help-overlay" style="display:none;" onclick="if(event.target===this)toggleHelp()">
  <div id="help-box">
    <button type="button" id="help-close" onclick="toggleHelp()">✕</button>
    <h2>❓ How to Play</h2>

    <div class="help-section">
      <h4>🏆 Goal</h4>
      <p>Destroy the enemy <b>Town Center</b> 🏰 before they destroy yours! Your Town Center trains villagers and stores your resources — if it falls, you lose.</p>
    </div>

    <div class="help-section">
      <h4>🧑‍🌾 Gather Resources</h4>
      <div class="help-row"><span class="help-ico">🌲</span> Trees &rarr; <b>Wood</b> (build almost everything)</div>
      <div class="help-row"><span class="help-ico">🐑</span> Sheep &amp; <span class="help-ico">🍒</span> berries &amp; <span class="help-ico">🌾</span> farms &rarr; <b>Food</b> (train units)</div>
      <div class="help-row"><span class="help-ico">⛏️</span> Gold mines &rarr; <b>Gold</b> (soldiers)</div>
      <div class="help-row"><span class="help-ico">🪨</span> Stone &rarr; <b>Stone</b> (walls &amp; towers)</div>
      <p>Select a villager, then click a resource. Full hands? They walk it home automatically. Build a <b>Lumber Camp 🪓 / Mill 🛞 / Mining Camp ⛏️</b> next to resources so the walk is short. Farms run dry over time — a soft chime marks an exhausted 🌾 farm; reseed it (a little wood) to keep the food coming.</p>
    </div>

    <div class="help-section">
      <h4>🏗️ Build</h4>
      <div class="help-row"><span class="help-ico">🏠</span> House &mdash; +5 population. Build these or you can't train more units!</div>
      <div class="help-row"><span class="help-ico">⚔️</span> Barracks &mdash; trains your army</div>
      <div class="help-row"><span class="help-ico">🧱</span> Walls &amp; <span class="help-ico">🗼</span> Towers &mdash; keep raiders out (costs stone). Select a palisade or gate and tap <b>To Stone</b> to rebuild it tougher.</div>
      <div class="help-row"><span class="help-ico">🚪</span> Gates open automatically for your units &amp; allies. Select a gate and tap <b>🔒 Lock</b> to seal it shut &mdash; nothing passes, not even you &mdash; then <b>🔓 Unlock</b> to reopen. Handy for shutting a raider out of your wall.</div>
      <p>Select a villager &rarr; tap <b>Build Economic</b> or <b>Build Military</b> &rarr; pick a building &rarr; click the ground.</p>
    </div>

    <div class="help-section">
      <h4>🛡️ Army &amp; Counters</h4>
      <div class="help-row"><span class="help-ico">🔱</span> Spearman <b>beats</b> 🏇 Scout (big bonus damage)</div>
      <div class="help-row"><span class="help-ico">🏇</span> Scout <b>beats</b> 🏹 Archer (armor shrugs off arrows)</div>
      <div class="help-row"><span class="help-ico">🏹</span> Archer <b>beats</b> 🔱 Spearman (and all slow infantry)</div>
      <div class="help-row"><span class="help-ico">🛡️</span> Militia &mdash; solid all-rounder, good vs buildings</div>
      <p>Mix your army! One unit type alone gets countered.</p>
    </div>

    <div class="help-section">
      <h4>🔔 Defend Yourself</h4>
      <p>Attacked? Ring the <b>Town Bell 🔔</b> (bottom right) — villagers hide inside the Town Center and towers, which then shoot extra arrows. Ring again to send them back to work. Watch the minimap: anything of yours getting hit <b>blinks white</b>.</p>
    </div>

    <div class="help-section">
      <h4>🎮 Controls</h4>
      <div class="help-controls">
        <div class="help-controls-col">
          <div class="help-controls-title">🖱️ Desktop</div>
          ${DESKTOP_HELP_ROWS}
        </div>
        <div class="help-controls-col">
          <div class="help-controls-title">📱 Mobile</div>
          <div class="help-kv"><span class="help-k">Tap a unit</span><span class="help-v">select</span></div>
          <div class="help-kv"><span class="help-k">Tap the map</span><span class="help-v">do stuff</span></div>
          <div class="help-kv"><span class="help-k">Drag</span><span class="help-v">pan the camera</span></div>
          <div class="help-kv"><span class="help-k">Pinch</span><span class="help-v">zoom</span></div>
        </div>
      </div>
    </div>

    <div class="help-disclaimer">
      &ldquo;Age of Epochs II&rdquo; is a free, fan-made game inspired by classic
      real-time strategy titles. It is not an official product and is not affiliated
      with, endorsed by, or connected to Microsoft, Xbox Game Studios, Ensemble
      Studios, or the Age of Empires franchise.
    </div>
  </div>
</div>
<div id="tooltip" role="tooltip" aria-hidden="true"></div>

<div id="tutorial">
<div id="menu-scale-wrap">
<div id="tutorial-box">
<div class="menu-shell">
  <div class="menu-hero">
    <div class="title-pane">
      <img id="title-logo" src="logo.png" alt="Age of Epochs II">
    </div>
  </div>

  <div class="menu-content">
    <div class="menu-divider"></div>

    <!-- Two-level menu: #menu-panel-main holds the big actions; the
         settings grid lives in #menu-panel-options behind the Options
         button. showMenuPanel() (js/init.js) swaps them; the menu always
         opens on 'main'. -->
    <div id="menu-panel-options" style="display:none;">
    <div class="setup-grid">
      <div class="setup-row">
        <div class="setup-col">
          <h3>Difficulty</h3>
          <div class="segmented">
            <label class="segment"><input type="radio" name="difficulty" value="easy"><span title="Easy">E</span></label>
            <label class="segment"><input type="radio" name="difficulty" value="standard" checked><span title="Medium">M</span></label>
            <label class="segment"><input type="radio" name="difficulty" value="hard"><span title="Hard">H</span></label>
          </div>
        </div>
        <div class="setup-col">
          <h3>Players</h3>
          <div class="segmented">
            <label class="segment"><input type="radio" name="players" value="2" checked><span>1v1</span></label>
            <label class="segment"><input type="radio" name="players" value="4"><span>2v2</span></label>
          </div>
        </div>
        <div class="setup-col">
          <h3>Map Size</h3>
          <div class="segmented">
            <label class="segment"><input type="radio" name="mapsize" value="small"><span title="Small">S</span></label>
            <label class="segment"><input type="radio" name="mapsize" value="medium" checked><span title="Medium">M</span></label>
            <label class="segment"><input type="radio" name="mapsize" value="large"><span title="Large">L</span></label>
          </div>
        </div>
      </div>
      <div class="setup-row setup-row-audio">
        <div class="setup-col setup-col-speed">
          <h3>Speed</h3>
          <div class="segmented">
            <label class="segment"><input type="radio" name="gamespeed" value="1"><span>1</span></label>
            <label class="segment"><input type="radio" name="gamespeed" value="2" checked><span>2</span></label>
            <label class="segment"><input type="radio" name="gamespeed" value="4"><span>4</span></label>
          </div>
        </div>
        <div class="setup-col">
          <h3>Sound</h3>
          <div class="segmented">
            <label class="segment"><input type="radio" name="soundmode" value="all" checked><span>All</span></label>
            <label class="segment"><input type="radio" name="soundmode" value="alerts"><span>Alerts</span></label>
            <label class="segment"><input type="radio" name="soundmode" value="off"><span>Off</span></label>
          </div>
        </div>
        <div class="setup-col">
          <h3>Music</h3>
          <div class="segmented">
            <label class="segment"><input type="radio" name="music" value="on" checked><span>On</span></label>
            <label class="segment"><input type="radio" name="music" value="off"><span>Off</span></label>
          </div>
        </div>
      </div>
    </div>
      <div class="menu-button-container" id="options-back-row">
        <button type="button" id="options-back-btn" class="menu-action-btn" onclick="closeOptionsPanel()">⬅ Back</button>
      </div>
    </div>

    <div id="menu-panel-main">
    <div id="game-over-banner" style="display:none;">
      <div id="game-over-title"></div>
      <div id="game-over-sub"></div>
    </div>

    <div class="menu-button-container" id="start-row">
      <button type="button" id="resume-game-btn" class="menu-action-btn" onclick="toggleMenu()" style="display: none;">
        Resume
      </button>
      <button type="button" id="start-game-btn" class="menu-action-btn" onclick="handleStartButton()" disabled>
        Loading&hellip;
      </button>
      <!-- Lives here (next to Resume/Restart), not in #save-load-row, so
           the mid-game menu is one balanced row (Resume | Save | Help)
           instead of a wide Resume row with a small, off-center Save
           button stacked awkwardly underneath it. Hidden by default (no
           match exists on this pre-game screen) — see
           restoreMenuForMatch()/applyMenuMode('ingame') in js/init.js. -->
      <button type="button" id="save-game-btn" class="menu-action-btn" onclick="saveGameToFile()" style="display:none;">💾 Save</button>
    </div>
    <div class="menu-row-pair">
      <div class="menu-button-container" id="save-load-row">
        <button type="button" id="load-game-btn" class="menu-action-btn" onclick="triggerLoadDialog()">📂 Load Game</button>
      </div>
      <div class="menu-button-container" id="mp-row">
        <button type="button" id="host-game-btn" class="menu-action-btn" onclick="onHostClicked()">🌐 Host Multiplayer Game</button>
      </div>
    </div>
    <div class="menu-row-pair" id="misc-row">
      <div class="menu-button-container">
        <button type="button" id="options-btn" class="menu-action-btn" onclick="showMenuPanel('options')">⚙️ Options</button>
      </div>
      <div class="menu-button-container">
        <button type="button" id="help-btn" class="menu-action-btn" onclick="toggleHelp()">❓ Help</button>
      </div>
    </div>
    <input type="file" id="load-file-input" accept="application/json,.json" style="display:none" onchange="loadGameFromFile(this.files[0]); this.value='';">
    <!-- Shown once hosting starts (link + waiting-for-opponent status) or
         while a guest is auto-connecting from a ?join= link. Plain
         display:none/flex toggling, same pattern as #help-overlay. -->
    <div id="mp-status-panel" style="display:none;">
      <div id="mp-status-text"></div>
      <div id="mp-link-row" style="display:none;">
        <input type="text" id="mp-link-box" readonly onclick="this.select()">
        <button type="button" id="mp-copy-link-btn" class="menu-action-btn" onclick="copyMpLink()">Copy Link</button>
      </div>
      <div id="mp-qr" style="display:none;"></div>
      <div id="mp-share-note" style="display:none;">Share with up to 3 friends — everyone joins through this same link</div>
      <button type="button" id="mp-cancel-btn" class="menu-action-btn" style="display:none;" onclick="cancelHosting()">✖ Cancel</button>
      <button type="button" id="mp-retry-btn" class="menu-action-btn" style="display:none;" onclick="attemptGuestJoin()">↻ Retry Connection</button>
    </div>
    </div>

    <!-- Pre-match multiplayer lobby ("handshake"). Third sibling panel next to
         #menu-panel-main / #menu-panel-options, swapped in by showMenuPanel
         ('lobby'). All dynamic content (seat rows, color swatches) is built by
         js/lobby.js into the containers below; the settings segmented controls
         are host-interactive / guest-read-only. Reuses .setup-grid/.segmented/
         .menu-action-btn and the .chat-line log styling. -->
    <div id="menu-panel-lobby" style="display:none;">
      <div id="lobby-heading" class="menu-divider"></div>
      <div id="lobby-roster"></div>
      <!-- The invite link stays available inside the lobby while seats
           remain (renderLobby toggles it) — more friends can join pre-Start. -->
      <div id="lobby-invite-row" style="display:none;">Invite: <input type="text" id="lobby-invite-link" readonly onclick="this.select()"></div>
      <div class="lobby-addai-row" id="lobby-addai-row">
        <button type="button" id="lobby-addai-btn" class="menu-action-btn" onclick="lobbyAddAi()">＋ Add AI</button>
        <div class="segmented" id="lobby-aidiff-seg">
          <label class="segment"><input type="radio" name="lobbyaidiff" value="easy"><span title="Easy">E</span></label>
          <label class="segment"><input type="radio" name="lobbyaidiff" value="standard" checked><span title="Medium">M</span></label>
          <label class="segment"><input type="radio" name="lobbyaidiff" value="hard"><span title="Hard">H</span></label>
        </div>
      </div>
      <div class="setup-grid" id="lobby-settings-grid">
        <div class="setup-row">
          <div class="setup-col">
            <h3>Map Size</h3>
            <div class="segmented" id="lobby-mapsize-seg">
              <label class="segment"><input type="radio" name="lobbymapsize" value="small"><span title="Small">S</span></label>
              <label class="segment"><input type="radio" name="lobbymapsize" value="medium" checked><span title="Medium">M</span></label>
              <label class="segment"><input type="radio" name="lobbymapsize" value="large"><span title="Large">L</span></label>
            </div>
          </div>
          <div class="setup-col">
            <h3>Speed</h3>
            <div class="segmented" id="lobby-speed-seg">
              <label class="segment"><input type="radio" name="lobbyspeed" value="1"><span>1</span></label>
              <label class="segment"><input type="radio" name="lobbyspeed" value="2" checked><span>2</span></label>
              <label class="segment"><input type="radio" name="lobbyspeed" value="4"><span>4</span></label>
            </div>
          </div>
        </div>
      </div>
      <div id="lobby-chat-log"></div>
      <div id="lobby-chat-input-wrap">
        <input id="lobby-chat-input" type="text" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Type a message…">
      </div>
      <div id="lobby-hint" class="lobby-hint" style="display:none;"></div>
      <div class="menu-button-container">
        <button type="button" id="lobby-ready-btn" class="menu-action-btn" style="display:none;" onclick="onLobbyReadyClicked()">✔ Ready</button>
        <button type="button" id="lobby-start-btn" class="menu-action-btn" style="display:none;" onclick="onLobbyStartClicked()" disabled>Start Match</button>
        <button type="button" id="lobby-leave-btn" class="menu-action-btn" onclick="onLobbyLeaveClicked()">✖ Leave Lobby</button>
      </div>
    </div>
  </div>
</div>
</div>
<div id="ui-switch-row"><a id="ui-switch-link" href="#">${SWITCH_LABEL}</a></div>
</div>
</div>
`);
})();
