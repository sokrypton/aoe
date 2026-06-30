function updateUI(){
  document.getElementById('r-food').textContent=Math.floor(res.food);
  document.getElementById('r-wood').textContent=Math.floor(res.wood);
  document.getElementById('r-gold').textContent=Math.floor(res.gold);
  document.getElementById('r-stone').textContent=Math.floor(res.stone);
  document.getElementById('pop').textContent=`Pop: ${popUsed}/${popCap}`;

  let gsBtn = document.getElementById('global-stance-btn');
  if(gsBtn){
    if(globalAutoAttack){
      gsBtn.innerHTML=`⚔ Auto-Attack: <span class="status-on">ON</span>`;
    }else{
      gsBtn.innerHTML=`⚔ Auto-Attack: <span class="status-off">OFF</span>`;
    }
  }

  let act=document.getElementById('actions');

  // Only rebuild action buttons when selection changes (not every frame)
  let selKey=selected.map(s=>s.id).join(',')+':'+placing;
  let rebuildActions=selKey!==lastSelKey;
  lastSelKey=selKey;
  if(rebuildActions)act.innerHTML='';

  if(gameOver){
    document.getElementById('sel-name').textContent=won?'VICTORY!':'DEFEAT!';
    document.getElementById('sel-details').textContent=won?'You destroyed the enemy Town Center!':'Your Town Center was destroyed!';
    return;
  }
  if(!gameStarted){
    document.getElementById('sel-name').textContent='Choose Difficulty';
    document.getElementById('sel-details').textContent='Select Easy, Standard, or Hard to begin';
    return;
  }

  if(selected.length===0){
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
    document.getElementById('sel-name').textContent=b.name;
    let det=`HP: ${e.hp}/${e.maxHp}`;
    if(!e.complete) det+=`<br>Building: ${Math.floor(e.buildProgress/e.buildTime*100)}%`;
    else if(b.pop) det+=`<br>Provides ${b.pop} population`;
    else if(b.drop) det+=`<br>Dropoff: ${b.drop}`;
    else if(b.isFarm){let tr=map[e.y]&&map[e.y][e.x]?map[e.y][e.x].res:0; det+=`<br>Food remaining: ${tr}`;}
    
    if(e.queue && e.queue.length>0){
      let pct=Math.floor(e.trainTick/(UNITS[e.queue[0]].trainTime)*100);
      det+=`<div class="train-container">`;
      det+=`  <div class="train-title">Training: <strong>${UNITS[e.queue[0]].name}</strong></div>`;
      det+=`  <div class="train-bar-bg"><div class="train-bar-fill" style="width: ${pct}%"></div></div>`;
      det+=`  <div class="train-queue-slots">`;
      e.queue.forEach((ut, idx) => {
        let iconChar = UNITS[ut].icon;
        let slotClass = idx === 0 ? "queue-slot active-slot" : "queue-slot";
        det+=`    <div class="${slotClass}" onclick="cancelQueue(${e.id}, ${idx})" title="Click to cancel and refund">`;
        det+=`      ${iconChar}`;
        det+=`      <div class="queue-cancel-hover">×</div>`;
        det+=`    </div>`;
      });
      det+=`  </div>`;
      det+=`</div>`;
    } else if(e.complete&&b.builds&&e.team===0) {
      det+=`<br><span style="color:#bfa054">Click button below to train</span>`;
    }
    document.getElementById('sel-details').innerHTML=det;
    if(rebuildActions&&e.team===0&&e.complete&&b.builds){
      b.builds.forEach(ut=>{
        let u=UNITS[ut];
        let btn=document.createElement('div');btn.className='act-btn';
        let costStr=formatCost(u.cost);
        btn.innerHTML=`<div class="btn-emoji">${u.icon}</div><div class="btn-label">${u.name}</div><span class="cost">${costStr}</span>`;
        btn.onclick=()=>trainUnit(e,ut);
        act.appendChild(btn);
      });
    }
  } else {
    document.getElementById('sel-name').textContent=UNITS[e.utype].name+(selected.length>1?` (${selected.length})`:'');
    let det=`HP: ${e.hp}/${e.maxHp}`;
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
      let builds=[
        {type:'HOUSE',label:'House'},
        {type:'LCAMP',label:'Lumber C.'},
        {type:'MCAMP',label:'Mine C.'},
        {type:'MILL',label:'Mill'},
        {type:'FARM',label:'Farm'},
        {type:'BARRACKS',label:'Barracks'}
      ];
      builds.forEach(bi=>{
        let btn=document.createElement('div');btn.className='act-btn';
        let bData=BLDGS[bi.type];
        btn.innerHTML=`<div class="btn-emoji">${bData.icon}</div><div class="btn-label">${bi.label}</div><span class="cost">${formatCost(bData.cost)}</span>`;
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
  setTimeout(()=>el.style.opacity='0',2000);
}

window.toggleGlobalStance = function() {
  if (gameOver) return;
  globalAutoAttack = !globalAutoAttack;
  // Update all player units to match the new global stance
  entities.forEach(en => {
    if (en.team === 0 && en.type === 'unit') {
      en.autoAttack = globalAutoAttack;
    }
  });
  showMsg(`Global Auto-Attack: ${globalAutoAttack ? 'ON' : 'OFF'}`);
  updateUI();
};
