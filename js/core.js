const C=document.getElementById('game'),X=C.getContext('2d');
const MC=document.getElementById('minimap'),MX=MC.getContext('2d');
const isMobile='ontouchstart' in window||navigator.maxTouchPoints>0;
// Command markers (visual feedback when you issue a command)
let cmdMarkers=[]; // {x,y,time,color}
let bottomH=isMobile?(window.innerWidth<=380?130:window.innerWidth<=600?150:200):200;
let topH=isMobile?(window.innerWidth<=600?28:32):32;
const dpr = Math.max(1, window.devicePixelRatio || 1);
let ZOOM = 1.0;
let W=window.innerWidth,H=window.innerHeight-bottomH;
C.width=W*dpr;C.height=window.innerHeight*dpr;
C.style.width=W+'px';C.style.height=window.innerHeight+'px';
X.scale(dpr,dpr);

// ---- CONSTANTS ----
const MAP_SIZES={small:60,medium:90,large:120};
let MAP=MAP_SIZES.small;
const TW=64, TH=32, HALF_TW=32, HALF_TH=16;
let STARTS=[
  {team:0,x:10,y:10},
  {team:1,x:MAP-13,y:MAP-13}
];
// Switches the active map dimensions/start positions; must run before genMap()/init().
function setMapSize(sizeKey){
  MAP=MAP_SIZES[sizeKey]||MAP_SIZES.medium;
  STARTS=[
    {team:0,x:10,y:10},
    {team:1,x:MAP-13,y:MAP-13}
  ];
}
const TEAM_COLORS={0:'#2266bb',1:'#dd3b3b',2:'#cccc88'};
const TERRAIN={GRASS:0,FOREST:1,GOLD:2,STONE:3,WATER:4,FARM:5,BERRIES:6};
const TCOL={
  [TERRAIN.GRASS]:['#4a8c2a','#52942e','#468828','#4e9030'],
  [TERRAIN.FOREST]:['#2a5c1a','#306020','#28581a'],
  [TERRAIN.GOLD]:['#8a7a30','#928234','#7e7028'],
  [TERRAIN.STONE]:['#6a6a6a','#727272','#626262'],
  [TERRAIN.WATER]:['#4499dd','#3b90d0','#3585c5'],
  [TERRAIN.FARM]:['#8a7a50','#7e7048','#927e54'],
  [TERRAIN.BERRIES]:['#4a8c2a','#52942e']
};

const BLDGS={
  TC:{name:'Town Center',w:2,h:2,hp:2400,cost:{w:275,s:100},builds:['villager'],buildTime:900,desc:'Town Center. Trains villagers and accepts resource dropoffs.',icon:'🏰'},
  HOUSE:{name:'House',w:1,h:1,hp:550,cost:{w:25},pop:5,buildTime:150,desc:'Increases population capacity by 5.',icon:'🏠'},
  LCAMP:{name:'Lumber Camp',w:1,h:1,hp:600,cost:{w:100},drop:'wood',buildTime:210,desc:'Drop site for Wood.',icon:'🪓'},
  MCAMP:{name:'Mining Camp',w:1,h:1,hp:600,cost:{w:100},drop:'gold,stone',buildTime:210,desc:'Drop site for Gold and Stone.',icon:'⛏️'},
  MILL:{name:'Mill',w:1,h:1,hp:600,cost:{w:100},drop:'food',buildTime:210,desc:'Drop site for Food. Necessary to plant Farms.',icon:'🛞'},
  FARM:{name:'Farm',w:1,h:1,hp:100,cost:{w:60},isFarm:true,food:300,buildTime:90,desc:'Constant source of Food. Placed on flat land.',icon:'🌱'},
  BARRACKS:{name:'Barracks',w:2,h:2,hp:1200,cost:{w:175},builds:['militia','spearman','archer','scout'],buildTime:300,desc:'Trains infantry, archers, and light cavalry.',icon:'⚔️'},
  TOWER:{name:'Watch Tower',w:1,h:1,hp:700,cost:{w:125,s:50},range:5,atk:5,buildTime:480,desc:'Defensive tower. Automatically shoots arrows at nearby enemies.',icon:'🗼'},
  WALL:{name:'Stone Wall',w:1,h:1,hp:1000,cost:{s:5},buildTime:30,desc:'Heavy stone defensive barrier to block chokepoints.',icon:'🧱'},
  GATE:{name:'Gate',w:1,h:1,hp:2750,cost:{w:30,s:20},buildTime:210,desc:'Wall opening. Automatically opens for allied units.',icon:'🚪'}
};
const UNITS={
  villager:{name:'Villager',hp:25,atk:3,range:0,speed:1.0,cost:{f:50},trainTime:120,desc:'Gathers resources and constructs structures.',icon:'🧑‍🌾'},
  militia:{name:'Militia',hp:40,atk:4,range:0,speed:1.12,cost:{f:60,g:20},trainTime:100,desc:'Basic infantry soldier. Affordable defense.',icon:'🛡️'},
  spearman:{name:'Spearman',hp:35,atk:3,range:0,speed:1.25,cost:{f:35,w:25},trainTime:105,desc:'Anti-cavalry infantry. Strong counter to scouts.',icon:'🔱'},
  archer:{name:'Archer',hp:30,atk:4,range:4,speed:1.20,cost:{w:25,g:45},trainTime:167,desc:'Ranged archer. Effective against infantry, weak to scouts.',icon:'🏹'},
  scout:{name:'Scout Cavalry',hp:45,atk:3,range:0,speed:1.50,cost:{f:80},trainTime:143,desc:'Fast light cavalry. Effective against archers and for scouting.',icon:'🏇'},
  sheep:{name:'Sheep',hp:8,atk:0,range:0,speed:1.0,cost:{f:0},trainTime:0,desc:'Provides Food when harvested.',icon:'🐑'}
};
const AI_LEVELS={
  easy:{name:'Easy',decisionInterval:240,maxVils:9,queueLimit:1,houseBuffer:1,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:7,attackTick:3900,armyReserve:5,militaryFoodReserve:0,dropSites:false,walls:false,wallVils:0,wallRadius:0,attackAdvantage:1.5,trickle:{food:1,wood:1,gold:0,stone:0}},
  standard:{name:'Standard',decisionInterval:180,maxVils:14,queueLimit:2,houseBuffer:2,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:9,attackTick:2700,armyReserve:7,militaryFoodReserve:70,dropSites:true,walls:true,wallVils:10,wallRadius:6,attackAdvantage:1.15,trickle:{food:2,wood:1,gold:1,stone:0}},
  hard:{name:'Hard',decisionInterval:120,maxVils:20,queueLimit:3,houseBuffer:3,buildersPerBuilding:2,maxBarracks:2,barracksVil:7,attackSize:10,attackTick:2100,armyReserve:10,militaryFoodReserve:120,dropSites:true,walls:true,wallVils:8,wallRadius:7,attackAdvantage:0.9,trickle:{food:3,wood:2,gold:1,stone:0}}
};

function randInt(min,max){
  return Math.floor(Math.random()*(max-min+1))+min;
}

// ---- GAME STATE ----
let map=[], entities=[], entitiesById=new Map(), corpses=[], selected=[], camX=0, camY=0, tick=0;

let res={food:200,wood:200,gold:100,stone:200};
let popUsed=0, popCap=0;
let aiRes={food:200,wood:200,gold:100,stone:200}, aiPop=0, aiPopCap=0, aiTick=0;
let placing=null, mouseX=0, mouseY=0, dragStart=null, dragEnd=null;
let gameOver=false, won=false;
let lastSelKey='';
let gameStarted=false, gamePaused=false, aiDifficulty='standard';

// ---- NEW SPEC GAME STATE & HELPERS ----
let fog=[], projectiles=[], particles=[];

function darkenColor(hex, percent) {
  if (!hex || hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
  let num = parseInt(hex.slice(1), 16),
      amt = Math.round(2.55 * percent * 100),
      R = (num >> 16) - amt,
      G = (num >> 8 & 0x00FF) - amt,
      B = (num & 0x0000FF) - amt;
  return "#" + (0x1000000 + (R<0?0:R>255?255:R)*0x10000 + (G<0?0:G>255?255:G)*0x100 + (B<0?0:B>255?255:B)).toString(16).slice(1);
}

function initFog() {
  fog = [];
  let startVal = window.fogDisabled ? 2 : 0;
  for (let y = 0; y < MAP; y++) {
    fog[y] = [];
    for (let x = 0; x < MAP; x++) {
      fog[y][x] = startVal; // Unexplored unless fog is disabled
    }
  }
}

function updateFog() {
  if (!gameStarted) return;
  if (window.fogDisabled) {
    // Map revealed: every tile reads as actively-visible (2) so render/build
    // logic (which already branches on fog level) just sees a lit map.
    for (let y = 0; y < MAP; y++) for (let x = 0; x < MAP; x++) fog[y][x] = 2;
    return;
  }
  // 1. Reset active vision (2) to explored (1)
  for (let y = 0; y < MAP; y++) {
    for (let x = 0; x < MAP; x++) {
      if (fog[y][x] === 2) fog[y][x] = 1;
    }
  }
  
  // 2. Set visible tiles around player units/buildings (team 0)
  entities.forEach(e => {
    if (e.team !== 0) return;
    
    let sight = 5;
    if (e.type === 'building') {
      if (!e.complete) sight = 1;
      else if (e.btype === 'TC') sight = 8;
      else if (e.btype === 'TOWER') sight = 9;
      else if (e.btype === 'HOUSE') sight = 4;
      else sight = 5;
    } else {
      if (e.utype === 'sheep') sight = 3;
      else if (e.utype === 'scout') sight = 7;
      else sight = 5;
    }
    
    let cx = Math.round(e.x);
    let cy = Math.round(e.y);
    if (e.type === 'building') {
      let b = BLDGS[e.btype];
      cx = Math.round(e.x + (e.w || b.w)/2);
      cy = Math.round(e.y + (e.h || b.h)/2);
    }
    
    for (let dy = -sight; dy <= sight; dy++) {
      for (let dx = -sight; dx <= sight; dx++) {
        if (dx*dx + dy*dy <= sight*sight) {
          let tx = cx + dx;
          let ty = cy + dy;
          if (tx >= 0 && tx < MAP && ty >= 0 && ty < MAP) {
            fog[ty][tx] = 2; // Active vision
          }
        }
      }
    }
  });
}

function spawnParticles(x, y, color, count, speed=0.03, size=2) {
  for (let i = 0; i < count; i++) {
    let angle = Math.random() * Math.PI * 2;
    let sp = Math.random() * speed;
    particles.push({
      x: x + (Math.random() - 0.5) * 0.3,
      y: y + (Math.random() - 0.5) * 0.3,
      vx: Math.cos(angle) * sp,
      vy: Math.sin(angle) * sp,
      life: randInt(20, 35),
      maxLife: 35,
      color: color,
      size: size + Math.random() * 1.5
    });
  }
}

function spawnProjectile(attacker, target) {
  let targetX = target.type === 'building' ? target.x + (target.w || BLDGS[target.btype].w)/2 : target.x;
  let targetY = target.type === 'building' ? target.y + (target.h || BLDGS[target.btype].h)/2 : target.y;
  let d = Math.sqrt((attacker.x - targetX)**2 + (attacker.y - targetY)**2);
  projectiles.push({
    x: attacker.x,
    y: attacker.y,
    startX: attacker.x,
    startY: attacker.y,
    totalDist: d,
    targetId: target.id,
    attacker: attacker
  });
  if (window.playSound) window.playSound('arrow');
}

function isUnitOnScreen(en) {
  let iso = toIso(en.x, en.y);
  let sx = iso.ix - camX + W/2;
  let sy = iso.iy - camY + topH + H/2;
  return sx >= -50 && sx <= W + 50 && sy >= -50 && sy <= H + 50;
}
