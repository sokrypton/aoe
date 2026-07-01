// Sprite sheet (sprites.png) covers every BLDGS/UNITS key directly (class
// names match btype/utype: icon-TC, icon-villager, etc). Anything else
// (no selection, cancel-only actions) falls back to the emoji glyph.
const SPRITE_ICON_KEYS = new Set(['villager','militia','spearman','archer','scout','sheep',
  'TC','HOUSE','LCAMP','MCAMP','MILL','FARM','BARRACKS','TOWER','WALL','GATE']);
function setPortraitIcon(port, key, fallbackEmoji){
  [...port.classList].filter(c=>c==='sprite-icon'||c.startsWith('icon-')).forEach(c=>port.classList.remove(c));
  if (SPRITE_ICON_KEYS.has(key)) {
    port.textContent='';
    port.classList.add('sprite-icon','icon-'+key);
  } else {
    port.textContent = fallbackEmoji || '';
  }
}

function updateUI(){
  let currentFood = Math.floor(res.food);
  let currentWood = Math.floor(res.wood);
  let currentGold = Math.floor(res.gold);
  let currentStone = Math.floor(res.stone);
  
  // Calculate idle villagers count
  let idleVils = entities.filter(e => e.team === 0 && e.type === 'unit' && e.utype === 'villager' && !e.task && !e.target && e.path.length === 0);
  let currentIdleCount = idleVils.length;
  
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
    if (e.queue) {
      currentSelectionDetails += `:${e.queue.length}:${Math.floor(e.trainTick)}`;
    }
    if (e.task) {
      currentSelectionDetails += `:${e.task}:${e.resCarrying || 0}:${e.targetId || 0}`;
    }
    let b = BLDGS[e.btype];
    if (b && b.isFarm) {
      let tr = (map[e.y] && map[e.y][e.x]) ? map[e.y][e.x].res : 0;
      currentSelectionDetails += `:${tr}`;
    }
    // Include camera-lock state so toggling it (which changes no other
    // tracked field) still passes the dirty-state check below and refreshes
    // the '.cam-locked' portrait indicator immediately.
    currentSelectionDetails += `:cam${window.cameraFollowId === e.id ? 1 : 0}`;
  }

  // Initialize dirty state tracker if not present
  if (!window.lastUIState) {
    window.lastUIState = {
      food: -1, wood: -1, gold: -1, stone: -1,
      popUsed: -1, popCap: -1, idleCount: -1,
      gameOver: null, gameStarted: null, selectedKey: null,
      selectionDetails: null, placing: null, currentVillagerMenu: null
    };
  }

  let lu = window.lastUIState;
  let stateChanged = (
    currentFood !== lu.food || currentWood !== lu.wood ||
    currentGold !== lu.gold || currentStone !== lu.stone ||
    popUsed !== lu.popUsed || popCap !== lu.popCap ||
    currentIdleCount !== lu.idleCount || gameOver !== lu.gameOver ||
    gameStarted !== lu.gameStarted || currentSelListKey !== lu.selectedKey ||
    currentSelectionDetails !== lu.selectionDetails || placing !== lu.placing ||
    window.currentVillagerMenu !== lu.currentVillagerMenu
  );

  if (!stateChanged) return;

  // Update cached state
  lu.food = currentFood;
  lu.wood = currentWood;
  lu.gold = currentGold;
  lu.stone = currentStone;
  lu.popUsed = popUsed;
  lu.popCap = popCap;
  lu.idleCount = currentIdleCount;
  lu.gameOver = gameOver;
  lu.gameStarted = gameStarted;
  lu.selectedKey = currentSelListKey;
  lu.selectionDetails = currentSelectionDetails;
  lu.placing = placing;
  lu.currentVillagerMenu = window.currentVillagerMenu;

  // Perform actual DOM updates
  document.getElementById('r-food').textContent=currentFood;
  document.getElementById('r-wood').textContent=currentWood;
  document.getElementById('r-gold').textContent=currentGold;
  document.getElementById('r-stone').textContent=currentStone;
  document.getElementById('pop').textContent=`${popUsed}/${popCap}`;

  let idleBtn = document.getElementById('idle-vil-btn');
  if (idleBtn) {
    document.getElementById('idle-vil-count').textContent = currentIdleCount;
    if (currentIdleCount > 0) {
      idleBtn.classList.add('idle-active');
    } else {
      idleBtn.classList.remove('idle-active');
    }
  }

  let act=document.getElementById('actions');
  let selKey=currentSelListKey+':'+placing+':'+(window.currentVillagerMenu||'main');
  let rebuildActions=selKey!==lastSelKey;
  lastSelKey=selKey;
  if(rebuildActions)act.innerHTML='';

  let port = document.getElementById('sel-portrait');
  if(gameOver){
    if (port) { port.textContent = won ? '🏆' : '💀'; port.classList.remove('cam-locked'); }
    document.getElementById('sel-name').textContent=won?'VICTORY!':'DEFEAT!';
    document.getElementById('sel-details').textContent=won?'You destroyed the enemy Town Center!':'Your Town Center was destroyed!';
    return;
  }
  if(!gameStarted){
    if (port) { setPortraitIcon(port, null, '⚔️'); port.classList.remove('cam-locked'); }
    document.getElementById('sel-name').textContent='Choose Difficulty';
    document.getElementById('sel-details').textContent='Select Easy, Standard, or Hard to begin';
    return;
  }

  if(selected.length===0){
    if (port) { setPortraitIcon(port, null, '⚔️'); port.classList.remove('cam-locked'); }
    document.getElementById('sel-name').textContent='AoE II Mini';
    if(isMobile){
      document.getElementById('sel-details').textContent='Tap: select unit/building\nWith units selected, tap map\nto move/gather/attack\nDrag to pan camera';
    } else {
      document.getElementById('sel-details').textContent='Left-click: select\nRight-click: command\nDrag: box select | WASD: scroll';
    }
    return;
  }
  let e=selected[0];
  if(e.type==='building'){
    let b=BLDGS[e.btype];
    if (port) { setPortraitIcon(port, e.btype, b.icon); port.classList.remove('cam-locked'); }
    document.getElementById('sel-name').textContent=b.name;
    let hpPct = Math.max(0, Math.min(100, Math.floor(e.hp / e.maxHp * 100)));
    let hpColor = '#2b8a3e';
    if (hpPct < 20) hpColor = '#cc3333';
    else if (hpPct < 50) hpColor = '#d9a711';
    let det=`HP: ${e.hp}/${e.maxHp}`;
    det+=`<div class="hp-bar-bg"><div class="hp-bar-fill" style="width: ${hpPct}%; background-color: ${hpColor};"></div></div>`;
    if(!e.complete && !e.exhausted) det+=`<br>Building: ${Math.floor(e.buildProgress/e.buildTime*100)}%`;
    else {
      if(b.pop) det+=`<br>Provides ${b.pop} population`;
      else if(b.drop) {
        det+=`<br>Dropoff: ${b.drop}`;
        if (e.btype === 'MILL') {
          det+=`<br>Prepaid Reseeds: ${res.prepaidFarms || 0}`;
        }
      }
      else if(b.isFarm){
        if(e.exhausted){
          det+=`<br><span style="color:#ff4444;font-weight:bold;">EXHAUSTED</span>`;
          if(e.buildProgress > 0) {
            det+=`<br>Reseeding: ${Math.floor(e.buildProgress/e.buildTime*100)}%`;
          }
        } else {
          let tr=map[e.y]&&map[e.y][e.x]?map[e.y][e.x].res:0;
          det+=`<br>Food remaining: ${tr}`;
        }
      }
    }
    
    if(e.queue && e.queue.length>0){
      let pct=Math.floor(e.trainTick/(UNITS[e.queue[0]].trainTime)*100);
      det+=`<div class="train-container">`;
      det+=`  <div class="train-title">Training: <strong>${UNITS[e.queue[0]].name}</strong></div>`;
      det+=`  <div class="train-bar-bg"><div class="train-bar-fill" style="width: ${pct}%"></div></div>`;
      det+=`  <div class="train-queue-slots">`;
      e.queue.forEach((ut, idx) => {
        let slotClass = idx === 0 ? "queue-slot active-slot" : "queue-slot";
        det+=`    <div class="${slotClass}" onclick="cancelQueue(${e.id}, ${idx})" title="Click to cancel and refund">`;
        det+=`      <div class="sprite-icon icon-${ut} queue-icon"></div>`;
        det+=`      <div class="queue-cancel-hover">×</div>`;
        det+=`    </div>`;
      });
      det+=`  </div>`;
      det+=`</div>`;
    } else if(e.team===0) {
      if(e.complete && b.builds) {
        det+=`<br><span style="color:#bfa054">Click button below to train</span>`;
      } else if(e.complete && e.btype === 'MILL') {
        det+=`<br><span style="color:#bfa054">Prepay farm reseeds below</span>`;
      } else if(b.isFarm && e.exhausted) {
        det+=`<br><span style="color:#bfa054">Reactivate farm below</span>`;
      }
    }
    document.getElementById('sel-details').innerHTML=det;
    if(rebuildActions&&e.team===0){
      if(e.complete && b.builds){
        b.builds.forEach(ut=>{
          let u=UNITS[ut];
          let btn=document.createElement('div');btn.className='act-btn';
          let costStr=formatCost(u.cost);
          let desc=u.desc||'';
          let statsStr=`⚔ ${u.atk} ATK&nbsp;&nbsp;❤ ${u.hp} HP`+(u.range>0?`&nbsp;&nbsp;➶ ${u.range} RNG`:'');
          btn.innerHTML=`<div class="btn-emoji sprite-icon icon-${ut}"></div><div class="btn-label">${u.name}</div><span class="cost">${costStr}</span>` +
            `<div class="tooltip"><strong>Train ${u.name}</strong><div class="tooltip-cost">${costStr}</div><div class="tooltip-stats">${statsStr}</div><div class="tooltip-desc">${desc}</div></div>`;
          btn.onclick=()=>trainUnit(e,ut);
          act.appendChild(btn);
        });
      }
      if(e.complete && e.btype === 'MILL') {
        let btn=document.createElement('div');btn.className='act-btn framed';
        let costStr='W:60';
        let desc='Queue a farm reseed. When a farm runs out of food, it will automatically consume a reseed from the queue to replenish itself.';
        btn.innerHTML=`<div class="btn-emoji sprite-icon icon-reseed"></div><div class="btn-label">Prepay Reseed</div><span class="cost">${costStr}</span>` +
          `<div class="tooltip"><strong>Prepay Farm Reseed</strong><div class="tooltip-cost">${costStr}</div><div class="tooltip-desc">${desc}</div></div>`;
        btn.onclick=()=>prepayFarm();
        act.appendChild(btn);
      }
      if(b.isFarm && e.exhausted) {
        let btn=document.createElement('div');btn.className='act-btn framed';
        let costStr='W:60';
        let desc='Reactivate this exhausted farm. Instantly replenishes food.';
        btn.innerHTML=`<div class="btn-emoji sprite-icon icon-reseed"></div><div class="btn-label">Reactivate</div><span class="cost">${costStr}</span>` +
          `<div class="tooltip"><strong>Reactivate Farm</strong><div class="tooltip-cost">${costStr}</div><div class="tooltip-desc">${desc}</div></div>`;
        btn.onclick=()=>reactivateFarm(e);
        act.appendChild(btn);
      }
    }
  } else {
    if (port) {
      setPortraitIcon(port, e.utype, UNITS[e.utype].icon);
      port.classList.toggle('cam-locked', window.cameraFollowId===e.id);
    }
    document.getElementById('sel-name').textContent=UNITS[e.utype].name+(selected.length>1?` (${selected.length})`:'');
    let hpPct = Math.max(0, Math.min(100, Math.floor(e.hp / e.maxHp * 100)));
    let hpColor = '#2b8a3e';
    if (hpPct < 20) hpColor = '#cc3333';
    else if (hpPct < 50) hpColor = '#d9a711';
    let det=`HP: ${e.hp}/${e.maxHp}`;
    det+=`<div class="hp-bar-bg"><div class="hp-bar-fill" style="width: ${hpPct}%; background-color: ${hpColor};"></div></div>`;

    // Display combat stats for military units
    let uData = UNITS[e.utype];
    if (uData && e.utype !== 'sheep') {
      let stats = [];
      if (uData.atk > 0) stats.push(`⚔️ ${uData.atk}`);
      if (uData.range > 0) stats.push(`🏹 ${uData.range}`);
      stats.push(`🏃 ${uData.speed.toFixed(2)}`);
      det += `<br><span style="color:#ffd700;font-weight:bold;font-size:12px;">${stats.join('  ')}</span>`;
    }

    // Show friendly task names
    let taskNames={chop:'Chopping wood',mine_gold:'Mining gold',mine_stone:'Mining stone',
      forage:'Foraging berries',farm:'Farming',build:'Building','return':'Returning resources'};
    if(e.task) det+=`<br>${taskNames[e.task]||e.task}`;
    if(e.carrying>0) det+=` (${e.carrying} ${e.carryType})`;
    // Show command hints
    if(e.utype==='villager'&&e.team===0&&!e.task){
      if(isMobile) det+=`<br><span style="color:#bfa054">Tap resources to gather</span>`;
      else det+=`<br><span style="color:#bfa054">Right-click resources to gather</span>`;
    }
    document.getElementById('sel-details').innerHTML=det;

    if(rebuildActions&&e.utype==='villager'&&e.team===0){
      window.currentVillagerMenu = window.currentVillagerMenu || 'main';

      if (window.currentVillagerMenu === 'main') {
        // Main Building Menus
        let menuButtons = [
          { name: 'Build Economic', key: 'Q', iconClass: 'icon-econ', action: 'eco' },
          { name: 'Build Military', key: 'W', iconClass: 'icon-mil', action: 'mil' }
        ];
        menuButtons.forEach(bi => {
          let btn=document.createElement('div');btn.className='act-btn menu-btn framed';
          btn.innerHTML=`<div class="btn-emoji sprite-icon ${bi.iconClass}"></div><div class="btn-label">${bi.name}</div><span class="cost">[${bi.key}]</span>` +
            `<div class="tooltip"><strong>${bi.name} Menu</strong><div class="tooltip-desc">Opens the list of available ${bi.action === 'eco' ? 'economic' : 'military'} structures.</div></div>`;
          btn.onclick=()=>{
            if(gameOver)return;
            window.currentVillagerMenu = bi.action;
            updateUI();
          };
          act.appendChild(btn);
        });
      } else if (window.currentVillagerMenu === 'eco') {
        // Back Button (First)
        let backBtn=document.createElement('div');backBtn.className='act-btn back-btn framed';
        backBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-back"></div><div class="btn-label">Back</div><span class="cost">[Esc]</span>` +
          `<div class="tooltip"><strong>Go Back</strong><div class="tooltip-desc">Return to the main building menu.</div></div>`;
        backBtn.onclick=()=>{
          window.currentVillagerMenu = 'main';
          updateUI();
        };
        act.appendChild(backBtn);

        // Economic Sub-Menu
        let builds=[
          {type:'HOUSE',label:'House',key:'Q'},
          {type:'LCAMP',label:'Lumber Camp',key:'W'},
          {type:'MCAMP',label:'Mining Camp',key:'E'},
          {type:'MILL',label:'Mill',key:'R'},
          {type:'FARM',label:'Farm',key:'T'}
        ];
        builds.forEach(bi=>{
          let btn=document.createElement('div');btn.className='act-btn';
          let bData=BLDGS[bi.type];
          let costStr=formatCost(bData.cost);
          let desc=bData.desc||'';
          btn.innerHTML=`<div class="btn-emoji sprite-icon icon-${bi.type}"></div><div class="btn-label">${bi.label}</div><span class="cost">${costStr}</span>` +
            `<div class="tooltip"><strong>Build ${bData.name}</strong><div class="tooltip-cost">${costStr} [${bi.key}]</div><div class="tooltip-desc">${desc}</div></div>`;
          btn.onclick=()=>{
            if(gameOver)return;
            placing=bi.type;
            showMsg((isMobile?'Tap':'Click')+' to place '+bi.label);
          };
          act.appendChild(btn);
        });
      } else if (window.currentVillagerMenu === 'mil') {
        // Back Button (First)
        let backBtn=document.createElement('div');backBtn.className='act-btn back-btn framed';
        backBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-back"></div><div class="btn-label">Back</div><span class="cost">[Esc]</span>` +
          `<div class="tooltip"><strong>Go Back</strong><div class="tooltip-desc">Return to the main building menu.</div></div>`;
        backBtn.onclick=()=>{
          window.currentVillagerMenu = 'main';
          updateUI();
        };
        act.appendChild(backBtn);

        // Military Sub-Menu
        let builds=[
          {type:'BARRACKS',label:'Barracks',key:'Q'},
          {type:'TOWER',label:'Watch Tower',key:'W'},
          {type:'WALL',label:'Stone Wall',key:'E'},
          {type:'GATE',label:'Gate',key:'R'}
        ];
        builds.forEach(bi=>{
          let btn=document.createElement('div');btn.className='act-btn';
          let bData=BLDGS[bi.type];
          let costStr=formatCost(bData.cost);
          let desc=bData.desc||'';
          btn.innerHTML=`<div class="btn-emoji sprite-icon icon-${bi.type}"></div><div class="btn-label">${bi.label}</div><span class="cost">${costStr}</span>` +
            `<div class="tooltip"><strong>Build ${bData.name}</strong><div class="tooltip-cost">${costStr} [${bi.key}]</div><div class="tooltip-desc">${desc}</div></div>`;
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
}

function trainUnit(bldg,utype){
  if(gameOver)return;
  let result=queueUnit(bldg,utype);
  if(result.reason==='pop')showMsg('Need more houses!');
  else if(result.reason==='resources')showMsg('Not enough resources!');
}

function cancelQueue(bldgId,idx){
  if(gameOver)return;
  let bldg=entities.find(en=>en.id===bldgId);
  if(!bldg||bldg.type!=='building')return;
  let utype=bldg.queue[idx];
  if(!utype)return;
  bldg.queue.splice(idx,1);
  let cost=UNITS[utype].cost;
  let store=resourceStore(bldg.team);
  Object.entries(cost).forEach(([key,amount])=>{store[resourceName(key)]+=amount;});
  if(idx===0)bldg.trainTick=0;
  showMsg(UNITS[utype].name+' cancelled (refunded)');
}

function showMsg(txt){
  let el=document.getElementById('msg');el.textContent=txt;el.style.opacity='1';
  if (window.playSound) window.playSound('alert');
  setTimeout(()=>el.style.opacity='0',2000);
}


window.selectIdleVillager = function() {
  if (gameOver || !gameStarted) return;
  let idleVils = entities.filter(e => e.team === 0 && e.type === 'unit' && e.utype === 'villager' && !e.task && !e.target && e.path.length === 0);
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

window.toggleBottomPanel = function() {
  let bottom = document.getElementById('bottom');
  let toggle = document.getElementById('bottom-toggle');
  if (bottom && toggle) {
    let isCollapsed = bottom.classList.toggle('collapsed');
    toggle.textContent = isCollapsed ? '🔼' : '🔽';
    localStorage.setItem('hud_collapsed', isCollapsed ? '1' : '0');
    showMsg(isCollapsed ? 'HUD Collapsed' : 'HUD Expanded');
  }
};

// Load bottom panel collapsed preference and bind event listener dynamically.
// Default to collapsed on a mobile device's first-ever visit (no stored
// preference yet) to save screen space; any explicit prior choice (on any
// platform) always wins over this default.
(function() {
  let stored = localStorage.getItem('hud_collapsed');
  let collapsed = stored !== null ? (stored === '1') : isMobile;
  let bottom = document.getElementById('bottom');
  let toggle = document.getElementById('bottom-toggle');
  if (bottom && toggle) {
    toggle.addEventListener('click', window.toggleBottomPanel);
    
    if (collapsed) {
      bottom.classList.add('collapsed');
      toggle.textContent = '🔼';
    }
  }
})();

function prepayFarm() {
  if (gameOver) return;
  let cost = {w: 60};
  if (!canAfford(0, cost)) {
    showMsg('Not enough wood!');
    return;
  }
  spendCost(0, cost);
  res.prepaidFarms = (res.prepaidFarms || 0) + 1;
  showMsg(`Farm reseed prepaid (Queue: ${res.prepaidFarms})`);
  updateUI();
}

function reactivateFarm(farm) {
  if (gameOver) return;
  if (!farm.exhausted) return;
  let cost = {w: 60};
  if (!canAfford(0, cost)) {
    showMsg('Not enough wood!');
    return;
  }
  spendCost(0, cost);
  farm.exhausted = false;
  farm.complete = true;
  farm.hp = farm.maxHp;
  let tile = map[farm.y][farm.x];
  tile.t = TERRAIN.FARM;
  tile.res = 300;
  showMsg('Farm reactivated!');
  updateUI();
}

window.prepayFarm = prepayFarm;
window.reactivateFarm = reactivateFarm;
