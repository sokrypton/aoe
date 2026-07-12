// Sprite sheet (sprites.png) covers most BLDGS/UNITS keys directly (class
// names match btype/utype: icon-HOUSE, icon-villager, etc). Age-variant
// buildings/units instead have age-suffixed cells (icon-TC-castle,
// icon-WT-feudal, icon-militia-feudal…) and are always looked up through
// iconKey()+AGE_ICON_VARIANTS — there is no bare icon-TC/icon-TOWER cell.
// Anything with no cell (no selection, cancel-only actions) falls back to
// the emoji glyph. Derived from the ONE cell registry (SPRITE_CELLS,
// js/page-shell.js) — naming a new cell there is the only step; this set
// follows.
const SPRITE_ICON_KEYS = new Set(Object.keys(window.SPRITE_CELLS));

// Market trade cell metadata shared by both skins' exchange UIs: tooltip
// text, affordability cost and the submit handler for one buy/sell cell.
// Transactions run in execMarketTrade (deterministic, js/commands.js).
function wireMktCell(cell, dir, res){
  let price=marketPrices[res];
  let gold=dir==='buy'?price:Math.floor(price*MARKET_SELL_RATIO/100);
  let resLabel=res.charAt(0).toUpperCase()+res.slice(1);
  cell.dataset.tipType='action';
  cell.dataset.tipLabel=(dir==='buy'?'Buy 100 ':'Sell 100 ')+resLabel;
  cell.dataset.tipDesc=dir==='buy'
    ?('Spend '+price+' gold to receive 100 '+resLabel+'. Buying raises its price.')
    :('Sell 100 '+resLabel+' for '+gold+' gold. Selling lowers its price.');
  // Feeds refreshActionAffordability: buying costs gold, selling costs a
  // full lot of the resource (same cost-key letters as BLDGS/UNITS costs).
  cell.dataset.cost=JSON.stringify(dir==='buy'?{g:price}:{[res[0]]:MARKET_LOT});
  cell.onclick=()=>{
    if(gameOver)return;
    if(cell.classList.contains('disabled')){
      showMsg('Not enough resources!');
      if(window.playSound)playSound('error');
      return;
    }
    submitCommand({kind:'market-trade',dir,resType:res});
  };
  return gold;
}

// CLASSIC skin's exchange: AoE2-style rows of real 52px command buttons in
// the grid — [Buy][food][wood][stone] / [Sell][food][wood][stone], the
// live gold price printed on each button.
function appendMktGridRows(act){
  ['buy','sell'].forEach(dir=>{
    let row=document.createElement('div');
    row.className='mkt-grid-row';
    let lab=document.createElement('div');
    lab.className='mkt-lab';
    lab.textContent=dir==='buy'?'Buy':'Sell';
    row.appendChild(lab);
    ['food','wood','stone'].forEach(res=>{
      let cell=document.createElement('div');
      cell.className='act-btn mkt-btn mkt-cell';
      let gold=wireMktCell(cell, dir, res);
      cell.innerHTML=`<div class="btn-emoji sprite-icon icon-${res}"></div>`
        +`<div class="mkt-btn-price">${gold}</div>`;
      row.appendChild(cell);
    });
    act.appendChild(row);
  });
}

// MOBILE popup's exchange widget (two labeled rows of compact cells with
// the price beside each icon) — see refreshMktPopup.
function buildMktExchange(){
  const RES=['food','wood','stone'];
  let wrap=document.createElement('div');wrap.className='mkt-exchange';
  const makeRow=(dir)=>{
    let row=document.createElement('div');row.className='mkt-row';
    let lab=document.createElement('div');lab.className='mkt-row-label';
    lab.textContent=dir==='buy'?'Buy':'Sell';
    row.appendChild(lab);
    RES.forEach(res=>{
      let cell=document.createElement('div');cell.className='mkt-cell';
      let gold=wireMktCell(cell, dir, res);
      cell.innerHTML=`<div class="mkt-ico sprite-icon icon-${res}"></div>`
        +`<div class="mkt-price">${gold}</div>`;
      row.appendChild(cell);
    });
    return row;
  };
  wrap.appendChild(makeRow('buy'));
  wrap.appendChild(makeRow('sell'));
  return wrap;
}

// Mobile-skin Market POPUP: a dismissible card over the battlefield (the
// inline exchange filled the whole landscape rail). Auto-opens when a
// Market is selected, ✕ hides it for that selection, the strip's Trade
// button toggles it back. Pass null to hide (selection changed/game over);
// the hidden flag resets then so the next Market selection opens fresh.
function refreshMktPopup(mkt){
  let pop=document.getElementById('mkt-popup');
  if(!mkt){
    window.__mktPopupHidden=false;
    if(pop)pop.style.display='none';
    return;
  }
  if(window.__mktPopupHidden){ if(pop)pop.style.display='none'; return; }
  if(!pop){
    pop=document.createElement('div');
    pop.id='mkt-popup';
    document.body.appendChild(pop);
  }
  pop.style.display='';
  pop.innerHTML=`<div id="mkt-popup-head"><span class="sprite-icon icon-MARKET" id="mkt-popup-ico"></span><span>Market</span><button type="button" id="mkt-popup-x">✕</button></div>`;
  pop.querySelector('#mkt-popup-x').onclick=()=>{ window.__mktPopupHidden=true; pop.style.display='none'; };
  pop.appendChild(buildMktExchange());
  refreshActionAffordability();
}

// Re-tapping an already-SELECTED Market reopens a dismissed exchange popup
// — clicking the building again is the natural "show me the trade screen"
// gesture, and since the selection doesn't change, no rebuild fires to do
// it implicitly. Called from the canvas tap (js/input.js) and the HUD
// selection tile. No-op in classic (inline exchange) and for anything
// that isn't an own completed Market.
function maybeReopenMktPopup(ent){
  if(isClassicUI || !ent || ent.type!=='building' || ent.btype!=='MARKET'
    || !ent.complete || ent.team!==myTeam) return;
  window.__mktPopupHidden=false;
  refreshMktPopup(ent);
}

// True when every selected thing is an own military unit that can take a
// Guard Position flag — the same eligibility filter execGuard applies
// deterministically (js/commands.js). Rams count: they never auto-engage,
// but holding a spot is a valid order for them.
function allGuardable(sel){
  // Delegates to guardEligible (js/commands.js, same global scope) — the
  // single eligibility filter, so the button can never drift from what
  // execGuard actually accepts.
  return sel.length>0 && sel.every(s=>s.team===myTeam&&guardEligible(s));
}

// Villager task -> resource carried, used by the selection card, the tile
// tooltip and the topbar villager counts alike (was three inline copies).
const TASK_RES = { chop: 'wood', mine_gold: 'gold', mine_stone: 'stone', forage: 'food', farm: 'food' };

// THE skin-detection signal — everything in this file keys off this one
// binding (page-shell.js sets both window.UI_VARIANT and the body class
// from the same value; checking them interchangeably invited the two
// mechanisms to disagree on a page that sets only one).
let isClassicUI = document.body.classList.contains('classic-ui');

// ---- Stat-chip formatting: ONE place for the ⚔️/🏹/🛡️/🏃 chips and the
// TC/tower arrow numbers. Three consumers render these — the train-button
// tooltip (descriptorForActBtn), the selection-tile tooltip
// (descriptorForSelTile) and the classic info card (updateUI) — and they
// must always show the same numbers for the same thing. ----
// labeled=true spells the stats out as words ("⚔️ Attack 5") — the classic
// selection card has the room and reads friendlier; tooltips and the mobile
// card keep the compact emoji-only form (default).
function unitStatChips(u, labeled){
  const chips = [];
  const L = labeled ? {atk:'Attack ', range:'Range ', armor:'Armor ', speed:'Speed '} : {atk:'', range:'', armor:'', speed:''};
  if (u.atk > 0) chips.push(`⚔️ ${L.atk}${u.atk}`);
  if (u.range > 0) chips.push(`🏹 ${L.range}${u.range}`);
  if (u.armor && (u.armor.m > 0 || u.armor.p > 0)) chips.push(`🛡️ ${L.armor}${u.armor.m}/${u.armor.p}`);
  if (u.speed > 0) chips.push(`🏃 ${L.speed}${u.speed.toFixed(2)}`);
  return chips;
}
// TC and towers auto-fire arrows; null for everything else. TC has no
// atk/range in BLDGS (its literals live here), towers read their own entry.
function buildingArrowStats(btype){
  if (!firesArrows(btype)) return null;
  if (btype === 'TC') return { atk: 5, range: 6 };
  return { atk: BLDGS[btype].atk, range: BLDGS[btype].range };
}

// Units whose LOOK changes with age get age-specific icon cells. Falls
// back to the base key for missing ages. Militia's BASE cell (row 0,
// col 1: plain peasant swordsman, no shield) is the Dark look — matching
// the in-game render, where the shield/helm only appear from Feudal on
// (js/render-units.js) — and the round-shield cell is the Feudal look.
const AGE_ICON_VARIANTS = {
  militia:  {1:'militia-feudal', 2:'militia-castle'},
  spearman: {2:'spearman-castle'},
  archer:   {2:'archer-castle'},
  scout:    {2:'scout-castle'},
  // Town Center portrait by age: Dark = wooden, Feudal = stone, Castle = the
  // fortified blue-tent keep. Every age is mapped to an age-suffixed cell —
  // there is no bare "TC" icon cell (see SPRITE_CELLS in page-shell.js).
  TC:       {0:'TC-dark', 1:'TC-feudal', 2:'TC-castle'},
  // Watch Tower by age (Feudal+; Dark has none — that's PTOWER). WT- cells.
  TOWER:    {1:'WT-feudal', 2:'WT-castle'},
  // Home button = the current age's Town Center top (keep + flag). Base
  // 'home' cell is the fallback when teamAge is unknown (pre-match).
  home:     {0:'home-dark', 1:'home-feudal', 2:'home-castle'},
};
// Cost rendered as mini resource-icon+number chips overlaid on the action
// button. Desktop keeps costs in the hover tooltip (.cost is display:none
// there so icons stay big); coarse-pointer devices show the chips instead,
// because touch has no hover tooltip and costs were simply invisible on
// mobile. CSS: .cost-chips in styles.css.
function costChips(cost){
  const CLS = { f:'food', w:'wood', g:'gold', s:'stone' };
  return '<span class="cost cost-chips">' + Object.entries(cost||{})
    .map(([k,v])=>`<span class="cost-chip"><span class="res-mini-icon icon-${CLS[k]||k}"></span>${v}</span>`)
    .join('') + '</span>';
}

function iconKey(type, team = myTeam){
  let v = AGE_ICON_VARIANTS[type];
  let k = v && teamAge ? v[teamAge[team]] : null;
  return k || type;
}
// window.bellRinging is per-team ([team 0, team 1]), maintained by
// ringTownBell/soundAllClear in js/logic.js. In single-player team 1 is the
// AI's bell; in multiplayer it's the guest's own.
function myBellActive(){
  return !!(window.bellRinging && window.bellRinging[myTeam]);
}

// Classic-only HP slot under the portrait (see #sel-hp in page-shell.js).
// Mobile keeps the HP block inline in #sel-details and never fills this.
function setSelHp(html){
  let el=document.getElementById('sel-hp');
  if(el) el.innerHTML=html;
}

function setPortraitIcon(port, key, fallbackEmoji){
  [...port.classList].filter(c=>c==='sprite-icon'||c.startsWith('icon-')).forEach(c=>port.classList.remove(c));
  if (SPRITE_ICON_KEYS.has(key)) {
    // The sprite renders on an INNER layer (clipper > img) instead of the
    // tile's own background: skins can then ZOOM the img past the sheet
    // cell's baked-in empty margins (the clipper crops the spill) without
    // touching the tile's border/box. Mobile leaves it unscaled — pixel-
    // identical to the old background-image approach.
    port.textContent='';
    let s=document.createElement('div');
    s.className='tile-sprite';
    s.innerHTML='<div class="tile-sprite-img sprite-icon icon-'+key+'"></div>';
    port.appendChild(s);
  } else {
    port.textContent = fallbackEmoji || '';
  }
}



function updateUI(){
  // resourceStore(myTeam): team 0's `res` for the host/single-player, or
  // `aiRes` for a multiplayer guest playing team 1 — so the topbar shows
  // whichever side THIS browser tab actually controls.
  let myResources = resourceStore(myTeam);
  let currentFood = Math.floor(myResources.food);
  let currentWood = Math.floor(myResources.wood);
  let currentGold = Math.floor(myResources.gold);
  let currentStone = Math.floor(myResources.stone);
  // Pop cap/used likewise computed for myTeam rather than the team-0-only
  // popUsed/popCap globals (those stay as team-0-specific caches refreshed
  // by refreshPopulationCounts() each tick — teamPopUsed/teamPopCap are
  // pure functions over `entities`, safe to call directly for any team).
  let myPopUsed = teamPopUsed(myTeam);
  let myPopCap = teamPopCap(myTeam);

  // Home button reflects the current age's Town Center (top-half keep icon).
  // Cheap: only rewrite the class when the age variant actually changes.
  let homeIconEl = document.querySelector('#home-btn .sprite-icon');
  if (homeIconEl) {
    let hk = 'icon-' + iconKey('home');
    if (!homeIconEl.classList.contains(hk)) homeIconEl.className = 'btn-emoji sprite-icon ' + hk;
  }

  // Calculate idle villagers count
  let idleVils = entities.filter(e => e.team === myTeam && e.type === 'unit' && e.utype === 'villager' && !e.task && !e.target && !e.garrisonedIn && e.path.length === 0);
  let currentIdleCount = idleVils.length;

  // Count of my villagers currently ASSIGNED to each resource, for the topbar
  // indicator. This keys off the persistent assignment, not transient state, so
  // the number holds steady while a villager walks to/from a drop-off rather
  // than flickering. A gatherer's assignment lives in e.task; while it's making
  // a drop-off run e.task is 'return' and the real job is stashed in e.prevTask.
  // Only the final return after its resource is gone has no prevTask — there we
  // fall back to the load in hand so it still counts until it goes idle.
  // Sheep are the exception: hunting isn't a gather task at all, it's driven by
  // e.target pointing at a sheep/sheep_carcass (task stays null), so we detect
  // that separately — otherwise shepherds flickered in and out of the food count
  // as they cycled between eating (no task) and returning (task 'return').
  let vilRes = {food:0, wood:0, gold:0, stone:0};
  for (let e of entities) {
    if (e.team === myTeam && e.type === 'unit' && e.utype === 'villager') {
      let r = e.task === 'return'
        ? (TASK_RES[e.prevTask] || (e.carrying > 0 ? e.carryType : null))
        : TASK_RES[e.task];
      if (!r && e.target != null) {
        let t = entitiesById.get(e.target);
        if (t && (t.utype === 'sheep' || t.utype === 'sheep_carcass')) r = 'food';
      }
      if (r && vilRes[r] !== undefined) vilRes[r]++;
    }
  }
  
  // Selection key
  let currentSelListKey = selected.map(s => s.id).join(',');
  if (currentSelListKey !== (window.lastSelListKey || '')) {
    window.currentVillagerMenu = 'main';
    window.lastSelListKey = currentSelListKey;
  }
  
  // Selected detail key
  let currentSelectionDetails = '';
  if (selected.length > 0) {
    let e = selected[0];
    currentSelectionDetails = `${e.id}:${e.hp}:${e.maxHp}:${e.complete ? 1 : 0}:${e.buildProgress || 0}`;
    // Gate lock state, so the Lock/Unlock button label flips the instant the
    // toggle lands (the button is derived from selected gates' .locked).
    if (e.type === 'building' && isGateBtype(e.btype)) currentSelectionDetails += ':gl' + selected.filter(s => s.locked).length;
    // Auto Scout state, so the toggle button label flips the instant it lands.
    if (e.type === 'unit' && e.utype === 'scout') currentSelectionDetails += ':as' + selected.filter(s => s.autoScout).length;
    if (e.queue) {
      // Structural signature only (queue contents), NOT trainTick: progress
      // changes every tick, and keying on it rebuilt the whole details panel
      // 30+ times a second — destroying the clickable queue slots under the
      // cursor (flashing hover, eaten cancel clicks). Live progress is
      // patched onto the stable DOM below instead.
      currentSelectionDetails += `:${e.queue.join(',')}`;
    }
    // Target-driven work (sheep harvesting) has no task, so key on task OR
    // target OR a carried load — otherwise the card wouldn't refresh as a
    // butcher's food count ticks up.
    if (e.task || e.target || e.carrying) {
      currentSelectionDetails += `:${e.task}:${e.carrying || 0}:${e.target || e.buildTarget || e.followId || 0}`;
    }
    let b = BLDGS[e.btype];
    if (b && b.isFarm) {
      let tr = (map[e.y] && map[e.y][e.x]) ? map[e.y][e.x].res : 0;
      currentSelectionDetails += `:${tr}`;
    }
    // Market exchange prices are global and drift when ANY player trades —
    // fold them into the dirty key so a selected Market's price labels (and
    // the buy costs feeding affordability) refresh on someone else's trade.
    if (e.btype === 'MARKET' && e.complete) {
      currentSelectionDetails += `:mkt${marketPrices.food}_${marketPrices.wood}_${marketPrices.stone}`;
    }
    // Prepaid-reseed count: consuming a prepaid reseed moves no resources
    // (they were spent at prepay time), so the Mill's badge and card line
    // need the count in the dirty key explicitly.
    if (e.btype === 'MILL' && e.complete) {
      currentSelectionDetails += `:pf${resourceStore(myTeam).prepaidFarms || 0}`;
    }
    // Include camera-lock state so toggling it (which changes no other
    // tracked field) still passes the dirty-state check below and refreshes
    // the '.cam-locked' portrait indicator immediately.
    currentSelectionDetails += `:cam${window.cameraFollowId === e.id ? 1 : 0}`;
    // Multi-select renders a live per-unit HP bar for every selected unit
    // (not just selected[0]), so the dirty check needs all of their HP too.
    if (selected.length > 1) {
      currentSelectionDetails += ':grid' + selected.map(s => s.id + '_' + s.hp).join(',');
    }
    // Garrison grid on a selected building — needs members + their HP in the
    // dirty key so the panel refreshes as units enter/leave/heal.
    if (selected.length === 1 && e.garrison && e.garrison.length > 0) {
      currentSelectionDetails += ':gar' + e.garrison.map(id => {
        let u = entitiesById.get(id);
        return u ? id + '_' + u.hp : id;
      }).join(',');
    }
  }

  // Initialize dirty state tracker if not present
  if (!window.lastUIState) {
    window.lastUIState = {
      food: -1, wood: -1, gold: -1, stone: -1,
      popUsed: -1, popCap: -1, idleCount: -1,
      gameOver: null, gameStarted: null, selectedKey: null,
      selectionDetails: null, placing: null, currentVillagerMenu: null,
      settingRally: null
    };
  }

  // Age signal for the dirty check: current age index + whether a TC is
  // researching (and toward what) — so the age crest and the idle-box age
  // display both refresh on advance/start/cancel, none of which touch the
  // other tracked fields on their own.
  let myResearchTC = (teamAge && isPlayerTeam(myTeam))
    ? entities.find(en => en.team === myTeam && en.btype === 'TC' && en.research) : null;
  let ageKey = (teamAge && isPlayerTeam(myTeam))
    ? teamAge[myTeam] + ':' + (myResearchTC ? myResearchTC.research.target : '-') : '';

  let lu = window.lastUIState;
  let stateChanged = (
    currentFood !== lu.food || currentWood !== lu.wood ||
    currentGold !== lu.gold || currentStone !== lu.stone ||
    myPopUsed !== lu.popUsed || myPopCap !== lu.popCap ||
    currentIdleCount !== lu.idleCount || gameOver !== lu.gameOver ||
    gameStarted !== lu.gameStarted || currentSelListKey !== lu.selectedKey ||
    currentSelectionDetails !== lu.selectionDetails || placing !== lu.placing ||
    window.currentVillagerMenu !== lu.currentVillagerMenu ||
    !!window.settingRally !== !!lu.settingRally ||
    !!window.settingGuard !== !!lu.settingGuard ||
    myBellActive() !== !!lu.bellActive ||
    ageKey !== lu.ageKey
  );

  // Live training-progress patch: runs every frame on the EXISTING DOM (bar
  // width only), so the interactive buttons are never rebuilt mid-hover/
  // mid-click. The fill lives ON the active unit's train button (same
  // anatomy as the Advance Age research fill below). Full rebuilds happen
  // only on structural changes via the dirty key above.
  if (selected.length === 1 && selected[0].queue && selected[0].queue.length > 0) {
    let u = UNITS[selected[0].queue[0]];
    if (u) {
      let pct = Math.floor(selected[0].trainTick / u.trainTime * 100);
      // querySelectorAll: the fill lives on the train button, and (classic
      // skin) the front queue slot's darkness veil drains as it trains.
      document.querySelectorAll('#actions .training-active .btn-progress-fill')
        .forEach(fill => { fill.style.width = pct + '%'; });
      document.querySelectorAll('#sel-queue .queue-slot .train-veil')
        .forEach(veil => { veil.style.height = (100 - pct) + '%'; });
    }
  }
  // Same live patch for the Advance button's research fill — smooth every
  // frame; the button itself only rebuilds on structural changes.
  if (selected.length === 1 && selected[0].research) {
    let fill = document.querySelector('#advance-progress-btn .btn-progress-fill');
    if (fill) fill.style.width = (selected[0].research.tick / AGES[selected[0].research.target].researchTicks * 100).toFixed(1) + '%';
  }

  if (!stateChanged) return;

  // Update cached state
  lu.food = currentFood;
  lu.wood = currentWood;
  lu.gold = currentGold;
  lu.stone = currentStone;
  lu.popUsed = myPopUsed;
  lu.popCap = myPopCap;
  lu.idleCount = currentIdleCount;
  lu.gameOver = gameOver;
  lu.gameStarted = gameStarted;
  lu.selectedKey = currentSelListKey;
  lu.selectionDetails = currentSelectionDetails;
  lu.placing = placing;
  lu.currentVillagerMenu = window.currentVillagerMenu;
  lu.settingRally = !!window.settingRally;
  lu.settingGuard = !!window.settingGuard;
  lu.bellActive = myBellActive();
  lu.ageKey = ageKey;

  // Perform actual DOM updates
  document.getElementById('r-food').textContent=currentFood;
  document.getElementById('r-wood').textContent=currentWood;
  document.getElementById('r-gold').textContent=currentGold;
  document.getElementById('r-stone').textContent=currentStone;
  for (let k of ['food','wood','gold','stone']) {
    let el = document.getElementById('rv-'+k);
    if (!el) continue;
    let n = vilRes[k];
    // Box always reserves its space (CSS toggles visibility, not display), so
    // the resource numbers never shift when villagers move on/off a resource.
    el.classList.toggle('on', n > 0);
    if (n > 0) el.textContent = n;
  }
  let popEl = document.getElementById('r-pop');
  if (popEl) popEl.textContent = `${myPopUsed}/${myPopCap}`;
  let ageEl = document.getElementById('r-age');
  if (ageEl && teamAge) {
    let crest = ageEl.parentElement.querySelector('.res-icon');
    if (crest) crest.className = 'res-icon sprite-icon icon-age-' + AGES[teamAge[myTeam]].key;
    let myTC = entities.find(en => en.team === myTeam && en.btype === 'TC' && en.research);
    ageEl.textContent = myTC
      ? `→ ${AGES[myTC.research.target].name.replace(' Age','')}…`
      : AGES[teamAge[myTeam]].name.replace(' Age','');
    ageEl.parentElement.title = myTC
      ? 'Advancing to the ' + AGES[myTC.research.target].name + ' — villager training is paused at the Town Center.'
      : 'Your current age. Advance from the Town Center to unlock new units and buildings.';
  }
  
  let bellBtn = document.getElementById('bell-btn');
  if(bellBtn) {
    if(gameStarted && !gameOver) {
      bellBtn.style.display = 'flex';
      bellBtn.innerHTML = '<span class="btn-emoji sprite-icon icon-bell"></span>';
      bellBtn.classList.toggle('bell-active', myBellActive());
      bellBtn.dataset.tipLabel = 'Town Bell';
      bellBtn.dataset.tipDesc = myBellActive()
        ? 'Bell is ringing — villagers are hiding in Town Centers and towers. Click to sound the all clear.'
        : 'Ring the town bell: all villagers run to garrison in the nearest Town Center or tower.';
    } else {
      bellBtn.style.display = 'none';
    }
  }

  let idleBtn = document.getElementById('idle-btn');
  if(idleBtn) {
    if(currentIdleCount > 0) {
      idleBtn.style.display = 'flex';
      idleBtn.innerHTML = `<span class="btn-emoji sprite-icon icon-idle"></span><div class="idle-badge">${currentIdleCount}</div>`;
      idleBtn.classList.add('idle-active');
      idleBtn.dataset.tipLabel = 'Idle Villager';
      idleBtn.dataset.tipDesc = `${currentIdleCount} villager${currentIdleCount>1?'s are':' is'} idle. Click to select and cycle through them.`;
    } else {
      idleBtn.style.display = 'none';
      idleBtn.classList.remove('idle-active');
    }
  }

  let act=document.getElementById('actions');
  let selKey=currentSelListKey+':'+placing+':'+(window.currentVillagerMenu||'main')+':'+currentIdleCount+':'+!!window.settingRally+':'+!!window.settingGuard
    +':'+myBellActive()+':'+(selected[0]&&selected[0].garrison?selected[0].garrison.length:0)
    // age + research flip which buttons EXIST (locked ones are hidden, wall/
    // gate slots upgrade to stone at Feudal) — the panel must rebuild then.
    +':'+(teamAge?teamAge[myTeam]:0)+':'+!!(selected[0]&&selected[0].research)
    // State the buttons DISPLAY that can change while the selection stays
    // put: the training queue (count badges + which button hosts the
    // progress fill), the Mill's banked-reseed badge, and market prices
    // (exchange labels + buy costs). Without these, queueing a unit didn't
    // show its badge until the building was re-selected.
    +':'+(selected[0]&&selected[0].queue?selected[0].queue.join('.'):'')
    // Auto Scout state: the button EXISTS only while some selected scout
    // isn't auto-scouting, so the strip must rebuild when the command lands.
    +':as'+selected.filter(s=>s.type==='unit'&&s.autoScout).length
    +':'+(selected[0]&&selected[0].btype==='MILL'?(resourceStore(myTeam).prepaidFarms||0):'')
    +':'+(selected[0]&&selected[0].btype==='MARKET'?marketPrices.food+'.'+marketPrices.wood+'.'+marketPrices.stone:'');
  let rebuildActions=selKey!==lastSelKey;
  lastSelKey=selKey;
  let bottomEl = document.getElementById('bottom');
  if (bottomEl) {
    let isSubMenu = window.currentVillagerMenu === 'eco' || window.currentVillagerMenu === 'mil';
    bottomEl.classList.toggle('menu-active', isSubMenu);
  }
  let minimapWrap = document.getElementById('minimap-wrap');
  if (minimapWrap) {
    minimapWrap.classList.toggle('build-active', !!(placing || window.isDraggingWall));
  }
  if(rebuildActions){
    act.innerHTML='';
    // The classic queue lane (#sel-queue, center panel) is rebuilt in the
    // same pass as the action buttons — clear it on the same cadence.
    let sq=document.getElementById('sel-queue');
    if(sq) sq.innerHTML='';
    // Selection changed: unless the new selection is an own completed
    // Market, retire the exchange popup (and reset its dismissed flag).
    let mktSel = selected.length===1 && selected[0].type==='building'
      && selected[0].btype==='MARKET' && selected[0].complete && selected[0].team===myTeam;
    if(!isClassicUI && !mktSel) refreshMktPopup(null);
  }

  // "Back" — leftmost action button whenever anything is selected, a
  // full-size mobile-friendly tap target (same size as every other action
  // button). A RETURN arrow, not an ✖: deselectAll() steps back ONE level
  // per press (cancel placement → cancel rally → leave submenu → deselect),
  // so for a villager the same arrow pressed repeatedly walks back out of
  // the build submenus and finally exits — the submenus' own separate Back
  // buttons are gone.
  if(rebuildActions && selected.length>0 && gameStarted && !gameOver){
    let backBtn=document.createElement('div');
    backBtn.className='act-btn back-btn framed';
    // Inside a villager build SUBMENU the back arrow is the only way back
    // to the main build panel — the classic skin hides .back-btn (desktop
    // steps back with Esc), but it must still show for this one case, so
    // tag it (see .submenu-back in classic-style.css).
    if(window.currentVillagerMenu==='eco'||window.currentVillagerMenu==='mil') backBtn.classList.add('submenu-back');
    backBtn.dataset.tipType='action';
    backBtn.dataset.tipLabel='Back';
    backBtn.dataset.tipDesc='Go back one step: cancel placement or targeting, leave a submenu, or deselect.';
    backBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-back"></div>`;
    backBtn.onclick=()=>{ if(window.deselectAll)window.deselectAll(); };
    act.appendChild(backBtn);

    // Bulk Cancel Build — when the whole selection is own unfinished
    // foundations (the wall-chain double-tap/double-click produces exactly
    // this), one button refunds them all. The single-foundation Cancel
    // Build lives in the building card below; this is its multi twin.
    if(selected.length>1 && selected.every(s=>s.type==='building'&&s.team===myTeam&&!s.complete&&!s.exhausted&&!s.upgrading)){
      let ids=selected.map(s=>s.id);
      let bulkBtn=document.createElement('div');
      bulkBtn.className='act-btn framed';
      bulkBtn.dataset.tipType='action';
      bulkBtn.dataset.tipLabel='Cancel Construction';
      bulkBtn.dataset.tipDesc='Stop building all '+ids.length+' selected foundations and refund their full cost.';
      bulkBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-cancel"></div><div class="btn-label">Cancel ×${ids.length}</div><span class="cost">full refund</span>`;
      bulkBtn.onclick=()=>{
        requestDeleteOwned(ids);
        if(netRole==='guest'&&typeof showMsg==='function')showMsg(ids.length+' foundations cancelled (refunded)');
        selected=[];
        updateUI();
      };
      act.appendChild(bulkBtn);
    }

    // Upgrade — when the selection is entirely own COMPLETED upgradeable
    // wood pieces (walls / palisade gates / palisade watch towers;
    // double-click/double-tap on a standing wall selects the whole
    // connected run) and every piece's target is unlocked (Feudal).
    // Instantly salvages the old piece (HP-scaled refund) and swaps it into
    // a construction site of the target type that villagers build up — see
    // execUpgradeWalls (js/commands.js). Once started it just proceeds
    // (no cancel). The chips show the NET cost after salvage.
    if(selected.length>0
       && selected.every(s=>s.type==='building'&&s.team===myTeam&&WALL_STONE_MATCH[s.btype]&&s.complete&&!s.exhausted)
       && selected.every(s=>isUnlocked(myTeam,WALL_STONE_MATCH[s.btype]))){
      let ids=selected.map(s=>s.id);
      let cost={};
      selected.forEach(s=>{
        Object.entries(BLDGS[WALL_STONE_MATCH[s.btype]].cost)
          .forEach(([k,v])=>{cost[k]=(cost[k]||0)+v;});
        Object.entries(upgradeSalvage(s))
          .forEach(([k,v])=>{cost[k]=(cost[k]||0)-v;});
      });
      Object.keys(cost).forEach(k=>{if(cost[k]<=0)delete cost[k];});
      let allGates=selected.every(s=>s.btype==='GATE');
      let allTowers=selected.every(s=>s.btype==='PTOWER');
      let tipLabel=allTowers?'Upgrade to Watch Tower':(allGates?'Upgrade to Stone Gate':'Upgrade to Stone Wall');
      let tipDesc=(allTowers
        ?'Rebuild the selected palisade tower'+(ids.length>1?'s':'')+' as '+(ids.length>1?'stone Watch Towers.':'a stone Watch Tower.')
        :'Rebuild the selected palisade '+(allGates?'gate':'piece'+(ids.length>1?'s':''))+' in stone.')
        +' Salvages the old piece (refund scales with remaining HP) and starts construction — send villagers to build it. Cannot be cancelled once started.';
      let upIcon=allTowers?iconKey('TOWER'):(allGates?'SGATE':'SWALL'); // age-suffixed WT- cell; no bare TOWER icon
      let upBtn=document.createElement('div');
      upBtn.className='act-btn'; // building icon has no baked frame → keep the button's own border
      upBtn.dataset.tipType='action';
      upBtn.dataset.tipLabel=tipLabel;
      upBtn.dataset.tipDesc=tipDesc;
      upBtn.dataset.cost=JSON.stringify(cost);
      upBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-${upIcon}"></div><div class="btn-label">${allTowers?'To Tower':'To Stone'}${ids.length>1?' ×'+ids.length:''}</div>${costChips(cost)}`;
      upBtn.onclick=()=>{
        submitCommand({kind:'upgrade-walls',unitIds:ids});
      };
      act.appendChild(upBtn);
    }
    // Lock / unlock gate (AoE2): shown when every selected building is an own
    // complete gate. A locked gate seals its doorway to everyone (incl. allies)
    // so you can shut a raider out through your own wall line. Toggles all
    // selected gates to the same state — lock if any is currently open.
    if(selected.length>0 && selected.every(s=>s.type==='building'&&s.team===myTeam&&isGateBtype(s.btype)&&s.complete&&!s.exhausted)){
      let gateIds=selected.map(s=>s.id);
      let wantLock=selected.some(s=>!s.locked); // any unlocked → lock all; else unlock all
      let lockBtn=document.createElement('div');
      // NOT 'framed': the lock/unlock sprite cells are bare glyphs with no
      // frame baked into the art (unlike the SGATE/econ/mil icons), so the
      // plain .act-btn wooden border is what gives them the same framed look.
      lockBtn.className='act-btn';
      lockBtn.dataset.tipType='action';
      lockBtn.dataset.tipLabel=wantLock?'Lock Gate':'Unlock Gate';
      lockBtn.dataset.tipDesc=wantLock
        ?'Seal the gate so nothing passes — including your own villagers and allies. Use it to shut a raider out.'
        :'Reopen the gate so your units and allies pass through again.';
      lockBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-gate-${wantLock?'lock':'unlock'}"></div><div class="btn-label">${wantLock?'Lock':'Unlock'}${gateIds.length>1?' ×'+gateIds.length:''}</div>`;
      lockBtn.onclick=()=>{
        submitCommand({kind:'gate-lock',bldgIds:gateIds,locked:wantLock});
      };
      act.appendChild(lockBtn);
    }
  }

  // Multi-select: the portrait+stats card is replaced by a grid of icons
  // (AoE2-style). AoE2 groups identical unit types into a single icon with
  // a count badge — selecting 5 archers shows one archer portrait "x5", not
  // five identical icons — and only fans out to one-icon-per-type when the
  // selection is mixed. Rebuilt only when the selection or any selected
  // unit's HP changes (see currentSelectionDetails).
  let selInfo=document.getElementById('sel-info');
  let selGrid=document.getElementById('sel-grid');
  let isMulti=selected.length>1;
  // A selected own building with units inside reuses the multi-select grid to
  // show its garrison (AoE2-style); clicking an icon releases one of them.
  let garrisonSel = !isMulti && selected.length===1 && selected[0].type==='building'
    && selected[0].team===myTeam && selected[0].garrison && selected[0].garrison.length>0
    ? selected[0] : null;
  // Mobile skin: SINGLE selections render through the same grid as groups —
  // one gold tile with an HP strip, no name, no separate portrait card. The
  // selection panel is one visual language whether 1 or 40 things are
  // selected. Classic keeps its AoE2 portrait + name + stats readout.
  // !gameOver everywhere below: the end-of-match branch writes VICTORY!/
  // DEFEAT! into #sel-name/#sel-details, and a selection surviving into
  // game over (the normal DEFEAT case) must not leave those hidden behind
  // the grid classes.
  let singleGrid = !isClassicUI && !isMulti && !garrisonSel && selected.length===1 && !gameOver;
  // NULL selection is a tile too: the age crest renders through the same
  // grid as any single selection — same style, same spacing, one language
  // for the panel in every state. (Classic keeps its title/portrait box.)
  let idleCrest = !isClassicUI && selected.length===0 && gameStarted && !gameOver
    && typeof teamAge !== 'undefined' && teamAge && isPlayerTeam(myTeam);
  // (No separate 'has-selection' class: in the mobile skin EVERY selection
  // state — single, group, garrison, idle crest — goes through the grid,
  // and .multi-select already hides the whole #sel-stats card; classic
  // never had a rule for it. One class, one meaning.)
  if(selInfo) selInfo.classList.toggle('multi-select', (isMulti||!!garrisonSel||singleGrid||idleCrest) && !gameOver);
  // The grid gets its OWN dirty key: only what it actually renders (selection
  // membership, per-unit HP, garrison members). Keying it on the full
  // currentSelectionDetails rebuilt every icon ~30×/s while watching a
  // construction or a gathering villager — per-tick fields (buildProgress,
  // farm res, carried amount, cam flag) the grid doesn't even display.
  let gridKey = currentSelListKey;
  if (isMulti || singleGrid) gridKey += ':' + selected.map(s => s.id + '_' + s.hp).join(',')
    + ':cam' + (window.cameraFollowId || 0);
  if (idleCrest) {
    // myResearchTC was already computed for the age dirty-key at the top of
    // this function — no second full-entities scan.
    gridKey += ':idleage' + (myResearchTC ? 'adv' + myResearchTC.research.target : teamAge[myTeam]);
  }
  if (garrisonSel) gridKey += ':gar' + garrisonSel.garrison.map(id => {
    let u = entitiesById.get(id);
    return u ? id + '_' + u.hp : id;
  }).join(',');
  if(selGrid && gridKey!==(window.lastSelGridDetails||'')){
    window.lastSelGridDetails=gridKey;
    selGrid.innerHTML='';
    // Buckets a flat unit/building list into same-type groups, preserving
    // first-seen order so the grid doesn't reshuffle every refresh.
    let groupByType=(list)=>{
      let order=[], groups=new Map();
      list.forEach(s=>{
        let key=s.type==='building'?s.btype:s.utype;
        if(!groups.has(key)){ groups.set(key,[]); order.push(key); }
        groups.get(key).push(s);
      });
      return order.map(key=>{
        let members=groups.get(key);
        let data=members[0].type==='building'?BLDGS[key]:UNITS[key];
        return {key,data,members};
      });
    };
    let renderGroup=(g, {title, onClick, onRemove})=>{
      let icon=document.createElement('div');
      icon.className='sel-unit-icon';
      setPortraitIcon(icon, iconKey(g.key, g.members[0].team), g.data&&g.data.icon);
      // Rich hover tooltip (desktop): the classic skin's full readout —
      // live HP, combat stats, a villager's job — resolved from these ids
      // at hover time (descriptorForSelTile). dataset, not title: a native
      // title would double up with the custom #tooltip.
      icon.dataset.tileIds=g.members.map(m=>m.id).join(',');
      icon.dataset.tipName=(g.data&&g.data.name||g.key)+(g.members.length>1?' ×'+g.members.length:'');
      let avgHpPct=Math.max(0,Math.min(100,Math.round(
        g.members.reduce((sum,u)=>sum+u.hp/u.maxHp,0)/g.members.length*100)));
      let hpColor='#2b8a3e';
      if(avgHpPct<20) hpColor='#cc3333';
      else if(avgHpPct<50) hpColor='#d9a711';
      let bar=document.createElement('div');bar.className='sel-unit-hp';
      let fill=document.createElement('div');fill.className='sel-unit-hp-fill';
      fill.style.width=avgHpPct+'%';
      fill.style.background=hpColor;
      bar.appendChild(fill);
      icon.appendChild(bar);
      if(g.members.length>1){
        let badge=document.createElement('div');
        badge.className='sel-unit-count';
        badge.textContent=g.members.length;
        icon.appendChild(badge);
      }
      icon.dataset.tipDesc=title(g);
      icon.onclick=(ev)=>onClick(g,ev);
      if(onRemove) icon.oncontextmenu=(ev)=>{ ev.preventDefault(); onRemove(g,ev); };
      // Single-unit tile inherits the old portrait's double-click/tap
      // camera-follow toggle (and its green lock glow).
      if(g.members.length===1 && g.members[0].type==='unit'){
        icon.ondblclick=()=>{ if(window.toggleCameraFollow) toggleCameraFollow(); };
        icon.classList.toggle('cam-locked', window.cameraFollowId===g.members[0].id);
      }
      selGrid.appendChild(icon);
    };
    if(garrisonSel){
      let members=garrisonSel.garrison.map(id=>entitiesById.get(id)).filter(Boolean);
      groupByType(members).forEach(g=>{
        renderGroup(g, {
          title: ()=>`Click to release one from garrison.`,
          onClick: (g)=>{
            if(gameOver)return;
            let victim=g.members[0];
            submitCommand({ kind: 'eject-garrison', bldgId: garrisonSel.id, unitId: victim.id });
          }
        });
      });
    } else if(isMulti || singleGrid){
      groupByType(selected).forEach(g=>{
        renderGroup(g, {
          title: g=>g.members.length===1
            ? '' // no hint text on a single tile — stats speak for themselves
            : `Click: select only this group. Shift-click: remove it from the selection.`,
          onClick: (g,ev)=>{
            if(ev.shiftKey) selected=selected.filter(u=>!g.members.includes(u));
            else {
              selected=g.members.slice();
              if(g.members.length===1) maybeReopenMktPopup(g.members[0]);
            }
            updateUI();
          },
          onRemove: (g)=>{
            selected=selected.filter(u=>!g.members.includes(u));
            updateUI();
          }
        });
      });
    } else if(idleCrest){
      // NULL SELECTION tile: the current age's crest (or the TARGET age's
      // while advancing) drawn as the exact same tile as a single selection.
      let advTC = myResearchTC; // computed once at the top of updateUI
      let crestIdx = advTC ? advTC.research.target : teamAge[myTeam];
      let icon = document.createElement('div');
      icon.className = 'sel-unit-icon';
      setPortraitIcon(icon, 'age-' + AGES[crestIdx].key, '🏛️');
      icon.dataset.tipName = advTC ? ('Advancing to ' + AGES[crestIdx].name + '…') : AGES[crestIdx].name;
      if (advTC) icon.dataset.tipDesc = 'Villager training is paused at the Town Center while advancing.';
      selGrid.appendChild(icon);
    }
  }

  let port = document.getElementById('sel-portrait');
  if(gameOver){
    if(!isClassicUI) refreshMktPopup(null); // no trading over the end screen
    let iWon = didIWin();
    if (port) { setPortraitIcon(port, null, iWon ? '🏆' : '💀'); port.classList.remove('cam-locked'); }
    setSelHp('');
    document.getElementById('sel-name').textContent=iWon?'VICTORY!':'DEFEAT!';
    document.getElementById('sel-details').textContent=iWon?'You destroyed the enemy Town Center!':'Your Town Center was destroyed!';
    return;
  }
  if(!gameStarted){
    if (port) { setPortraitIcon(port, 'logo', '⚔️'); port.classList.remove('cam-locked'); }
    setSelHp('');
    document.getElementById('sel-name').textContent='Choose Difficulty';
    document.getElementById('sel-details').textContent='Select Easy, Medium, or Hard to begin';
    return;
  }

  if(selected.length===0){
    setSelHp('');
    // Nothing selected: the modern skin (index.html) surfaces the current
    // AGE here — its top-bar age chip is hidden on mobile (cramped), so
    // this idle box is where age lives. More useful than the old game-name
    // placeholder, and harmless on desktop. Classic keeps the title.
    let modern = !isClassicUI;
    if (modern && teamAge && isPlayerTeam(myTeam)) {
      let myTC = entities.find(en => en.team === myTeam && en.btype === 'TC' && en.research);
      let ageIdx = teamAge[myTeam];
      // Crest ONLY — no age name text. While advancing, show the TARGET
      // age's crest instead (the research progress itself lives on the TC's
      // Advance button).
      let crestIdx = myTC ? myTC.research.target : ageIdx;
      if (port) { setPortraitIcon(port, 'age-' + AGES[crestIdx].key, '🏛️'); port.classList.remove('cam-locked'); }
      document.getElementById('sel-name').textContent = '';
      document.getElementById('sel-details').textContent = '';
      return;
    }
    if (port) { setPortraitIcon(port, 'logo', '⚔️'); port.classList.remove('cam-locked'); }
    document.getElementById('sel-name').textContent='Age of Epochs II';
    document.getElementById('sel-details').textContent='Select a unit or building';
    return;
  }
  let e=selected[0];
  if(e.type==='building'){
    let b=BLDGS[e.btype];
    if (port) { setPortraitIcon(port, iconKey(e.btype, e.team), b.icon); port.classList.remove('cam-locked'); }
    document.getElementById('sel-name').textContent=b.name;
    let hpPct = Math.max(0, Math.min(100, Math.floor(e.hp / e.maxHp * 100)));
    // Cyan while under construction — the same one-bar consolidation as the
    // in-world bar (render-buildings.js): HP grows with construction, so
    // this bar IS the build progress; cyan keeps the low fill from reading
    // as damage. No separate "Building: X%" text row.
    let hpColor = '#2b8a3e';
    if (!e.complete) hpColor = '#00e5ff';
    else if (hpPct < 20) hpColor = '#cc3333';
    else if (hpPct < 50) hpColor = '#d9a711';
    // The training queue used to DISPLACE this card (bar + tiny slots where
    // the HP readout goes) — queue state now lives on the train buttons
    // themselves (count badge + progress fill, see the b.builds block
    // below), so the card always shows the normal HP/garrison/dropoff info.
    let det;
    {
      // Classic: AoE2's read — the bar sits directly under the portrait at
      // the portrait's width, numbers beneath it (#sel-hp). Mobile keeps
      // the "HP: x/y" text + thin bar in the details column.
      let hpBlock = isClassicUI
        ? `<div class="hp-bar-bg"><div class="hp-bar-fill" style="width: ${hpPct}%; background-color: ${hpColor};"></div></div><div class="hp-num">${Math.ceil(e.hp)}/${e.maxHp}</div>`
        : `HP: ${Math.ceil(e.hp)}/${e.maxHp}<div class="hp-bar-bg"><div class="hp-bar-fill" style="width: ${hpPct}%; background-color: ${hpColor};"></div></div>`;
      setSelHp(isClassicUI ? hpBlock : '');
      det = isClassicUI ? '' : hpBlock;

      let arrows = buildingArrowStats(e.btype);
      if(arrows) {
        // Classic spells the stats out, one recessed chip per stat.
        let aChips = isClassicUI
          ? [`⚔️ Attack ${arrows.atk}`, `🏹 Range ${arrows.range}`]
          : [`⚔️ ${arrows.atk}`, `🏹 ${arrows.range}`];
        det += `<div class="det-stats"><span class="sel-combat-stats">${aChips.map(c=>`<span class="stat-chip">${c}</span>`).join('')}</span></div>`;
      }
      // The TC card skips the garrison line — its count already shows on the
      // building itself (the number by the flag) and in the garrison grid.
      if(e.complete && garrisonCap(e) > 0 && e.btype !== 'TC') {
        det += `<div class="det-row">Garrison: ${garrisonCount(e)}/${garrisonCap(e)}${garrisonCount(e)>0?' (+'+Math.min(garrisonCount(e),5)+' arrows)':''}</div>`;
      }
      // (No "Building: X%" row while under construction — the cyan HP bar
      // above carries the progress, matching the in-world bar.)
      if(e.complete || e.exhausted) {
        // No "Provides N population" (House) or "Dropoff: food" (Mill) info
        // lines — what the building does is implied by the building, and on
        // the narrow portrait card these text rows read as extra grey bars
        // under the HP bar. Camp dropoffs keep their line for now.
        if(b.drop && e.btype !== 'MILL' && !b.pop) {
          det+=`<div class="det-row">Dropoff: ${b.drop}</div>`;
        }
        else if(b.isFarm){
          if(e.exhausted){
            det+=`<div class="det-row det-alert">EXHAUSTED</div>`;
            if(e.buildProgress > 0) {
              det+=`<div class="det-row">Reseeding: ${Math.floor(e.buildProgress/e.buildTime*100)}%</div>`;
            }
          } else {
            let tr=map[e.y]&&map[e.y][e.x]?map[e.y][e.x].res:0;
            det+=`<div class="det-row">Food remaining: ${tr}</div>`;
          }
        }
      }
    }
    document.getElementById('sel-details').innerHTML=det;
    if(rebuildActions&&e.team===myTeam){
      // Cancel Construction — a full-size action button so touch players
      // can abort a mis-placed foundation (desktop always had the
      // Delete/Backspace path to deleteOwnedEntity; there is no key on a
      // phone). Full refund, same rule as the key (js/logic.js's
      // deleteOwnedEntity). Only for a genuine in-progress foundation —
      // an exhausted farm mid-reseed is not a cancellable purchase, and a
      // committed upgrade (e.upgrading) just proceeds, no cancel.
      if(!e.complete && !e.exhausted && !e.upgrading && selected.length===1){
        let cancelBuildBtn=document.createElement('div');
        cancelBuildBtn.className='act-btn framed';
        cancelBuildBtn.dataset.tipType='action';
        cancelBuildBtn.dataset.tipLabel='Cancel Construction';
        cancelBuildBtn.dataset.tipDesc='Stop building this and refund its full cost.';
        // Same anatomy as every other action button: sprite icon (the
        // icon-cancel red X, freed up when the deselect button became the
        // back arrow) + label + cost line.
        cancelBuildBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-cancel"></div><div class="btn-label">Cancel Build</div><span class="cost">full refund</span>`;
        cancelBuildBtn.onclick=()=>{
          requestDeleteOwned([e.id]);
          // The guest's copy vanishes on the next sync (~65ms); give the
          // instant local feedback the host path gets from
          // deleteOwnedEntity's own showMsg.
          if(netRole==='guest'&&typeof showMsg==='function')showMsg(b.name+' cancelled (refunded)');
          selected=[];
          updateUI();
        };
        act.appendChild(cancelBuildBtn);
      }
      if(e.complete && b.builds){
        // Locked (future-age) units are HIDDEN, not greyed — AoE2-style:
        // the menu only offers what you can actually train right now.
        // Queue feedback lives ON each train button: the actively-training
        // unit's button carries a bottom progress fill (same anatomy as
        // Advance Age), and any queued unit shows a count badge. The badge
        // is DISPLAY-ONLY (pointer-events:none): a rapid second tap lands
        // exactly where the badge appears, and a corner tap that CANCELLED
        // the unit just queued was a nasty surprise — clicks pass through
        // to the button, so double-tap = queue two. Cancelling lives in the
        // classic skin's queue slots below.
        b.builds.filter(ut=>isUnlocked(myTeam,ut)).forEach(ut=>{
          let u=UNITS[ut];
          let btn=document.createElement('div');btn.className='act-btn';
          btn.dataset.tipType='unit';
          btn.dataset.tipKey=ut;
          btn.dataset.cost=JSON.stringify(u.cost);
          // Units without a sprites.png cell (ram) fall back to their emoji
          // glyph, same rule as setPortraitIcon.
          let trainIcon=SPRITE_ICON_KEYS.has(iconKey(ut))
            ?`<div class="btn-emoji sprite-icon icon-${iconKey(ut)}"></div>`
            :`<div class="btn-emoji">${u.icon||''}</div>`;
          btn.innerHTML=`${trainIcon}<div class="btn-label">${u.name}</div>${costChips(u.cost)}`;
          let queued=e.queue?e.queue.filter(q=>q===ut).length:0;
          if(queued>0){
            btn.innerHTML+=`<div class="queue-count" title="${queued} queued">${queued}</div>`;
          }
          if(e.queue&&e.queue.length>0&&e.queue[0]===ut){
            let pct=Math.floor(e.trainTick/u.trainTime*100);
            btn.classList.add('training-active');
            btn.innerHTML+=`<div class="btn-progress-fill" style="position:absolute;left:0;bottom:0;height:3px;background:#fc0;width:${pct}%;"></div>`;
          }
          btn.onclick=()=>trainUnit(e,ut);
          act.appendChild(btn);
        });


        // ---- Advance Age (TC only) ----
        if(e.btype==='TC'&&teamAge&&teamAge[myTeam]<AGES.length-1){
          let next=AGES[teamAge[myTeam]+1];
          let btn=document.createElement('div');btn.className='act-btn';
          btn.dataset.tipType='action';
          if(e.research){
            btn.dataset.tipLabel='Researching '+AGES[e.research.target].name;
            btn.id='advance-progress-btn';
            // Keeps the age-crest icon (not a generic research glyph) so
            // WHAT is being bought stays readable — the fill (+ classic's
            // Cancel line) already say it's in progress.
            btn.innerHTML=`<div class="btn-emoji sprite-icon icon-age-${AGES[e.research.target].key}"></div><div class="btn-label">${AGES[e.research.target].name}</div>`
              +(isClassicUI?`<span class="cost">Cancel</span>`:'')
              +`<div class="btn-progress-fill" style="position:absolute;left:0;bottom:0;height:3px;background:#fc0;width:0%;"></div>`;
            btn.style.position='relative';
            if(isClassicUI){
              // Classic keeps AoE2's cancel-by-clicking-again. The tap-model
              // skin deliberately does NOT: on touch, a stray tap on the TC
              // card silently refunded a whole age advance.
              btn.dataset.tipDesc='The Town Center cannot train villagers while advancing. Click to cancel and refund the full cost.';
              btn.onclick=()=>{ submitCommand({kind:'cancel-research',bldgId:e.id}); };
            } else {
              btn.dataset.tipDesc='The Town Center cannot train villagers while advancing.';
            }
          } else {
            btn.dataset.cost=JSON.stringify(next.cost);
            btn.dataset.tipLabel='Advance to '+next.name;
            // tipCost renders the same icon cost rows as building/unit tips.
            btn.dataset.tipCost=JSON.stringify(next.cost);
            btn.dataset.tipDesc=(teamAge[myTeam]===0
              ? 'Unlocks spearmen, archers, scouts, watch towers, and stone walls. Military gains +1 attack and +1 armor.'
              : 'Unlocks the knight. Military gains a further +1 attack and +1 armor.')
              +' The Town Center pauses villager training while researching.';
            btn.innerHTML=`<div class="btn-emoji sprite-icon icon-age-${next.key}"></div><div class="btn-label">Advance to ${next.name}</div>${costChips(next.cost)}`;
            btn.onclick=()=>{ submitCommand({kind:'research-age',bldgId:e.id}); };
          }
          act.appendChild(btn);
        }

        // Rally Point button — lets mobile players set rally without right-click
        if (e.complete) {
          if (window.settingRally) {
            // Show cancel button while in rally-setting mode
            let cancelBtn=document.createElement('div');
            cancelBtn.className='act-btn rally-btn rally-active';
            cancelBtn.id='rally-cancel-btn';
            cancelBtn.dataset.tipType='action';
            cancelBtn.dataset.tipLabel='Cancel Rally';
            cancelBtn.dataset.tipDesc='Click to stop setting the rally point.';
            cancelBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-rally"></div><div class="btn-label">Tap map to<br>set rally</div>`;
            cancelBtn.onclick=()=>{ window.settingRally=false; showMsg('Rally cancelled'); updateUI(); };
            act.appendChild(cancelBtn);
          } else {
            let rallyBtn=document.createElement('div');
            rallyBtn.className='act-btn rally-btn';
            rallyBtn.id='rally-set-btn';
            rallyBtn.dataset.tipType='action';
            rallyBtn.dataset.tipLabel='Set Rally Point';
            rallyBtn.dataset.tipDesc='Newly trained units will automatically walk to the rally point after spawning.';
            rallyBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-rally"></div><div class="btn-label">Set Rally</div>`;
            rallyBtn.onclick=()=>{
              if(gameOver)return;
              window.settingRally=true;
              showMsg('Tap the map to set rally point');
              updateUI();
            };
            act.appendChild(rallyBtn);
          }
        }
        // CLASSIC skin: the queue as its own STRIP of small slot buttons in
        // the CENTER panel's #sel-queue lane (real AoE2 shows the training
        // queue in the info panel, and the wide center card has the room).
        // One recessed slot per queued unit, click cancels it (full
        // refund); the front slot wears the training veil. Classic hides
        // the count badge via CSS and shows this instead; the mobile skin
        // gets no cancel affordance at all (deliberate — see badge comment
        // above).
        if (isClassicUI && e.queue && e.queue.length > 0) {
          let strip = document.createElement('div');
          strip.className = 'queue-strip-row';
          e.queue.forEach((ut, idx) => {
            let u = UNITS[ut];
            let slot = document.createElement('div');
            slot.className = 'queue-slot' + (idx === 0 ? ' training-active' : '');
            slot.dataset.tipType = 'action';
            slot.dataset.tipLabel = 'Queued: ' + (u ? u.name : ut);
            slot.dataset.tipDesc = 'Click to cancel and refund.';
            let icon = SPRITE_ICON_KEYS.has(iconKey(ut))
              ? `<div class="btn-emoji sprite-icon icon-${iconKey(ut)}"></div>`
              : `<div class="btn-emoji">${u && u.icon || ''}</div>`;
            // AoE2's training read: the un-trained fraction of the FRONT
            // slot is veiled in darkness that drains upward as the unit
            // trains (live-patched with the fills every frame).
            slot.innerHTML = icon + `<div class="queue-x">✕</div>`
              + (idx === 0
                ? `<div class="train-veil" style="height:${100 - Math.floor(e.trainTick / UNITS[e.queue[0]].trainTime * 100)}%;"></div>`
                : '');
            slot.onclick = () => cancelQueue(e.id, idx);
            strip.appendChild(slot);
          });
          let lane = document.getElementById('sel-queue');
          (lane || act).appendChild(strip);
        }
      }

      if(e.complete && e.btype === 'MILL') {
        let prepaid=resourceStore(myTeam).prepaidFarms||0;
        // reseed icon has no baked frame → plain act-btn (keeps its border),
        // matching the train buttons rather than the framed action glyphs.
        let btn=document.createElement('div');btn.className='act-btn';
        btn.dataset.tipType='action';
        btn.dataset.tipLabel='Prepay Farm Reseed';
        btn.dataset.tipDesc='Pre-pays 60 Wood to automatically reseed an exhausted farm. Queued reseeds are used before spending resources again.';
        btn.dataset.tipCost=JSON.stringify({w:60});
        btn.dataset.cost=JSON.stringify({w:60});
        btn.innerHTML=`<div class="btn-emoji sprite-icon icon-reseed"></div><div class="btn-label">Prepay Reseed</div>${costChips({w:60})}`;
        // Banked reseeds use the SAME queue language as unit training: index
        // shows a count badge on the button; classic shows one cancellable
        // slot per reseed in the #sel-queue lane (click to refund 60 wood),
        // exactly like the training queue.
        if(!isClassicUI && prepaid>0)btn.innerHTML+=`<div class="queue-count queue-count-static" title="${prepaid} reseed${prepaid>1?'s':''} prepaid">${prepaid}</div>`;
        btn.onclick=()=>prepayFarm();
        act.appendChild(btn);
        if(isClassicUI && prepaid>0){
          let strip=document.createElement('div');
          strip.className='queue-strip-row';
          for(let i=0;i<prepaid;i++){
            let slot=document.createElement('div');
            slot.className='queue-slot'; // no training-active/veil — reseeds are instant banked credits
            slot.dataset.tipType='action';
            slot.dataset.tipLabel='Prepaid reseed';
            slot.dataset.tipDesc='Click to cancel and refund 60 Wood.';
            slot.innerHTML=`<div class="btn-emoji sprite-icon icon-reseed"></div><div class="queue-x">✕</div>`;
            slot.onclick=()=>cancelReseed();
            strip.appendChild(slot);
          }
          let lane=document.getElementById('sel-queue');
          (lane||act).appendChild(strip);
        }
      }
      if(b.isFarm && e.exhausted) {
        let btn=document.createElement('div');btn.className='act-btn'; // reseed icon has no baked frame → keep the button border
        btn.dataset.tipType='action';
        btn.dataset.tipLabel='Reactivate Farm';
        btn.dataset.tipDesc='Spends 60 Wood to restore this exhausted farm to full capacity (175 Food).';
        btn.dataset.tipCost=JSON.stringify({w:60});
        btn.dataset.cost=JSON.stringify({w:60});
        btn.innerHTML=`<div class="btn-emoji sprite-icon icon-reseed"></div><div class="btn-label">Reactivate</div>${costChips({w:60})}`;
        btn.onclick=()=>reactivateFarm(e);
        act.appendChild(btn);
      }
      // Market commodity exchange (buildMktExchange below): CLASSIC shows
      // it inline in the command grid as before; the MOBILE skin shows a
      // dismissible POPUP over the battlefield instead — the inline widget
      // filled the whole landscape rail and buried the other buttons, and
      // the popup has room for bigger prices. The strip gets a Trade
      // button that reopens the popup after ✕.
      if(e.complete && e.btype === 'MARKET'){
        if (isClassicUI) {
          // AoE2-style: the exchange is two full-width rows of REAL square
          // command buttons — Buy food/wood/stone, then Sell — price
          // printed on each button, row label recessed like the queue
          // lane. Appended last so the train/rally buttons stay put.
          appendMktGridRows(act);
        } else {
          let pbtn=document.createElement('div');pbtn.className='act-btn';
          pbtn.id='mkt-trade-btn';
          pbtn.dataset.tipType='action';
          pbtn.dataset.tipLabel='Trade';
          pbtn.dataset.tipDesc='Open the Market exchange to buy and sell resources for gold.';
          pbtn.innerHTML=`<div class="btn-emoji sprite-icon icon-gold"></div><div class="btn-label">Trade</div>`;
          pbtn.onclick=()=>{ window.__mktPopupHidden=!window.__mktPopupHidden; refreshMktPopup(e); };
          act.insertBefore(pbtn, act.querySelector('.rally-btn'));
          refreshMktPopup(e);
        }
      }
    }
  } else {
    if (port) {
      setPortraitIcon(port, iconKey(e.utype, e.team), UNITS[e.utype].icon);
      port.classList.toggle('cam-locked', window.cameraFollowId===e.id);
    }
    // Use the unit's real name (Scout Cavalry, Militia, …) instead of a
    // generic "Soldier". Uniform multi-selections pluralize; mixed ones get
    // a group label.
    const UNIT_PLURALS = {villager:'Villagers', militia:'Militia', spearman:'Spearmen',
      archer:'Archers', scout:'Scout Cavalry', sheep:'Sheep', sheep_carcass:'Sheep Carcasses', bear:'Bears'};
    let unitName = UNITS[e.utype] ? UNITS[e.utype].name : e.utype;
    if (selected.length > 1) {
      let allSame = selected.every(s => s.utype === e.utype);
      if (allSame) {
        unitName = UNIT_PLURALS[e.utype] || unitName;
      } else {
        unitName = selected.every(s => s.utype !== 'villager' && s.utype !== 'sheep' && s.utype !== 'sheep_carcass') ? 'Army' : 'Mixed Group';
      }
    }
    document.getElementById('sel-name').textContent = unitName + (selected.length > 1 ? ` (${selected.length})` : '');
    let hpPct = Math.max(0, Math.min(100, Math.floor(e.hp / e.maxHp * 100)));
    let hpColor = '#2b8a3e';
    if (hpPct < 20) hpColor = '#cc3333';
    else if (hpPct < 50) hpColor = '#d9a711';
    let isCarcass = e.utype === 'sheep_carcass';
    // Same classic-vs-mobile HP routing as the building card above:
    // classic = portrait-width bar with numbers beneath, mobile = text + bar.
    let hpBlock = isClassicUI
      ? `<div class="hp-bar-bg"><div class="hp-bar-fill" style="width: ${hpPct}%; background-color: ${isCarcass ? '#e2b13c' : hpColor};"></div></div><div class="hp-num">${isCarcass ? 'Food ' : ''}${e.hp}/${e.maxHp}</div>`
      : (isCarcass ? `Food remaining: ${e.hp}/${e.maxHp}` : `HP: ${e.hp}/${e.maxHp}`)
        +`<div class="hp-bar-bg"><div class="hp-bar-fill" style="width: ${hpPct}%; background-color: ${isCarcass ? '#e2b13c' : hpColor};"></div></div>`;
    setSelHp(isClassicUI ? hpBlock : '');
    let det = isClassicUI ? '' : hpBlock;

    // Display combat stats for military units
    let uData = UNITS[e.utype];
    if (uData && e.utype !== 'sheep' && e.utype !== 'sheep_carcass') {
      // Combat numbers get their own class: the mobile skin hides them
      // (.sel-combat-stats{display:none} in styles.css — space is tight and
      // the long-press/hover tooltips carry the same numbers), while the
      // job/carrying/idle status icons after them stay visible everywhere.
      let combat = unitStatChips(uData, isClassicUI);
      let stats = [];
      if (combat.length) stats.push(`<span class="sel-combat-stats">${combat.map(c=>`<span class="stat-chip">${c}</span>`).join('')}</span>`);
      // Job shown purely as resource icon + carried amount, on the stats row
      // after the walk rate: [wood]0 = lumberjack heading out, [wood]7 =
      // hauling 7 wood. The resource comes from the task when the hands are
      // empty. Builders get 🔨 (no resource), idle villagers 💤.
      let resType=e.carrying>0?e.carryType:TASK_RES[e.task];
      // Sheep work is target-driven (no task): a villager killing or
      // butchering a sheep is on food duty — show [food] with the live count.
      if(!resType && e.target){
        let tgt=entitiesById.get(e.target);
        if(tgt&&(tgt.utype==='sheep'||tgt.utype==='sheep_carcass'))resType='food';
      }
      // Status entries are .stat-chips too (classic renders every chip as
      // its own recessed tile; mobile keeps the compact icon-only look —
      // the word labels are classic-only).
      if(resType){
        stats.push(`<span class="stat-chip" title="${resType}: carrying ${e.carrying}"><span class="res-mini-icon icon-${resType}"></span>${isClassicUI?'Carrying ':''}${e.carrying}</span>`);
      } else if(e.task==='build') stats.push(`<span class="stat-chip" title="Building">🔨${isClassicUI?' Building':''}</span>`);
      else if(e.task==='garrison') stats.push(`<span class="stat-chip" title="Running to shelter">🏰${isClassicUI?' Sheltering':''}</span>`);
      else if(e.utype==='villager' && !e.task && !e.target && e.path.length===0) stats.push(`<span class="stat-chip" title="Idle">💤${isClassicUI?' Idle':''}</span>`);
      det += `<div class="det-stats">${stats.join('')}</div>`;
    }

    document.getElementById('sel-details').innerHTML=det;

    // The build menu requires EVERY selected unit to be a buildable-capable
    // villager, not just selected[0] — AoE2 only offers an action when all
    // selected units share it (select a villager + a scout together and you
    // get no build/train options at all, only the commands both can do).
    // Gating on just e here would show "Build Economic/Military" for a
    // mixed villager+scout selection merely because the villager happened
    // to be first in the array.
    // Auto Scout toggle — shown only when the selection is all own scouts. The
    // explore/stop glyph differs so the on/off state reads even in the classic
    // skin (which hides button labels). Command is deterministic (js/commands.js).
    // Guard Position — any all-military selection (mixed types included,
    // AoE2-style): tap the flag button, then tap the map; the units hold
    // that spot, leash their chases to it, and walk back after fights.
    // Reuses the rally flag sprite — it IS a flag-the-ground order, just
    // for units instead of a building. execGuard (js/commands.js) runs it
    // deterministically; a manual order cancels, like Auto Scout.
    if(rebuildActions && allGuardable(selected)){
      if(window.settingGuard){
        let btn=document.createElement('div');btn.className='act-btn rally-btn';
        btn.dataset.tipType='action';
        btn.dataset.tipLabel='Cancel Guard';
        btn.dataset.tipDesc='Click to stop setting the guard position.';
        btn.innerHTML=`<div class="btn-emoji sprite-icon icon-rally"></div><div class="btn-label">Tap map to<br>guard</div>`;
        btn.onclick=()=>{ window.settingGuard=false; showMsg('Guard cancelled'); updateUI(); };
        act.appendChild(btn);
      } else {
        let btn=document.createElement('div');btn.className='act-btn';
        btn.dataset.tipType='action';
        btn.dataset.tipLabel='Guard';
        btn.dataset.tipDesc='Tap ground to hold that spot, a building to stand watch there, or one of your units to escort it. Guards chase enemies only a short way and return to their post; a plain move order relocates the post. New units guard their rally flag automatically.';
        btn.innerHTML=`<div class="btn-emoji sprite-icon icon-rally"></div><div class="btn-label">Guard</div>`;
        btn.onclick=()=>{ if(gameOver)return; window.settingGuard=true; showMsg('Tap the map to set guard position'); updateUI(); };
        act.appendChild(btn);
      }
    }

    // Auto Scout — no Stop button: any manual order (just send the scout
    // somewhere) already cancels it, so the button only shows while at
    // least one selected scout ISN'T auto-scouting yet.
    let allScouts = selected.length>0 && selected.every(s=>s.type==='unit'&&s.utype==='scout'&&s.team===myTeam);
    if(rebuildActions&&allScouts&&selected.some(s=>!s.autoScout)){
      let ids = selected.map(s=>s.id);
      let btn=document.createElement('div');btn.className='act-btn';
      btn.dataset.tipType='action';
      btn.dataset.tipLabel = 'Auto Scout';
      btn.dataset.tipDesc = 'The scout automatically explores unmapped areas and avoids fights. To stop it, just order it somewhere.';
      btn.innerHTML=`<div class="btn-emoji sprite-icon icon-compass"></div><div class="btn-label">Auto Scout</div>`;
      btn.onclick=()=>{ if(gameOver)return; submitCommand({kind:'auto-scout',unitIds:ids,on:true}); deselectAfterTask(); };
      act.appendChild(btn);
    }
    let allVillagers = selected.every(s=>s.type==='unit'&&s.utype==='villager'&&s.team===myTeam);
    if(rebuildActions&&allVillagers){
      window.currentVillagerMenu = window.currentVillagerMenu || 'main';

      if (window.currentVillagerMenu === 'main') {
        // Main Building Menus
        const menuButtonDefs = [
          { name: 'Build Economic', key: 'Q', iconClass: 'icon-econ', action: 'eco',
            tipLabel: 'Economic Buildings', tipDesc: 'Build resource drop sites, mills, houses, and farms.' },
          { name: 'Build Military', key: 'W', iconClass: 'icon-mil', action: 'mil',
            tipLabel: 'Military Buildings', tipDesc: 'Build barracks to train soldiers and towers to defend your base.' }
        ];
        menuButtonDefs.forEach(bi => {
          let btn=document.createElement('div');btn.className='act-btn menu-btn framed';
          btn.dataset.tipType='action';
          btn.dataset.tipLabel=bi.tipLabel;
          btn.dataset.tipDesc=bi.tipDesc;
          btn.innerHTML=`<div class="btn-emoji sprite-icon ${bi.iconClass}"></div><div class="btn-label">${bi.name}</div><span class="cost">[${bi.key}]</span>`;
          btn.onclick=()=>{
            if(gameOver)return;
            window.currentVillagerMenu = bi.action;
            updateUI();
          };
          act.appendChild(btn);
        });
      } else if (window.currentVillagerMenu === 'eco') {
        // (No submenu Back button — the global leftmost return arrow steps
        // back to the main panel; see the "Back" button at the top of
        // updateUI.)

        // Economic Sub-Menu
        // Ordered by importance: pop cap first, then food, then the drop
        // sites. TC deliberately hidden for now (rebuild-a-TC may return
        // later — the placement path still supports it).
        let builds=[
          {type:'HOUSE',label:'House',key:'Q'},
          {type:'FARM',label:'Farm',key:'W'},
          {type:'LCAMP',label:'Lumber Camp',key:'E'},
          {type:'MILL',label:'Mill',key:'R'},
          {type:'MCAMP',label:'Mining Camp',key:'T'},
          {type:'MARKET',label:'Market',key:'Y'} // Feudal-gated; hidden until then by the filter below
        ].filter(bi=>isUnlocked(myTeam,bi.type)); // future-proofed via AGE_REQ
        builds.forEach(bi=>{
          let btn=document.createElement('div');btn.className='act-btn';
          btn.dataset.tipType='building';
          btn.dataset.tipKey=bi.type;
          let bData=BLDGS[bi.type];
          btn.dataset.cost=JSON.stringify(bData.cost);
          let costStr=formatCost(bData.cost);
          // Buildings without a sprites.png cell (MARKET) fall back to their
          // emoji glyph — same rule as the train buttons above.
          let bIcon=SPRITE_ICON_KEYS.has(iconKey(bi.type))
            ?`<div class="btn-emoji sprite-icon icon-${iconKey(bi.type)}"></div>`
            :`<div class="btn-emoji">${bData.icon||''}</div>`;
          btn.innerHTML=`${bIcon}<div class="btn-label">${bi.label}</div>${costChips(bData.cost)}`;
          btn.onclick=()=>{
            if(gameOver)return;
            placing=bi.type;
            showMsg((isMobile?'Tap':'Click')+' to place '+bi.label);
          };
          act.appendChild(btn);
        });
      } else if (window.currentVillagerMenu === 'mil') {
        // (No submenu Back button — the global leftmost return arrow steps
        // back to the main panel; see the "Back" button at the top of
        // updateUI.)

        // Military Sub-Menu
        // Locked entries are hidden. Once Feudal unlocks stone, E/R become the
        // Stone Wall/Gate — but palisade (wood) stays buildable in EVERY age
        // (AoE2: cheap 2-wood, fast, never removed), so it's kept as separate
        // trailing entries (T/Y) rather than being hidden behind stone.
        let builds=[
          {type:'BARRACKS',label:'Barracks',key:'Q'}
        ];
        // W = best unlocked tower (same convention as E/R walls): the stone
        // Watch Tower takes the slot at Feudal, the wooden Palisade Watch
        // Tower stays buildable in every age on a trailing key.
        if(isUnlocked(myTeam,'TOWER')){
          builds.push({type:'TOWER',label:'Watch Tower',key:'W'});
        } else {
          builds.push({type:'PTOWER',label:'Palisade Tower',key:'W'});
        }
        if(isUnlocked(myTeam,'SWALL')){
          builds.push({type:'SWALL',label:'Stone Wall',key:'E'});
          builds.push({type:'SGATE',label:'Stone Gate',key:'R'});
          builds.push({type:'WALL',label:'Palisade',key:'T'});
          builds.push({type:'GATE',label:'Palisade Gate',key:'Y'});
        } else {
          builds.push({type:'WALL',label:'Palisade',key:'E'});
          builds.push({type:'GATE',label:'Palisade Gate',key:'R'});
        }
        if(isUnlocked(myTeam,'TOWER')){
          builds.push({type:'PTOWER',label:'Palisade Tower',key:'U'});
        }
        builds=builds.filter(bi=>isUnlocked(myTeam,bi.type));
        builds.forEach(bi=>{
          let btn=document.createElement('div');btn.className='act-btn';
          btn.dataset.tipType='building';
          btn.dataset.tipKey=bi.type;
          let bData=BLDGS[bi.type];
          btn.dataset.cost=JSON.stringify(bData.cost);
          let costStr=formatCost(bData.cost);
          btn.innerHTML=`<div class="btn-emoji sprite-icon icon-${iconKey(bi.type)}"></div><div class="btn-label">${bi.label}</div>${costChips(bData.cost)}`;
          btn.onclick=()=>{
            if(gameOver)return;
            placing=bi.type;
            showMsg((isMobile?'Tap':'Click')+' to place '+bi.label);
          };
          act.appendChild(btn);
        });
      }
    }
  }

  // One bar, one divider: actions left, selection right. The selection card
  // grows with its tile count (styles.css caps it at the bar minus one
  // action-button slot); when the strip has NO real buttons — the back
  // arrow is corner-docked, not a strip occupant — this class lifts the cap
  // and the card may take the whole bar.
  {
    let actEl = document.getElementById('actions');
    let barEl = document.getElementById('bottom');
    if (actEl && barEl) barEl.classList.toggle('no-actions', !actEl.querySelector(':scope > *:not(.back-btn)'));
  }

  refreshActionAffordability();
}

// Grey out action buttons whose cost can't currently be paid. Runs on every
// dirty updateUI pass (resource totals are part of the dirty check), so
// buttons wake up the moment the resources come in — no rebuild needed.
function refreshActionAffordability(){
  document.querySelectorAll('#actions .act-btn[data-cost], .mkt-cell[data-cost]').forEach(btn=>{
    let cost;
    try{ cost=JSON.parse(btn.dataset.cost); }catch(_){ return; }
    btn.classList.toggle('disabled', !canAfford(myTeam,cost));
  });

}
// Swallow clicks on disabled buttons before their own onclick fires.
document.getElementById('actions').addEventListener('click', function(e){
  let btn = e.target.closest && e.target.closest('.act-btn.disabled, .mkt-cell.disabled');
  if(btn){
    e.stopPropagation();
    e.preventDefault();
    showMsg('Not enough resources!');
    if (window.playSound) playSound('error');
  }
}, true);

// Desktop swipe: drag anywhere on the actions bar to scroll it horizontally
// (touch devices scroll natively via overflow-x). A drag past a small
// threshold suppresses the click that would otherwise fire on the button
// under the cursor when the mouse is released.
(function(){
  let bar=document.getElementById('actions');
  if(!bar||!bar.addEventListener)return;
  let dragging=false,dragMoved=false,startX=0,startScroll=0;
  bar.addEventListener('mousedown',e=>{
    dragging=true;dragMoved=false;startX=e.clientX;startScroll=bar.scrollLeft;
  });
  window.addEventListener('mousemove',e=>{
    if(!dragging)return;
    let dx=e.clientX-startX;
    if(Math.abs(dx)>5)dragMoved=true;
    if(dragMoved)bar.scrollLeft=startScroll-dx;
  });
  window.addEventListener('mouseup',()=>{dragging=false;});
  bar.addEventListener('click',e=>{
    if(dragMoved){e.stopPropagation();e.preventDefault();dragMoved=false;}
  },true);
  // Mouse wheel scrolls the bar horizontally too.
  bar.addEventListener('wheel',e=>{
    if(bar.scrollWidth>bar.clientWidth){
      bar.scrollLeft+=(e.deltaX||e.deltaY);
      e.preventDefault();
    }
  },{passive:false});
})();

// Resolver only — the queueUnit mutation is execTrainUnit (js/commands.js),
// run at the scheduled tick for both roles.
function trainUnit(bldg,utype){
  if(gameOver)return;
  submitCommand({ kind: 'train-unit', bldgId: bldg.id, utype });
}

// Resolver only — mutation is execCancelQueue (js/commands.js).
function cancelQueue(bldgId,idx){
  if(gameOver)return;
  submitCommand({ kind: 'cancel-queue', bldgId, idx });
}

function showMsg(txt){
  if (window.__resim) return; // rollback resim replays past ticks silently (js/lockstep.js)
  let el=document.getElementById('msg');el.textContent=txt;el.style.opacity='1';
  // The help hint shares the same screen spot — yield to the message
  let hint=document.getElementById('help-hint');
  if(hint)hint.style.opacity='0';
  // Cancel the previous message's hide timer, or a message shown ~1.9s
  // after another gets hidden almost immediately by the stale timer.
  clearTimeout(window._msgTimer);
  window._msgTimer=setTimeout(()=>el.style.opacity='0',2000);
}


window.toggleTownBell = function() {
  if (gameOver || !gameStarted) return;
  // Executed by execCommand's 'town-bell' case (js/commands.js) with this
  // client's team at the scheduled tick.
  submitCommand({ kind: 'town-bell', ringing: !myBellActive() });
};

// "Never mind" — cancels one level at a time (Escape-style), since fully
// deselecting a villager just because you changed your mind about which
// building to place is more disruptive than helpful:
//   1. Actively placing a building → just cancel the placement, keep the
//      villager(s) selected so they can pick something else.
//   2. Targeting a rally point → just cancel that, keep selection.
//   3. Browsing the eco/mil build submenu → back out to the main villager
//      panel, keep selection.
//   4. Nothing pending → fully deselect.
window.deselectAll = function() {
  if (placing) {
    placing = null;
  } else if (window.settingRally) {
    window.settingRally = false;
  } else if (window.settingGuard) {
    window.settingGuard = false;
  } else if (window.currentVillagerMenu === 'eco' || window.currentVillagerMenu === 'mil') {
    window.currentVillagerMenu = 'main';
  } else {
    selected = [];
    window.currentVillagerMenu = 'main';
  }
  updateUI();
};

window.selectIdleVillager = function() {
  if (gameOver || !gameStarted) return;
  let idleVils = entities.filter(e => e.team === myTeam && e.type === 'unit' && e.utype === 'villager' && !e.task && !e.target && !e.garrisonedIn && e.path.length === 0);
  if (idleVils.length === 0) {
    showMsg('No idle villagers!');
    return;
  }
  
  window.lastIdleVilIndex = window.lastIdleVilIndex || 0;
  let vil = idleVils[window.lastIdleVilIndex % idleVils.length];
  window.lastIdleVilIndex++;
  
  selected = [vil];
  
  // Center camera
  let iso = toIso(vil.x, vil.y);
  camX = iso.ix;
  camY = iso.iy;
  window.targetCamX = camX;
  window.targetCamY = camY;
  // Manual camera jump should release camera-follow, same as any other
  // manual pan — otherwise handleScroll() snaps straight back next frame.
  window.cameraFollowId = null;

  if (window.playSound) window.playSound('select_villager');
  showMsg('Selected idle villager');
  updateUI();
};

// ',' hotkey — AoE2's idle-military cycle, the army-side twin of
// selectIdleVillager above. "Idle" = no target, no task, standing still.
window.selectIdleMilitary = function() {
  if (gameOver || !gameStarted) return;
  let mil = entities.filter(e => e.team === myTeam && e.type === 'unit' && !e.garrisonedIn &&
    isArmyUnit(e.utype) &&
    !e.task && !e.target && e.path.length === 0);
  if (mil.length === 0) { showMsg('No idle soldiers!'); return; }
  window.lastIdleMilIndex = window.lastIdleMilIndex || 0;
  let u = mil[window.lastIdleMilIndex % mil.length];
  window.lastIdleMilIndex++;
  selected = [u];
  let iso = toIso(u.x, u.y);
  camX = iso.ix; camY = iso.iy;
  window.targetCamX = camX; window.targetCamY = camY;
  window.cameraFollowId = null;
  if (window.playSound) window.playSound('select_military');
  showMsg('Selected idle soldier');
  updateUI();
};

// (isClassicUI is declared once at the top of this file.)
// Short landscape viewport (landscape phone OR a tiny desktop window): the
// HUD moves from a bottom bar to a LEFT VERTICAL RAIL (see the matching
// @media (orientation: landscape) and (max-height:500px) block in
// styles.css — keep the two conditions aligned). Height is the scarce
// dimension in landscape; the rail costs abundant width instead. Not gated
// on isMobile: a desktop window squeezed short has the same problem.
window.isMobileLandscape = function() {
  return !isClassicUI
    && window.innerWidth > window.innerHeight && window.innerHeight <= 500;
};

window.updateBottomHeight = function() {
  let w = window.innerWidth;
  // The classic layout wraps its action buttons into a real 3-row grid
  // (see classic-style.css) instead of the mobile skin's single scrolling
  // row, so it needs a taller bar to fit them — not width-responsive since
  // classic isn't trying to support small screens. 174 = 3 rows × 52px
  // + 2 × 3px gaps + 2 × 6px #actions padding.
  bottomH = isClassicUI ? 174 : (isMobile ? (w <= 380 ? 90 : 96) : 80);
  topH = isMobile ? (w <= 600 ? 46 : 36) : 36;
  // Landscape rail overlays the canvas' LEFT edge — there is no bottom bar
  // at all, so the world gets the full height below the topbar. No
  // horizontal inset is introduced on purpose: the engine has no left/right
  // HUD concept (world centered at W/2 everywhere), players pan freely, and
  // a slight auto-center bias under the rail is a fine trade for not
  // touching every screen-projection site.
  if (window.isMobileLandscape()) {
    bottomH = 0;
    topH = 36;
  }
  H = window.innerHeight - bottomH;
  W = w;
  
  let C = document.getElementById('game');
  if (C) {
    let X = C.getContext('2d');
    // Use the GLOBAL dpr (js/core.js) — it caps at 2x on mobile for render
    // cost; a raw devicePixelRatio here silently undid that cap on every
    // resize/rotate (this function runs at load too).
    C.width = W * dpr;
    C.height = window.innerHeight * dpr;
    C.style.width = W + 'px';
    C.style.height = window.innerHeight + 'px';
    if (X) X.scale(dpr, dpr);
  }
  // Exposes the current bar heights to CSS. Only classic-style.css reads
  // these (to size/place the corner minimap against the real bar height
  // instead of a hardcoded duplicate number) — inert on the default page.
  document.documentElement.style.setProperty('--bottom-h', bottomH + 'px');
  document.documentElement.style.setProperty('--top-h', topH + 'px');
};

window.updateBottomHeight();

function prepayFarm() {
  if (gameOver) return;
  // Never mutate directly — out-of-band writes desync lockstep peers
  // (same rule as the Delete key). This one spends resources and
  // increments a counter with no unit/building reference needed at all.
  submitCommand({ kind: 'prepay-farm' }); // mutation: prepayFarmNow (js/commands.js)
}

function reactivateFarm(farm) {
  if (gameOver) return;
  if (!farm.exhausted) return;
  submitCommand({ kind: 'reactivate-farm', bldgId: farm.id }); // mutation: reactivateFarmNow (js/commands.js)
}

// Cancel one banked reseed (classic queue-slot click) — refunds 60 wood, like
// cancelling a queued unit. Mutation: cancelReseedNow (js/commands.js).
function cancelReseed() {
  if (gameOver) return;
  submitCommand({ kind: 'cancel-reseed' });
}

window.prepayFarm = prepayFarm;
window.reactivateFarm = reactivateFarm;
window.cancelReseed = cancelReseed;

// ==============================
// ---- HOVER TOOLTIP SYSTEM ----
// ==============================
// Desktop-only. Suppressed entirely on touch devices.
// Shows rich info (name, desc, HP, stats, cost) for:
//   • Action buttons (.act-btn) in the bottom panel
//   • Units and buildings hovered on the game canvas
// ==============================

(function() {
  const TIP = document.getElementById('tooltip');
  if (!TIP) return;

  // Resource key → human-readable label
  const RES_LABEL = { f: 'Food', w: 'Wood', g: 'Gold', s: 'Stone' };

  // Build the inner HTML for a tooltip given a data descriptor object:
  //   { name, desc?, hp?, maxHp?, stats?, cost? }
  function buildTipHTML(d) {
    let html = `<div class="tip-name">${d.name}</div>`;
    if (d.desc) html += `<div class="tip-desc">${d.desc}</div>`;

    // Stats line (attack, range, speed…)
    if (d.stats && d.stats.length) {
      html += `<div class="tip-stats">${d.stats.join('  ')}</div>`;
    }

    // HP bar
    if (d.hp != null && d.maxHp != null) {
      const pct = Math.max(0, Math.min(100, Math.floor(d.hp / d.maxHp * 100)));
      const col = pct < 20 ? '#cc3333' : pct < 50 ? '#d9a711' : '#2b8a3e';
      html += `<div class="tip-hp-bar"><div class="tip-hp-fill" style="width:${pct}%;background:${col};"></div></div>`;
      html += `<div style="font-size:10px;color:#d1c499;">HP: ${d.hp}/${d.maxHp}</div>`;
    }

    // Cost breakdown with resource icons
    if (d.cost) {
      const entries = Object.entries(d.cost);
      if (entries.length) {
        html += '<div class="tip-cost">';
        entries.forEach(([k, v]) => {
          // k may be short ('f','w','g','s') or full ('food','wood','gold','stone')
          let shortKey = k;
          if (k === 'food') shortKey = 'f';
          else if (k === 'wood') shortKey = 'w';
          else if (k === 'gold') shortKey = 'g';
          else if (k === 'stone') shortKey = 's';
          const resName = RES_LABEL[shortKey] || k;
          // Map to sprite icon class
          const iconClass = {f:'food',w:'wood',g:'gold',s:'stone'}[shortKey] || shortKey;
          html += `<div class="tip-cost-row">` +
            `<span class="tip-cost-icon icon-${iconClass}"></span>` +
            `<span class="tip-cost-label">${resName}: <b>${v}</b></span>` +
            `</div>`;
        });
        html += '</div>';
      }
    }
    return html;
  }

  // Position the tooltip against the hovered BUTTON's rect — never over it.
  // The old version chased the cursor with a fixed offset and flipped over
  // it near the viewport edges, which is exactly where the buttons live —
  // so the flipped tooltip landed on top of the very button being hovered.
  // Anchored placement: centered above the button, flipping below when
  // there's no room above, clamped inside the viewport horizontally.
  function positionTip(el) {
    const GAP = 8;
    const r = el.getBoundingClientRect();
    const tw = TIP.offsetWidth || 220;
    const th = TIP.offsetHeight || 80;
    const vw = window.innerWidth;

    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(4, Math.min(left, vw - tw - 4));

    let top = r.top - th - GAP;       // prefer above the button
    if (top < 4) top = r.bottom + GAP; // no room: below it

    TIP.style.left = left + 'px';
    TIP.style.top  = top  + 'px';
  }

  function showTip(html, el) {
    TIP.innerHTML = html;
    TIP.classList.add('visible');
    positionTip(el);
  }

  function hideTip() {
    TIP.classList.remove('visible');
  }

  // ---- Action button hover: show unit/building being trained or placed ----
  // Delegated listener on #bottom catches all .act-btn children even after
  // updateUI() rebuilds them. Tooltip content is driven entirely by data
  // attributes (tipType, tipKey, tipLabel, tipDesc) set on each button.

  // Build the tooltip descriptor for an .act-btn from its data attributes
  // (desktop hover; mobile long-press inspection was tried and removed —
  // the release-tap suppression interfered with normal button taps).
  // Returns null when the button carries no tip.
  function descriptorForActBtn(el) {
    const tipType  = el.dataset.tipType;   // 'unit' | 'building' | 'action'
    const tipKey   = el.dataset.tipKey;    // utype or btype key
    const tipLabel = el.dataset.tipLabel;  // plain-text label for 'action' type
    const tipDesc  = el.dataset.tipDesc;   // plain-text description for 'action' type

    if (!tipType) return null;

    let d = null;
    if (tipType === 'unit') {
      const u = UNITS[tipKey];
      if (!u) return null;
      const stats = [`❤️ ${u.hp}`, ...unitStatChips(u)];
      d = { name: u.name, desc: u.desc || null, stats, cost: u.cost };
    } else if (tipType === 'building') {
      const b = BLDGS[tipKey];
      if (!b) return null;
      const stats = [`❤️ ${b.hp}`];
      const arrows = buildingArrowStats(tipKey);
      if (arrows) stats.push(`⚔️ ${arrows.atk}`, `🏹 ${arrows.range}`);
      if (b.armor && (b.armor.m > 0 || b.armor.p > 0)) stats.push(`🛡️ ${b.armor.m}/${b.armor.p}`);
      d = { name: b.name, desc: b.desc || null, stats, cost: b.cost };
    } else if (tipType === 'action') {
      // Plain action buttons (rally, eco/mil menu, back, reseed, reactivate)
      let cost = null;
      try { cost = el.dataset.tipCost ? JSON.parse(el.dataset.tipCost) : null; } catch(_) {}
      d = { name: tipLabel || '', desc: tipDesc || null, cost };
    }
    return d;
  }

  // Selection tiles carry the CLASSIC skin's full readout in their hover
  // tooltip — live HP, combat stats, and a villager's current job —
  // resolved from the tile's entity ids at hover time, so the numbers are
  // current even though the tile itself only shows an icon + HP strip.
  function descriptorForSelTile(el) {
    const name = el.dataset.tipName || '';
    const desc = el.dataset.tipDesc || null;
    const ids = (el.dataset.tileIds || '').split(',').filter(Boolean).map(Number);
    const members = ids.map(id => entitiesById.get(id)).filter(m => m && m.hp > 0);
    if (!members.length) return name ? { name, desc } : null;
    const e = members[0];
    const d = { name, desc, stats: [] };
    d.hp = members.length === 1 ? Math.ceil(e.hp)
      : Math.round(members.reduce((s, m) => s + m.hp, 0) / members.length);
    d.maxHp = e.maxHp;
    if (e.type === 'unit') {
      const u = UNITS[e.utype];
      if (u) d.stats.push(...unitStatChips(u));
      if (members.length === 1 && e.utype === 'villager') {
        // Same icon+count chip the classic card uses ([wood] 7), not prose —
        // buildTipHTML injects stats as HTML, so the sprite chip just works.
        let rt = e.carrying > 0 ? e.carryType : TASK_RES[e.task];
        if (rt) d.stats.push(`<span class="res-mini-icon icon-${rt}"></span> ${e.carrying || 0}`);
        else if (e.task === 'build') d.stats.push('🔨 building');
        else if (!e.task && !e.target && e.path.length === 0) d.stats.push('💤 idle');
      }
    } else if (e.type === 'building') {
      const b = BLDGS[e.btype];
      const arrows = buildingArrowStats(e.btype);
      if (arrows) d.stats.push(`⚔️ ${arrows.atk}`, `🏹 ${arrows.range}`);
      if (b && b.armor && (b.armor.m > 0 || b.armor.p > 0)) d.stats.push(`🛡️ ${b.armor.m}/${b.armor.p}`);
      if (e.complete && garrisonCap(e) > 0) d.stats.push(`Garrison ${garrisonCount(e)}/${garrisonCap(e)}`);
      if (!e.complete && !e.exhausted) d.stats.push(`Building ${Math.floor(e.buildProgress / e.buildTime * 100)}%`);
    }
    return d;
  }

  document.getElementById('bottom').addEventListener('mouseover', function(e) {
    if (typeof recentTouch === 'function' && recentTouch()) { hideTip(); return; }

    // Dispatch on the DATA, not on a class list: any element that carries
    // tip dataset attributes gets a tooltip (act-btns, selection tiles,
    // market cells, whatever comes next) — a hardcoded class walk silently
    // orphaned the market cells' fully-authored tooltips.
    let el = e.target.closest && e.target.closest('[data-tile-ids],[data-tip-name],[data-tip-type]');
    if (!el || !this.contains(el)) { hideTip(); return; }

    const d = (el.dataset.tileIds != null || el.dataset.tipName != null)
      ? descriptorForSelTile(el)
      : descriptorForActBtn(el);
    if (d) showTip(buildTipHTML(d), el);
    else hideTip();
  });

  document.getElementById('bottom').addEventListener('mouseout', function(e) {
    // Only hide when leaving #bottom entirely (not just moving between children)
    if (!this.contains(e.relatedTarget)) hideTip();
  });

  // ---- Top-bar & menu button hover: plain label/desc tooltips ----
  // Same rich tooltip as action buttons, driven by data-tip-label/-desc set
  // either statically in index.html (map/home/menu) or dynamically in
  // updateUI() (bell/idle).
  function attachSimpleTips(container) {
    if (!container) return;
    container.addEventListener('mouseover', function(e) {
      if (typeof recentTouch === 'function' && recentTouch()) { hideTip(); return; }
      let el = e.target;
      while (el && el !== this.parentElement) {
        if (el.dataset && el.dataset.tipLabel) break;
        el = el.parentElement;
      }
      if (!el || !el.dataset || !el.dataset.tipLabel) { hideTip(); return; }
      showTip(buildTipHTML({ name: el.dataset.tipLabel, desc: el.dataset.tipDesc || null }), el);
    });
    container.addEventListener('mouseout', function(e) {
      if (!this.contains(e.relatedTarget)) hideTip();
    });
  }
  attachSimpleTips(document.getElementById('pop-wrap'));
  attachSimpleTips(document.getElementById('menu-btn'));
  attachSimpleTips(document.getElementById('fs-btn'));
  attachSimpleTips(document.getElementById('chat-btn'));

})();
