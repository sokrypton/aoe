// Shared page markup for BOTH index.html (mobile skin) and classic.html.

// ---- Tiny DOM helpers (page-shell loads first, so every file can use them) ----
// THE show/hide idiom: null-safe, '' restores the stylesheet's display.
function byId(id){ return document.getElementById(id); }
function show(idOrEl, visible, mode){
  let el = typeof idOrEl === 'string' ? byId(idOrEl) : idOrEl;
  if (el) el.style.display = visible ? (mode || '') : 'none';
}
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
  // A sheep carcass is a pile of food, so its HUD icon reuses the food (raw
  // meat) resource cell [3,4] rather than getting its own drawn cell.
  sheep_carcass:[3,4],
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
  // ---- unit stance glyphs (HUD stance buttons, js/ui.js): the four cells
  // right after the home buttons, in AoE2 order. The generated .icon-stance-*
  // CSS + shared sprite-icon class cover both skins.
  'stance-aggressive':[3,7], 'stance-defensive':[4,7],
  'stance-standground':[5,7], 'stance-passive':[6,7],
  // ---- garrison in/out glyphs (gate + directional arrow): load into / release
  // from a container (ram Garrison / Ungarrison buttons, js/ui.js).
  'garrison-in':[7,4], 'garrison-out':[7,7],
  // ---- rows 8-10 (sheet grown 8x8 -> 8x10 -> 8x11): the research/tech icons as
  // FULL cells (`up-<techkey>`), grouped by host building (keep in sync with
  // expand-sprites.py + BLDGS.researches). Shown as .research-tile icons — on the
  // parchment scroll (mobile) or plain command buttons (classic). Row 9 cols 6-7
  // hold the scroll roll caps (scroll-roll, scroll-roll-h); rows 8-9 filled up, so
  // Bodkin Arrow opens row 10 (cols 3-7 spare — draw there before growing again).
  'up-forging':[0,8], 'up-iron_casting':[1,8], 'up-scale_armor':[2,8], 'up-chain_mail':[3,8],
  'up-fletching':[4,8], 'up-masonry':[5,8], 'up-fortified_wall':[6,8], 'up-horse_collar':[7,8],
  'up-heavy_plow':[0,9], 'up-double_bit_axe':[1,9], 'up-bow_saw':[2,9], 'up-gold_mining':[3,9],
  'up-guilds':[4,9], 'up-wheelbarrow':[5,9], 'up-bodkin_arrow':[0,10], 'up-ballistics':[1,10],
  // the map's dragon (gaia): its 2D art rendered into the cell (drawDragonBody)
  dragon:[2,10],
  // research SCROLL roll caps (baked from scroll-ui.png): a vertical-cylinder roll
  // for the horizontal bottom-bar band (L/R caps, right one mirrored), and the
  // same roll rotated 90° for the vertical rail band (top/bottom caps). The paper
  // between them is a plain CSS gradient (matches the sprite's rgb 240,223,197),
  // so no paper cell is needed. Replaces the standalone scroll PNGs.
  'scroll-roll':[6,9], 'scroll-roll-h':[7,9],
};
// Sheet grid: 8 columns x 11 rows of 256px cells. background-size scales the
// sheet so one cell fills the element, so position is a fraction col/(COLS-1),
// row/(ROWS-1) — i.e. EVERY cell's position shifts when a row is added.
// Growing the sheet must therefore change nothing but these two numbers, so the
// derived values are published as custom properties: --sprite-bg-size plus one
// --cell-<key> per cell. CSS that can't carry an .icon-<key> class (::before /
// ::after, e.g. the research scroll's roll caps) uses var(--cell-<key>) and
// never a literal percentage.
const SHEET_COLS = 8, SHEET_ROWS = 11;
(function(){
  let vars = `--sprite-bg-size:${SHEET_COLS * 100}% ${SHEET_ROWS * 100}%;`, rules = '';
  for (const k in SPRITE_CELLS) {
    const cell = SPRITE_CELLS[k];
    const pos = `${(cell[0]/(SHEET_COLS-1)*100).toFixed(4)}% ${(cell[1]/(SHEET_ROWS-1)*100).toFixed(4)}%`;
    vars += `--cell-${k}:${pos};`;
    rules += `.icon-${k}{background-position:${pos};}\n`;
  }
  const st = document.createElement('style');
  st.id = 'sprite-cells';
  st.textContent = `:root{${vars}}\n${rules}`;
  document.head.appendChild(st);
})();

(function(){
const variant = window.UI_VARIANT || 'mobile';

const SWITCH_LABEL = variant === 'classic' ? 'Switch to Mobile UI' : 'Switch to Classic UI';

// Legal + provenance line shown under the main menu (the dark backdrop).
// ---- Menu icons: small ink-line drawings (the art's outline style), one set for every menu/overlay button ----
// (emoji read as generic and render differently per platform). menuIcon(name) -> inline SVG; lobby.js uses it too.
const MENU_ICONS = {
  load:    '<path d="M6 4h10a2 2 0 0 1 2 2v13H8a2 2 0 0 1-2-2z"/><path d="M6 17a2 2 0 0 0 2 2"/><path d="M9.5 9h5M9.5 12.5h5"/>',   // a scroll
  host:    '<path d="M5 21 15 3"/><path d="M19 21 9 3"/><path d="M15 3l4 2-3 2"/><path d="M9 3 5 5l3 2"/>',                       // crossed banners
  save:    '<rect x="4" y="9" width="16" height="10" rx="1"/><path d="M4 9a8 4 0 0 1 16 0"/><path d="M12 12v3"/>',               // a chest
  options: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  help:    '<path d="M4 5.5A2 2 0 0 1 6 4h5v15H6a2 2 0 0 0-2 1.5z"/><path d="M20 5.5A2 2 0 0 0 18 4h-5v15h5a2 2 0 0 1 2 1.5z"/>',  // a book
  back:    '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close:   '<path d="M6 6l12 12M18 6 6 18"/>',
  retry:   '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  check:   '<path d="M5 12.5l4.5 4.5L19 7"/>',
  plus:    '<path d="M12 5v14M5 12h14"/>',
  map:     '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  ai:      '<rect x="5" y="8" width="14" height="11" rx="2"/><path d="M12 4v4M9.5 13h0M14.5 13h0"/>',
  learn:   '<path d="M6 21V4"/><path d="M6 4.5h11l-2.2 4 2.2 4H6"/>',                                                           // a marker flag
  editor:  '<path d="M14.5 5.5l4 4"/><path d="M4 20l9.5-9.5"/><path d="M12 4l8 8-3 3-8-8z"/>',
};
function menuIcon(name){
  return '<svg class="mi" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + MENU_ICONS[name] + '</svg>';
}
window.menuIcon = menuIcon;   // (lobby.js draws its buttons with it too: this file's body is a closure)

// A game sprite inline in the help text (the sheet's own icons: js/page-shell.js SPRITE_CELLS)
function hi(key){ return '<span class="help-ico sprite-icon icon-' + key + '" aria-hidden="true"></span>'; }

const DISCLAIMER_HTML = `A free, open-source fan game — not affiliated with Microsoft, Xbox Game
  Studios, Ensemble Studios, or the Age of Empires franchise. Feedback welcome via
  <a href="https://github.com/sokrypton/aoe" target="_blank" rel="noopener">GitHub</a>.`;

// Desktop controls differ per skin: classic keeps the AoE2 left-select /
// right-command contract; the mobile skin uses the TAP model on desktop
// too (a left-click selects OR commands by context — see the mouseup
// dispatch in js/input.js).
const DESKTOP_HELP_ROWS = variant === 'classic'
  ? `<div class="help-kv"><span class="help-k">Left-click</span><span class="help-v">select units</span></div>
     <div class="help-kv"><span class="help-k">Right-click</span><span class="help-v">command selected units</span></div>
     <div class="help-kv"><span class="help-k">Scroll wheel</span><span class="help-v">zoom</span></div>
     <div class="help-kv"><span class="help-k">Arrow keys</span><span class="help-v">pan the camera</span></div>`
  : `<div class="help-kv"><span class="help-k">Click</span><span class="help-v">select, or command selected units</span></div>
     <div class="help-kv"><span class="help-k">Shift-click</span><span class="help-v">add/remove a unit</span></div>
     <div class="help-kv"><span class="help-k">Drag</span><span class="help-v">box-select</span></div>
     <div class="help-kv"><span class="help-k">Right-click</span><span class="help-v">also commands</span></div>
     <div class="help-kv"><span class="help-k">Scroll wheel</span><span class="help-v">zoom</span></div>
     <div class="help-kv"><span class="help-k">Arrow keys / two-finger swipe</span><span class="help-v">pan the camera</span></div>`;

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
  <div id="eye-btn" style="display:none;" onclick="eyeBtnClick()"></div>
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
    <div id="sel-name">Age of Epochs</div>
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
<!-- VICTORY/DEFEAT end screen: DOM, not canvas, so it also shows over the 3D
     world view. "See Map" dismisses it to reveal the map (js/init.js seeMap). -->
<div id="game-over-screen" style="display:none;"><div id="game-over-band">
  <div id="game-over-word"></div><div id="game-over-line"></div>
</div></div>
<button type="button" id="see-map-btn" class="menu-action-btn" style="display:none;" onclick="seeMap()">${menuIcon('map')}See Map</button>
<button type="button" id="scn-end-btn" class="menu-action-btn" style="display:none;" onclick="scenarioEndButton()"></button>
<!-- Scenario instructions + objectives (js/scenario-ui.js); hidden outside scenarios. -->
<div id="scn-card" style="display:none;">
  <button type="button" id="scn-head" onclick="toggleScenarioCard()"><span id="scn-title"></span><span id="scn-count"></span><span id="scn-chev"></span></button>
  <div id="scn-body">
    <div id="scn-text"></div>
    <ul id="scn-goals"></ul>
  </div>
</div>
<div id="mp-disconnect-overlay" style="display:none;">
  <div id="mp-disconnect-box">
    <div id="mp-disconnect-title">Connection Lost</div>
    <div id="mp-disconnect-text"></div>
    <div id="mp-disconnect-spinner"></div>
    <button type="button" id="mp-disconnect-save" class="menu-action-btn" style="display:none;" onclick="saveGameToFile()">${menuIcon('save')}Save Game</button>
    <button type="button" id="mp-disconnect-kick" class="menu-action-btn" style="display:none;" onclick="kickDisconnectedPlayers()">${menuIcon('ai')}Continue without them (AI takes over)</button>
  </div>
</div>
<div id="mp-seat-picker" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.72);align-items:center;justify-content:center;">
  <div id="mp-seat-picker-box" style="background:#2b2b2b;border:2px solid #555;border-radius:8px;padding:22px 26px;max-width:90vw;text-align:center;color:#eee;">
    <div id="mp-seat-picker-title" style="font-size:20px;font-weight:bold;margin-bottom:6px;">Rejoin the match</div>
    <div id="mp-seat-picker-text" style="opacity:0.8;margin-bottom:14px;">Pick your player to reconnect:</div>
    <div id="mp-seat-picker-list" style="display:flex;flex-direction:column;gap:8px;"></div>
  </div>
</div>
<div id="help-hint"></div>
<div id="help-overlay" style="display:none;" onclick="if(event.target===this)toggleHelp()">
  <div id="help-box">
    <button type="button" id="help-close" onclick="toggleHelp()" aria-label="Close">${menuIcon('close')}</button>
    <h2>How to Play</h2>

    <div class="help-section">
      <h4>Goal</h4>
      <p>Destroy the enemy <b>Town Center</b> ${hi('TC-dark')} before they destroy yours. It trains villagers, takes in resources and advances your ages, and it can't be rebuilt: if it falls, you lose. In team games your side is out once every one of its Town Centers has fallen.</p>
    </div>

    <div class="help-section">
      <h4>Gather Resources</h4>
      <div class="help-row">${hi('wood')}<span>Trees &rarr; <b>Wood</b> (buildings, archers, rams)</span></div>
      <div class="help-row">${hi('food')}<span>Sheep, berries &amp; farms &rarr; <b>Food</b> (villagers, soldiers, ages)</span></div>
      <div class="help-row">${hi('gold')}<span>Gold mines &rarr; <b>Gold</b> (soldiers, the Castle Age)</span></div>
      <div class="help-row">${hi('stone')}<span>Stone &rarr; <b>Stone</b> (stone walls and towers)</span></div>
      <p>Select a villager, then tap a resource; with full hands they walk it home on their own. Put a <b>Lumber Camp</b> ${hi('LCAMP')}, <b>Mill</b> ${hi('MILL')} or <b>Mining Camp</b> ${hi('MCAMP')} next to the resource to shorten the walk. Farms ${hi('FARM')} run out: a chime marks an exhausted farm, which you reseed for a little wood (or prepay reseeds at the Mill).</p>
    </div>

    <div class="help-section">
      <h4>Build</h4>
      <div class="help-row">${hi('HOUSE')}<span>House &mdash; +5 population. Build these or you can't train more units!</span></div>
      <div class="help-row">${hi('BARRACKS')}<span>Barracks &mdash; trains soldiers and researches weapons, armor and wall upgrades</span></div>
      <div class="help-row">${hi('WALL')}<span>Walls &amp; ${hi('PTOWER')} towers &mdash; keep raiders out. Palisades and wooden towers cost wood; from the Feudal Age, select one and tap <b>To Stone</b> or <b>To Tower</b> to rebuild it in stone.</span></div>
      <div class="help-row">${hi('GATE')}<span>Gates open for your units and allies. Select a gate and tap <b>Lock</b> to seal it (nothing passes, not even you), then <b>Unlock</b> to reopen.</span></div>
      <p>Select a villager &rarr; tap <b>Build Economic</b> or <b>Build Military</b> &rarr; pick a building &rarr; tap the ground.</p>
    </div>

    <div class="help-section">
      <h4>Advance Through the Ages</h4>
      <p>You start in the <b>Dark Age</b> and advance at your <b>Town Center</b>. The <b>Feudal Age</b> (500 food) unlocks spearmen, archers, scouts, watch towers, stone walls and the Market; the <b>Castle Age</b> (800 food, 200 gold) unlocks knights and rams.</p>
      <p>Each age also opens technologies, researched at the building they belong to: farming at the Mill, wood-cutting at the Lumber Camp, mining at the Mining Camp, the Wheelbarrow at the Town Center, and weapons, armor and walls at the Barracks.</p>
    </div>

    <div class="help-section">
      <h4>Market &amp; Trade</h4>
      <p>Build a <b>Market</b> ${hi('MARKET')} (Feudal Age) to buy and sell resources for gold &mdash; prices move as everyone trades &mdash; or send <b>Trade Carts</b> ${hi('tradecart')} to another player's Market for a steady income of <b>gold</b>. The farther away that Market, the more each trip earns.</p>
    </div>

    <div class="help-section">
      <h4>Army &amp; Counters</h4>
      <div class="help-row">${hi('spearman')}<span>Spearman <b>beats</b> ${hi('scout')} scouts &amp; ${hi('knight')} knights (big bonus damage against cavalry)</span></div>
      <div class="help-row">${hi('scout')}<span>Scout <b>beats</b> ${hi('archer')} archers (its armor shrugs off arrows)</span></div>
      <div class="help-row">${hi('archer')}<span>Archer <b>beats</b> ${hi('spearman')} spearmen and other slow infantry</span></div>
      <div class="help-row">${hi('knight')}<span>Knight &mdash; strong, fast cavalry (Castle Age); watch out for spearmen</span></div>
      <div class="help-row">${hi('militia')}<span>Militia &mdash; a solid all-rounder, with bonus damage against buildings</span></div>
      <div class="help-row">${hi('ram')}<span>Ram &mdash; smashes buildings and walls and shrugs off arrows, but is helpless in melee (Castle Age). Foot soldiers can ride inside: select them and tap your ram.</span></div>
      <p>Mix your army! One unit type alone gets countered.</p>
    </div>

    <div class="help-section">
      <h4>Defend Yourself</h4>
      <p>Attacked? Ring the <b>Town Bell</b> ${hi('bell')} (the buttons at the bottom right): villagers hurry into the Town Center and towers, which then shoot extra arrows. Ring it again to send them back to work. On the minimap, anything of yours under attack <b>blinks white</b>.</p>
    </div>

    <div class="help-section">
      <h4>Play Your Way</h4>
      <p><b>Character mode:</b> select a unit and tap the eye button to follow it in 3D from right behind it, and steer it yourself. <b>Options &rarr; Town AI</b> hands your town (economy, building, army) to the AI while you play, and <b>Options &rarr; View</b> switches between the 2D map and the 3D world at any time.</p>
    </div>

    <div class="help-section">
      <h4>Controls</h4>
      <div class="help-controls">
        <div class="help-controls-col">
          <div class="help-controls-title">Desktop</div>
          ${DESKTOP_HELP_ROWS}
        </div>
        <div class="help-controls-col">
          <div class="help-controls-title">Mobile</div>
          <div class="help-kv"><span class="help-k">Tap a unit</span><span class="help-v">select</span></div>
          <div class="help-kv"><span class="help-k">Tap the map</span><span class="help-v">move, gather or attack with what's selected</span></div>
          <div class="help-kv"><span class="help-k">Drag</span><span class="help-v">pan the camera</span></div>
          <div class="help-kv"><span class="help-k">Pinch</span><span class="help-v">zoom</span></div>
        </div>
      </div>
    </div>

    <div class="help-section">
      <h4>Play with Friends</h4>
      <p>From the main menu, <b>Host</b> a game and share the link (or QR code) &mdash; up to <b>4 players</b>, in any mix of humans and AI. Drop out and reconnect any time; the match pauses and you rejoin your spot.</p>
    </div>

    <div class="help-section">
      <h4>Thanks</h4>
      <p>Beta testers who shaped the game with their feedback: <b>Jeremy Ilagan</b>, <b>Orr Ashenberg</b>, <b>Jordan Hoff</b>, and <b>Qing Feng</b>.</p>
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
      <img id="title-logo" src="logo.png" alt="Age of Epochs">
    </div>
  </div>

  <div class="menu-content">
    <div class="menu-divider"></div>

    <!-- Two-level menu: #menu-panel-main holds the big actions; the
         settings grid lives in #menu-panel-options behind the Options
         button. showMenuPanel() (js/init.js) swaps them; the menu always
         opens on 'main'. -->
    <div id="menu-panel-options" style="display:none;">
    <!-- Every setting a pill group over the radios the code reads. #opt-match is pre-match only,
         Town AI in-match only, and the View/Town AI pair act the moment they're clicked (js/init.js). -->
    <div class="setup-grid" id="opt-groups">
      <div class="setup-row" id="opt-match">
        <div class="setup-col">
          <h3>Difficulty</h3>
          <div class="opt-pills"><label class="opt-pill"><input type="radio" name="difficulty" value="easy"><span title="Easy">E</span></label><label class="opt-pill"><input type="radio" name="difficulty" value="standard" checked><span title="Medium">M</span></label><label class="opt-pill"><input type="radio" name="difficulty" value="hard"><span title="Hard">H</span></label></div>
        </div>
        <div class="setup-col">
          <h3>Players</h3>
          <div class="opt-pills"><label class="opt-pill"><input type="radio" name="players" value="2" checked><span>1v1</span></label><label class="opt-pill"><input type="radio" name="players" value="4"><span>2v2</span></label></div>
        </div>
        <div class="setup-col">
          <h3>Map Size</h3>
          <div class="opt-pills"><label class="opt-pill"><input type="radio" name="mapsize" value="small"><span title="Small">S</span></label><label class="opt-pill"><input type="radio" name="mapsize" value="medium" checked><span title="Medium">M</span></label><label class="opt-pill"><input type="radio" name="mapsize" value="large"><span title="Large">L</span></label></div>
        </div>
        <div class="setup-col" title="Fog of war. Off: the whole map is revealed for everyone, the AI included">
          <h3>Fog</h3>
          <div class="opt-pills"><label class="opt-pill"><input type="radio" name="fogmode" value="fog" checked><span>On</span></label><label class="opt-pill"><input type="radio" name="fogmode" value="open"><span>Off</span></label></div>
        </div>
      </div>
      <div class="setup-row setup-row-audio">
        <div class="setup-col setup-col-speed" id="opt-speed-row">
          <h3>Speed</h3>
          <div class="opt-pills"><label class="opt-pill"><input type="radio" name="gamespeed" value="1"><span>1×</span></label><label class="opt-pill"><input type="radio" name="gamespeed" value="2" checked><span>2×</span></label><label class="opt-pill"><input type="radio" name="gamespeed" value="4"><span>4×</span></label></div>
        </div>
        <div class="setup-col setup-col-wide">
          <h3>Sound</h3>
          <div class="opt-pills"><label class="opt-pill"><input type="radio" name="soundmode" value="all" checked><span>All</span></label><label class="opt-pill"><input type="radio" name="soundmode" value="alerts"><span>Alerts</span></label><label class="opt-pill"><input type="radio" name="soundmode" value="off"><span>Off</span></label></div>
        </div>
        <div class="setup-col">
          <h3>Music</h3>
          <div class="opt-pills"><label class="opt-pill"><input type="radio" name="music" value="on" checked><span>On</span></label><label class="opt-pill"><input type="radio" name="music" value="off"><span>Off</span></label></div>
        </div>
      </div>
      <div class="setup-row setup-row-view">
        <div class="setup-col" id="view-col">
          <h3>View</h3>
          <div class="opt-pills"><label class="opt-pill"><input type="radio" name="viewmode" value="2d" onchange="setViewMode('2d')"><span title="The 2D map">2D</span></label><label class="opt-pill"><input type="radio" name="viewmode" value="3d" onchange="setViewMode('3d')"><span title="The 3D world view">3D</span></label></div>
        </div>
        <div class="setup-col" id="townai-col" title="The AI runs your town (economy, building, army) while you play a character">
          <h3>Town AI</h3>
          <div class="opt-pills"><label class="opt-pill"><input type="radio" name="townai" value="on" onchange="setTownAI(true)"><span>On</span></label><label class="opt-pill"><input type="radio" name="townai" value="off" checked onchange="setTownAI(false)"><span>Off</span></label></div>
        </div>
      </div>
    </div>
      <div class="menu-button-container" id="options-back-row">
        <button type="button" id="options-back-btn" class="menu-action-btn" onclick="closeOptionsPanel()">${menuIcon('back')}Back</button>
      </div>
    </div>

    <!-- Learn to Play: the tutorial lessons (js/scenario-ui.js fills #learn-list). -->
    <div id="menu-panel-learn" style="display:none;">
      <div class="learn-heading">Learn to Play</div>
      <div id="learn-list"></div>
      <div class="menu-button-container">
        <button type="button" class="menu-action-btn learn-back" onclick="showMenuPanel('main')">${menuIcon('back')}Back</button>
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
      <button type="button" id="save-game-btn" class="menu-action-btn" onclick="saveGameToFile()" style="display:none;">${menuIcon('save')}Save</button>
      <button type="button" id="learn-btn" class="menu-action-btn" onclick="showMenuPanel('learn')">${menuIcon('learn')}Learn to Play</button>
    </div>
    <div class="menu-row-pair">
      <div class="menu-button-container" id="save-load-row">
        <button type="button" id="load-game-btn" class="menu-action-btn" onclick="triggerLoadDialog()">${menuIcon('load')}Load Game</button>
        <!-- Scenario Editor link hidden for now (editor.html still works by direct
             URL); flip the display back on to re-expose it in the menu. -->
        <button type="button" id="editor-btn" class="menu-action-btn" onclick="location.href='editor.html'" style="display:none;">${menuIcon('editor')}Scenario Editor</button>
      </div>
      <div class="menu-button-container" id="mp-row">
        <button type="button" id="host-game-btn" class="menu-action-btn" onclick="onHostClicked()">${menuIcon('host')}Host Multiplayer</button>
      </div>
    </div>
    <div class="menu-row-pair" id="misc-row">
      <div class="menu-button-container">
        <button type="button" id="options-btn" class="menu-action-btn" onclick="showMenuPanel('options')">${menuIcon('options')}Options</button>
      </div>
      <div class="menu-button-container">
        <button type="button" id="help-btn" class="menu-action-btn" onclick="toggleHelp()">${menuIcon('help')}Help</button>
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
      <button type="button" id="mp-cancel-btn" class="menu-action-btn" style="display:none;" onclick="cancelHosting()">${menuIcon('close')}Cancel</button>
      <button type="button" id="mp-retry-btn" class="menu-action-btn" style="display:none;" onclick="attemptGuestJoin()">${menuIcon('retry')}Retry Connection</button>
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
        <button type="button" id="lobby-addai-btn" class="menu-action-btn" onclick="lobbyAddAi()">${menuIcon('plus')}Add AI</button>
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
          <div class="setup-col">
            <h3>Map</h3>
            <div class="segmented" id="lobby-fog-seg">
              <label class="segment"><input type="radio" name="lobbyfog" value="fog" checked><span title="Fog of War">Fog</span></label>
              <label class="segment"><input type="radio" name="lobbyfog" value="open"><span title="All Visible — whole map revealed for every player and AI">Open</span></label>
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
        <button type="button" id="lobby-ready-btn" class="menu-action-btn" style="display:none;" onclick="onLobbyReadyClicked()">${menuIcon('check')}Ready</button>
        <button type="button" id="lobby-start-btn" class="menu-action-btn" style="display:none;" onclick="onLobbyStartClicked()" disabled>Start Match</button>
        <button type="button" id="lobby-leave-btn" class="menu-action-btn" onclick="onLobbyLeaveClicked()">${menuIcon('close')}Leave Lobby</button>
      </div>
    </div>
  </div>
</div>
</div>
<div id="ui-switch-row"><a id="ui-switch-link" href="#">${SWITCH_LABEL}</a></div>
<div id="menu-disclaimer">${DISCLAIMER_HTML}</div>
</div>
</div>
`);
})();
