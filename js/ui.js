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
  let idleVils = entities.filter(e => e.team === 0 && e.type === 'unit' && e.utype === 'villager' && !e.task && !e.target && !e.garrisonedIn && e.path.length === 0);
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

  let lu = window.lastUIState;
  let stateChanged = (
    currentFood !== lu.food || currentWood !== lu.wood ||
    currentGold !== lu.gold || currentStone !== lu.stone ||
    popUsed !== lu.popUsed || popCap !== lu.popCap ||
    currentIdleCount !== lu.idleCount || gameOver !== lu.gameOver ||
    gameStarted !== lu.gameStarted || currentSelListKey !== lu.selectedKey ||
    currentSelectionDetails !== lu.selectionDetails || placing !== lu.placing ||
    window.currentVillagerMenu !== lu.currentVillagerMenu ||
    !!window.settingRally !== !!lu.settingRally ||
    !!window.bellActive !== !!lu.bellActive
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
  lu.bellActive = !!window.bellActive;

  // Perform actual DOM updates
  document.getElementById('r-food').textContent=currentFood;
  document.getElementById('r-wood').textContent=currentWood;
  document.getElementById('r-gold').textContent=currentGold;
  document.getElementById('r-stone').textContent=currentStone;
  document.getElementById('pop').textContent=`${popUsed}/${popCap}`;
  
  let bellBtn = document.getElementById('bell-btn');
  if(bellBtn) {
    if(gameStarted && !gameOver) {
      bellBtn.style.display = 'flex';
      bellBtn.textContent = '🔔';
      bellBtn.classList.toggle('bell-active', !!window.bellActive);
      bellBtn.dataset.tipLabel = 'Town Bell';
      bellBtn.dataset.tipDesc = window.bellActive
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
      idleBtn.innerHTML = `🧑‍🌾<div class="idle-badge">${currentIdleCount}</div>`;
      idleBtn.classList.add('idle-active');
      idleBtn.dataset.tipLabel = 'Idle Villager';
      idleBtn.dataset.tipDesc = `${currentIdleCount} villager${currentIdleCount>1?'s are':' is'} idle. Click to select and cycle through them.`;
    } else {
      idleBtn.style.display = 'none';
      idleBtn.classList.remove('idle-active');
    }
  }

  let act=document.getElementById('actions');
  let selKey=currentSelListKey+':'+placing+':'+(window.currentVillagerMenu||'main')+':'+currentIdleCount+':'+!!window.settingRally
    +':'+!!window.bellActive+':'+(selected[0]&&selected[0].garrison?selected[0].garrison.length:0);
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
  if(rebuildActions)act.innerHTML='';

  // Multi-select: the portrait+stats card is replaced by a grid of every
  // selected unit's own icon (AoE2-style), each with its own mini HP bar,
  // rather than one aggregate card for selected[0]. Rebuilt only when the
  // selection or any selected unit's HP changes (see currentSelectionDetails).
  let selInfo=document.getElementById('sel-info');
  let selGrid=document.getElementById('sel-grid');
  let isMulti=selected.length>1;
  // A selected own building with units inside reuses the multi-select grid to
  // show its garrison (AoE2-style); clicking an icon releases that unit.
  let garrisonSel = !isMulti && selected.length===1 && selected[0].type==='building'
    && selected[0].team===0 && selected[0].garrison && selected[0].garrison.length>0
    ? selected[0] : null;
  if(selInfo) selInfo.classList.toggle('multi-select', isMulti||!!garrisonSel);
  if(selGrid && currentSelectionDetails!==(window.lastSelGridDetails||'')){
    window.lastSelGridDetails=currentSelectionDetails;
    selGrid.innerHTML='';
    if(garrisonSel){
      garrisonSel.garrison.forEach(id=>{
        let u=entitiesById.get(id);
        if(!u)return;
        let data=UNITS[u.utype];
        let icon=document.createElement('div');
        icon.className='sel-unit-icon';
        setPortraitIcon(icon, u.utype, data&&data.icon);
        let hpPct=Math.max(0,Math.min(100,Math.floor(u.hp/u.maxHp*100)));
        let hpColor='#2b8a3e';
        if(hpPct<20) hpColor='#cc3333';
        else if(hpPct<50) hpColor='#d9a711';
        let bar=document.createElement('div');bar.className='sel-unit-hp';
        let fill=document.createElement('div');fill.className='sel-unit-hp-fill';
        fill.style.width=hpPct+'%';
        fill.style.background=hpColor;
        bar.appendChild(fill);
        icon.appendChild(bar);
        icon.title=(data&&data.name||u.utype)+` (HP ${u.hp}/${u.maxHp})\nClick to release from garrison`;
        icon.onclick=()=>{
          if(gameOver)return;
          ejectGarrison(garrisonSel, gu=>gu.id===id);
          updateUI();
        };
        selGrid.appendChild(icon);
      });
    } else if(isMulti){
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
    if (port) { setPortraitIcon(port, null, won ? '🏆' : '💀'); port.classList.remove('cam-locked'); }
    document.getElementById('sel-name').textContent=won?'VICTORY!':'DEFEAT!';
    document.getElementById('sel-details').textContent=won?'You destroyed the enemy Town Center!':'Your Town Center was destroyed!';
    return;
  }
  if(!gameStarted){
    if (port) { setPortraitIcon(port, null, '⚔️'); port.classList.remove('cam-locked'); }
    document.getElementById('sel-name').textContent='Choose Difficulty';
    document.getElementById('sel-details').textContent='Select Easy, Medium, or Hard to begin';
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
    if(e.complete && garrisonCap(e) > 0) {
      det += `<div style="margin-top:1px;">Garrison: ${garrisonCount(e)}/${garrisonCap(e)}${garrisonCount(e)>0?' (+'+Math.min(garrisonCount(e),5)+' arrows)':''}</div>`;
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
          btn.dataset.tipType='unit';
          btn.dataset.tipKey=ut;
          btn.dataset.cost=JSON.stringify(u.cost);
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
            cancelBtn.dataset.tipType='action';
            cancelBtn.dataset.tipLabel='Cancel Rally';
            cancelBtn.dataset.tipDesc='Click to stop setting the rally point.';
            cancelBtn.innerHTML=`<div class="btn-emoji" style="font-size:22px">🚩</div><div class="btn-label">Tap map to<br>set rally</div>`;
            cancelBtn.onclick=()=>{ window.settingRally=false; showMsg('Rally cancelled'); updateUI(); };
            act.appendChild(cancelBtn);
          } else {
            let rallyBtn=document.createElement('div');
            rallyBtn.className='act-btn rally-btn';
            rallyBtn.id='rally-set-btn';
            rallyBtn.dataset.tipType='action';
            rallyBtn.dataset.tipLabel='Set Rally Point';
            rallyBtn.dataset.tipDesc='Newly trained units will automatically walk to the rally point after spawning.';
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
        btn.dataset.tipType='action';
        btn.dataset.tipLabel='Prepay Farm Reseed';
        btn.dataset.tipDesc='Pre-pays 60 Wood to automatically reseed an exhausted farm. Queued reseeds are used before spending resources again.';
        btn.dataset.tipCost=JSON.stringify({w:60});
        btn.dataset.cost=JSON.stringify({w:60});
        let costStr='W:60';
        btn.innerHTML=`<div class="btn-emoji sprite-icon icon-reseed"></div><div class="btn-label">Prepay Reseed</div><span class="cost">${costStr}</span>`;
        btn.onclick=()=>prepayFarm();
        act.appendChild(btn);
      }
      if(b.isFarm && e.exhausted) {
        let btn=document.createElement('div');btn.className='act-btn framed';
        btn.dataset.tipType='action';
        btn.dataset.tipLabel='Reactivate Farm';
        btn.dataset.tipDesc='Spends 60 Wood to restore this exhausted farm to full capacity (300 Food).';
        btn.dataset.tipCost=JSON.stringify({w:60});
        btn.dataset.cost=JSON.stringify({w:60});
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
        // Back Button (First)
        let backBtn=document.createElement('div');backBtn.className='act-btn back-btn framed';
        backBtn.dataset.tipType='action';
        backBtn.dataset.tipLabel='Back';
        backBtn.dataset.tipDesc='Return to the main villager command panel.';
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
          btn.dataset.tipType='building';
          btn.dataset.tipKey=bi.type;
          let bData=BLDGS[bi.type];
          btn.dataset.cost=JSON.stringify(bData.cost);
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
        backBtn.dataset.tipType='action';
        backBtn.dataset.tipLabel='Back';
        backBtn.dataset.tipDesc='Return to the main villager command panel.';
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
          btn.dataset.tipType='building';
          btn.dataset.tipKey=bi.type;
          let bData=BLDGS[bi.type];
          btn.dataset.cost=JSON.stringify(bData.cost);
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

  refreshActionAffordability();
}

// Grey out action buttons whose cost can't currently be paid. Runs on every
// dirty updateUI pass (resource totals are part of the dirty check), so
// buttons wake up the moment the resources come in — no rebuild needed.
function refreshActionAffordability(){
  document.querySelectorAll('#actions .act-btn[data-cost]').forEach(btn=>{
    let cost;
    try{ cost=JSON.parse(btn.dataset.cost); }catch(_){ return; }
    btn.classList.toggle('disabled', !canAfford(0,cost));
  });
}
// Swallow clicks on disabled buttons before their own onclick fires.
document.getElementById('actions').addEventListener('click', function(e){
  let btn = e.target.closest && e.target.closest('.act-btn.disabled');
  if(btn){
    e.stopPropagation();
    e.preventDefault();
    showMsg('Not enough resources!');
  }
}, true);

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


window.toggleTownBell = function() {
  if (gameOver || !gameStarted) return;
  if (window.bellActive) soundAllClear();
  else ringTownBell();
};

window.selectIdleVillager = function() {
  if (gameOver || !gameStarted) return;
  let idleVils = entities.filter(e => e.team === 0 && e.type === 'unit' && e.utype === 'villager' && !e.task && !e.target && !e.garrisonedIn && e.path.length === 0);
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

  // Position the tooltip near (mx, my), keeping it inside the viewport
  function positionTip(mx, my) {
    const OFFSET = 14;
    TIP.style.left = '';
    TIP.style.right = '';
    TIP.style.top = '';
    TIP.style.bottom = '';

    const tw = TIP.offsetWidth || 220;
    const th = TIP.offsetHeight || 80;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer right of cursor; flip left if it would overflow
    let left = mx + OFFSET;
    if (left + tw > vw - 8) left = mx - tw - OFFSET;
    if (left < 4) left = 4;

    // Prefer below cursor; flip above if it would overflow
    let top = my + OFFSET;
    if (top + th > vh - 8) top = my - th - OFFSET;
    if (top < 4) top = 4;

    TIP.style.left = left + 'px';
    TIP.style.top  = top  + 'px';
  }

  function showTip(html, mx, my) {
    TIP.innerHTML = html;
    TIP.classList.add('visible');
    positionTip(mx, my);
  }

  function hideTip() {
    TIP.classList.remove('visible');
  }

  // ---- Action button hover: show unit/building being trained or placed ----
  // Delegated listener on #bottom catches all .act-btn children even after
  // updateUI() rebuilds them. Tooltip content is driven entirely by data
  // attributes (tipType, tipKey, tipLabel, tipDesc) set on each button.

  document.getElementById('bottom').addEventListener('mouseover', function(e) {
    if (typeof hasTouch !== 'undefined' && hasTouch) { hideTip(); return; }

    // Walk up from the hovered element to find a .act-btn
    let el = e.target;
    while (el && el !== this) {
      if (el.classList && el.classList.contains('act-btn')) break;
      el = el.parentElement;
    }
    if (!el || !el.classList || !el.classList.contains('act-btn')) { hideTip(); return; }

    const tipType  = el.dataset.tipType;   // 'unit' | 'building' | 'action'
    const tipKey   = el.dataset.tipKey;    // utype or btype key
    const tipLabel = el.dataset.tipLabel;  // plain-text label for 'action' type
    const tipDesc  = el.dataset.tipDesc;   // plain-text description for 'action' type

    if (!tipType) { hideTip(); return; }

    let d = null;
    if (tipType === 'unit') {
      const u = UNITS[tipKey];
      if (!u) return;
      const stats = [];
      if (u.atk > 0) stats.push(`⚔️ ${u.atk}`);
      if (u.range > 0) stats.push(`🏹 ${u.range}`);
      if (u.speed > 0) stats.push(`🏃 ${u.speed.toFixed(2)}`);
      d = { name: u.name, desc: u.desc || null, stats, cost: u.cost };
    } else if (tipType === 'building') {
      const b = BLDGS[tipKey];
      if (!b) return;
      const stats = [];
      if (tipKey === 'TC' || tipKey === 'TOWER') {
        const atk = tipKey === 'TC' ? 6 : b.atk;
        const rng = tipKey === 'TC' ? 6 : b.range;
        if (atk > 0) stats.push(`⚔️ ${atk}`);
        if (rng > 0) stats.push(`🏹 ${rng}`);
      }
      d = { name: b.name, desc: b.desc || null, stats, cost: b.cost };
    } else if (tipType === 'action') {
      // Plain action buttons (rally, eco/mil menu, back, reseed, reactivate)
      let cost = null;
      try { cost = el.dataset.tipCost ? JSON.parse(el.dataset.tipCost) : null; } catch(_) {}
      d = { name: tipLabel || '', desc: tipDesc || null, cost };
    }

    if (d) showTip(buildTipHTML(d), e.clientX, e.clientY);
  });

  document.getElementById('bottom').addEventListener('mousemove', function(e) {
    if (TIP.classList.contains('visible')) positionTip(e.clientX, e.clientY);
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
      if (typeof hasTouch !== 'undefined' && hasTouch) { hideTip(); return; }
      let el = e.target;
      while (el && el !== this.parentElement) {
        if (el.dataset && el.dataset.tipLabel) break;
        el = el.parentElement;
      }
      if (!el || !el.dataset || !el.dataset.tipLabel) { hideTip(); return; }
      showTip(buildTipHTML({ name: el.dataset.tipLabel, desc: el.dataset.tipDesc || null }), e.clientX, e.clientY);
    });
    container.addEventListener('mousemove', function(e) {
      if (TIP.classList.contains('visible')) positionTip(e.clientX, e.clientY);
    });
    container.addEventListener('mouseout', function(e) {
      if (!this.contains(e.relatedTarget)) hideTip();
    });
  }
  attachSimpleTips(document.getElementById('pop-wrap'));
  attachSimpleTips(document.getElementById('menu-btn'));

})();

