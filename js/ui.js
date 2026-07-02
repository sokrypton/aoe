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
      currentSelectionDetails += `:${e.task}:${e.carrying || 0}:${e.target || e.buildTarget || e.followId || 0}`;
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
    // Multi-select renders a live per-unit HP bar for every selected unit
    // (not just selected[0]), so the dirty check needs all of their HP too.
    if (selected.length > 1) {
      currentSelectionDetails += ':grid' + selected.map(s => s.id + '_' + s.hp).join(',');
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

  let lu = window.lastUIState;
  let stateChanged = (
    currentFood !== lu.food || currentWood !== lu.wood ||
    currentGold !== lu.gold || currentStone !== lu.stone ||
    popUsed !== lu.popUsed || popCap !== lu.popCap ||
    currentIdleCount !== lu.idleCount || gameOver !== lu.gameOver ||
    gameStarted !== lu.gameStarted || currentSelListKey !== lu.selectedKey ||
    currentSelectionDetails !== lu.selectionDetails || placing !== lu.placing ||
    window.currentVillagerMenu !== lu.currentVillagerMenu ||
    !!window.settingRally !== !!lu.settingRally
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
  lu.settingRally = !!window.settingRally;

  // Perform actual DOM updates
  document.getElementById('r-food').textContent=currentFood;
  document.getElementById('r-wood').textContent=currentWood;
  document.getElementById('r-gold').textContent=currentGold;
  document.getElementById('r-stone').textContent=currentStone;
  document.getElementById('pop').textContent=`${popUsed}/${popCap}`;
  
  let idleBtn = document.getElementById('idle-btn');
  if(idleBtn) {
    if(currentIdleCount > 0) {
      idleBtn.style.display = 'flex';
      idleBtn.innerHTML = `🧑‍🌾<div class="idle-badge">${currentIdleCount}</div>`;
      idleBtn.classList.add('idle-active');
    } else {
      idleBtn.style.display = 'none';
      idleBtn.classList.remove('idle-active');
    }
  }

  let act=document.getElementById('actions');
  let selKey=currentSelListKey+':'+placing+':'+(window.currentVillagerMenu||'main')+':'+currentIdleCount+':'+!!window.settingRally;
  let rebuildActions=selKey!==lastSelKey;
  lastSelKey=selKey;
  let bottomEl = document.getElementById('bottom');
  if (bottomEl) {
    let isSubMenu = window.currentVillagerMenu === 'eco' || window.currentVillagerMenu === 'mil';
    bottomEl.classList.toggle('menu-active', isSubMenu);
  }
  if(rebuildActions)act.innerHTML='';

  // Multi-select: the portrait+stats card is replaced by a grid of every
  // selected unit's own icon (AoE2-style), each with its own mini HP bar,
  // rather than one aggregate card for selected[0]. Rebuilt only when the
  // selection or any selected unit's HP changes (see currentSelectionDetails).
  let selInfo=document.getElementById('sel-info');
  let selGrid=document.getElementById('sel-grid');
  let isMulti=selected.length>1;
  if(selInfo) selInfo.classList.toggle('multi-select', isMulti);
  if(selGrid && currentSelectionDetails!==(window.lastSelGridDetails||'')){
    window.lastSelGridDetails=currentSelectionDetails;
    selGrid.innerHTML='';
    if(isMulti){
      selected.forEach(s=>{
        let key=s.type==='building'?s.btype:s.utype;
        let data=s.type==='building'?BLDGS[key]:UNITS[key];
        let icon=document.createElement('div');
        icon.className='sel-unit-icon';
        setPortraitIcon(icon, key, data&&data.icon);
        let hpPct=Math.max(0,Math.min(100,Math.floor(s.hp/s.maxHp*100)));
        let hpColor='#2b8a3e';
        if(hpPct<20) hpColor='#cc3333';
        else if(hpPct<50) hpColor='#d9a711';
        let bar=document.createElement('div');bar.className='sel-unit-hp';
        let fill=document.createElement('div');fill.className='sel-unit-hp-fill';
        fill.style.width=hpPct+'%';
        fill.style.background=hpColor;
        bar.appendChild(fill);
        icon.appendChild(bar);
        icon.title=(data&&data.name||key)+` (HP ${s.hp}/${s.maxHp})\nLeft-click: select only this unit\nRight-click or Shift-click: remove from selection`;
        icon.onclick=(ev)=>{
          if(ev.shiftKey) selected=selected.filter(u=>u.id!==s.id);
          else selected=[s];
          updateUI();
        };
        icon.oncontextmenu=(ev)=>{
          ev.preventDefault();
          selected=selected.filter(u=>u.id!==s.id);
          updateUI();
        };
        selGrid.appendChild(icon);
      });
    }
  }

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
    document.getElementById('sel-details').textContent='Select a unit or building';
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
    
    let bAtk = e.btype === 'TC' ? 6 : (e.btype === 'TOWER' ? BLDGS.TOWER.atk : 0);
    let bRange = e.btype === 'TC' ? 6 : (e.btype === 'TOWER' ? 5 : 0);
    if(bAtk > 0) {
      det += `<div style="color:#ffd700;font-weight:bold;font-size:11px;margin-top:1px;">⚔️ ${bAtk}  🏹 ${bRange}</div>`;
    }
    if(!e.complete && !e.exhausted) det+=`<div style="margin-top:1px;">Building: ${Math.floor(e.buildProgress/e.buildTime*100)}%</div>`;
    else {
      if(b.pop) det+=`<div style="margin-top:1px;">Provides ${b.pop} population</div>`;
      else if(b.drop) {
        det+=`<div style="margin-top:1px;">Dropoff: ${b.drop}</div>`;
        if (e.btype === 'MILL') {
          det+=`<div style="margin-top:1px;">Prepaid Reseeds: ${res.prepaidFarms || 0}</div>`;
        }
      }
      else if(b.isFarm){
        if(e.exhausted){
          det+=`<div style="color:#ff4444;font-weight:bold;margin-top:1px;">EXHAUSTED</div>`;
          if(e.buildProgress > 0) {
            det+=`<div style="margin-top:1px;">Reseeding: ${Math.floor(e.buildProgress/e.buildTime*100)}%</div>`;
          }
        } else {
          let tr=map[e.y]&&map[e.y][e.x]?map[e.y][e.x].res:0;
          det+=`<div style="margin-top:1px;">Food remaining: ${tr}</div>`;
        }
      }
    }
    
    if(e.queue && e.queue.length>0){
      let pct=Math.floor(e.trainTick/(UNITS[e.queue[0]].trainTime)*100);
      det+=`<div class="train-compact">`;
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
    }
    document.getElementById('sel-details').innerHTML=det;
    if(rebuildActions&&e.team===0){
      if(e.complete && b.builds){
        b.builds.forEach(ut=>{
          let u=UNITS[ut];
          let btn=document.createElement('div');btn.className='act-btn';
          let costStr=formatCost(u.cost);
          btn.innerHTML=`<div class="btn-emoji sprite-icon icon-${ut}"></div><div class="btn-label">${u.name}</div><span class="cost">${costStr}</span>`;
          btn.onclick=()=>trainUnit(e,ut);
          act.appendChild(btn);
        });

        // Rally Point button — lets mobile players set rally without right-click
        if (e.complete) {
          if (window.settingRally) {
            // Show cancel button while in rally-setting mode
            let cancelBtn=document.createElement('div');
            cancelBtn.className='act-btn rally-btn rally-active';
            cancelBtn.id='rally-cancel-btn';
            cancelBtn.innerHTML=`<div class="btn-emoji" style="font-size:22px">🚩</div><div class="btn-label">Tap map to<br>set rally</div>`;
            cancelBtn.onclick=()=>{ window.settingRally=false; showMsg('Rally cancelled'); updateUI(); };
            act.appendChild(cancelBtn);
          } else {
            let rallyBtn=document.createElement('div');
            rallyBtn.className='act-btn rally-btn';
            rallyBtn.id='rally-set-btn';
            rallyBtn.innerHTML=`<div class="btn-emoji" style="font-size:22px">🚩</div><div class="btn-label">Set Rally</div>`;
            rallyBtn.onclick=()=>{
              if(gameOver)return;
              window.settingRally=true;
              showMsg('Tap the map to set rally point');
              updateUI();
            };
            act.appendChild(rallyBtn);
          }
        }
      }

      if(e.complete && e.btype === 'MILL') {
        let btn=document.createElement('div');btn.className='act-btn framed';
        let costStr='W:60';
        btn.innerHTML=`<div class="btn-emoji sprite-icon icon-reseed"></div><div class="btn-label">Prepay Reseed</div><span class="cost">${costStr}</span>`;
        btn.onclick=()=>prepayFarm();
        act.appendChild(btn);
      }
      if(b.isFarm && e.exhausted) {
        let btn=document.createElement('div');btn.className='act-btn framed';
        let costStr='W:60';
        btn.innerHTML=`<div class="btn-emoji sprite-icon icon-reseed"></div><div class="btn-label">Reactivate</div><span class="cost">${costStr}</span>`;
        btn.onclick=()=>reactivateFarm(e);
        act.appendChild(btn);
      }
    }
  } else {
    if (port) {
      setPortraitIcon(port, e.utype, UNITS[e.utype].icon);
      port.classList.toggle('cam-locked', window.cameraFollowId===e.id);
    }
    let unitName = '';
    if (e.utype === 'sheep' || e.utype === 'sheep_carcass') {
      unitName = selected.length > 1 ? 'Sheep' : 'Sheep';
    } else if (e.utype === 'villager') {
      unitName = selected.length > 1 ? 'Villagers' : 'Villager';
    } else {
      unitName = selected.length > 1 ? 'Soldiers' : 'Soldier';
    }
    document.getElementById('sel-name').textContent = unitName + (selected.length > 1 ? ` (${selected.length})` : '');
    let hpPct = Math.max(0, Math.min(100, Math.floor(e.hp / e.maxHp * 100)));
    let hpColor = '#2b8a3e';
    if (hpPct < 20) hpColor = '#cc3333';
    else if (hpPct < 50) hpColor = '#d9a711';
    let isCarcass = e.utype === 'sheep_carcass';
    let det = isCarcass ? `Food remaining: ${e.hp}/${e.maxHp}` : `HP: ${e.hp}/${e.maxHp}`;
    det+=`<div class="hp-bar-bg"><div class="hp-bar-fill" style="width: ${hpPct}%; background-color: ${isCarcass ? '#e2b13c' : hpColor};"></div></div>`;

    // Display combat stats for military units
    let uData = UNITS[e.utype];
    if (uData && e.utype !== 'sheep' && e.utype !== 'sheep_carcass') {
      let stats = [];
      if (uData.atk > 0) stats.push(`⚔️ ${uData.atk}`);
      if (uData.range > 0) stats.push(`🏹 ${uData.range}`);
      stats.push(`🏃 ${uData.speed.toFixed(2)}`);
      det += `<div style="color:#ffd700;font-weight:bold;font-size:11px;margin-top:1px;">${stats.join('  ')}</div>`;
    }

    // Show friendly task names
    let taskNames={chop:'Chopping wood',mine_gold:'Mining gold',mine_stone:'Mining stone',
      forage:'Foraging berries',farm:'Farming',build:'Building','return':'Returning resources'};
    let taskStr = '';
    if(e.task) taskStr += taskNames[e.task]||e.task;
    if(e.carrying>0) taskStr += ` (${e.carrying} ${e.carryType})`;
    if(taskStr) det+=`<div style="margin-top:1px;">${taskStr}</div>`;

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
          btn.innerHTML=`<div class="btn-emoji sprite-icon ${bi.iconClass}"></div><div class="btn-label">${bi.name}</div><span class="cost">[${bi.key}]</span>`;
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
        backBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-back"></div><div class="btn-label">Back</div><span class="cost">[Esc]</span>`;
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
          btn.innerHTML=`<div class="btn-emoji sprite-icon icon-${bi.type}"></div><div class="btn-label">${bi.label}</div><span class="cost">${costStr}</span>`;
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
        backBtn.innerHTML=`<div class="btn-emoji sprite-icon icon-back"></div><div class="btn-label">Back</div><span class="cost">[Esc]</span>`;
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
          btn.innerHTML=`<div class="btn-emoji sprite-icon icon-${bi.type}"></div><div class="btn-label">${bi.label}</div><span class="cost">${costStr}</span>`;
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
  // The help hint shares the same screen spot — yield to the message
  let hint=document.getElementById('help-hint');
  if(hint)hint.style.opacity='0';
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

window.updateBottomHeight = function() {
  let w = window.innerWidth;
  bottomH = isMobile ? (w <= 380 ? 90 : 96) : 80;
  topH = isMobile ? (w <= 600 ? 46 : 36) : 36;
  H = window.innerHeight - bottomH;
  W = w;
  
  let C = document.getElementById('game');
  if (C) {
    let X = C.getContext('2d');
    let dpr = Math.max(1, window.devicePixelRatio || 1);
    C.width = W * dpr;
    C.height = window.innerHeight * dpr;
    C.style.width = W + 'px';
    C.style.height = window.innerHeight + 'px';
    if (X) X.scale(dpr, dpr);
  }
};

window.updateBottomHeight();

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
