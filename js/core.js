const C=document.getElementById('game');
// X is reassignable (not const): drawSelectedUnitOutlines() briefly redirects
// it to an offscreen buffer so it can reuse drawUnit() itself to capture a
// unit's exact silhouette, instead of maintaining a separate outline shape.
let X=C.getContext('2d');
const MC=document.getElementById('minimap'),MX=MC.getContext('2d');
const isMobile='ontouchstart' in window||navigator.maxTouchPoints>0;
// Command markers (visual feedback when you issue a command)
let cmdMarkers=[]; // {x,y,time,color}
let bottomH=isMobile?(window.innerWidth<=380?175:window.innerWidth<=600?200:200):200;
let topH=isMobile?(window.innerWidth<=600?46:36):36;
const dpr = Math.max(1, window.devicePixelRatio || 1);
const ZOOM_MIN = 0.6, ZOOM_MAX = 2.5;
let ZOOM = isMobile ? 1.5 : 1.0;
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
// Approximate on-screen structure height (px, pre-zoom) per building type —
// footprint diamonds alone don't capture how tall a building actually
// paints, which matters for anything doing screen-space hit-testing against
// a building's visual silhouette (click-to-select in input.js, and the
// behind-a-building outline check in render.js).
const BLDG_HEIGHTS = {
  TC: 80, BARRACKS: 32, HOUSE: 26, LCAMP: 26, MCAMP: 26,
  MILL: 32, FARM: 6, TOWER: 58, WALL: 26, GATE: 32
};
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
  TC:{name:'Town Center',w:3,h:3,hp:2400,cost:{w:275,s:100},builds:['villager'],buildTime:900,garrisonCap:15,desc:'Town Center. Trains villagers and accepts resource dropoffs. Garrison up to 15 units for protection and extra arrows.',icon:'🏰'},
  HOUSE:{name:'House',w:1,h:1,hp:550,cost:{w:25},pop:5,buildTime:150,desc:'Increases population capacity by 5.',icon:'🏠'},
  LCAMP:{name:'Lumber Camp',w:1,h:1,hp:600,cost:{w:100},drop:'wood',buildTime:210,desc:'Drop site for Wood.',icon:'🪓'},
  MCAMP:{name:'Mining Camp',w:1,h:1,hp:600,cost:{w:100},drop:'gold,stone',buildTime:210,desc:'Drop site for Gold and Stone.',icon:'⛏️'},
  MILL:{name:'Mill',w:2,h:2,hp:600,cost:{w:100},drop:'food',buildTime:210,desc:'Drop site for Food. Necessary to plant Farms.',icon:'🛞'},
  // isFarm buildings only turn their ORIGIN tile (x,y) into actual farmland
  // (see createBuilding in entities.js) — the extra footprint is just a
  // bigger plot of tilled ground for the crop art to fill, not extra food.
  FARM:{name:'Farm',w:2,h:2,hp:100,cost:{w:60},isFarm:true,food:300,buildTime:90,desc:'Constant source of Food. Placed on flat land.',icon:'🌱'},
  BARRACKS:{name:'Barracks',w:2,h:2,hp:1200,cost:{w:175},builds:['militia','spearman','archer','scout'],buildTime:300,desc:'Trains infantry, archers, and light cavalry.',icon:'⚔️'},
  TOWER:{name:'Watch Tower',w:1,h:1,hp:700,cost:{w:125,s:50},range:5,atk:5,buildTime:480,garrisonCap:5,desc:'Defensive tower. Automatically shoots arrows at nearby enemies. Garrison up to 5 units for extra arrows.',icon:'🗼'},
  WALL:{name:'Stone Wall',w:1,h:1,hp:1000,cost:{s:5},buildTime:30,desc:'Heavy stone defensive barrier to block chokepoints.',icon:'🧱'},
  GATE:{name:'Gate',w:1,h:1,hp:2750,cost:{w:30,s:20},buildTime:210,desc:'Wall opening. Automatically opens for allied units.',icon:'🚪'}
};
const UNITS={
  villager:{name:'Villager',hp:25,atk:3,range:0,speed:1.0,cost:{f:50},trainTime:120,desc:'Gathers resources and constructs structures.',icon:'🧑‍🌾'},
  militia:{name:'Militia',hp:40,atk:4,range:0,speed:1.12,cost:{f:60,g:20},trainTime:100,desc:'Basic infantry soldier. Affordable defense.',icon:'🛡️'},
  spearman:{name:'Spearman',hp:35,atk:3,range:0,speed:1.25,cost:{f:35,w:25},trainTime:105,desc:'Anti-cavalry infantry. Strong counter to scouts.',icon:'🔱'},
  archer:{name:'Archer',hp:30,atk:4,range:4,speed:1.20,cost:{w:25,g:45},trainTime:167,desc:'Ranged archer. Effective against infantry, weak to scouts.',icon:'🏹'},
  scout:{name:'Scout Cavalry',hp:45,atk:3,range:0,speed:1.50,cost:{f:80},trainTime:143,desc:'Fast light cavalry. Effective against archers and for scouting.',icon:'🏇'},
  sheep:{name:'Sheep',hp:8,atk:0,range:0,speed:1.0,cost:{f:0},trainTime:0,food:100,desc:'Provides Food when harvested.',icon:'🐑'},
  sheep_carcass:{name:'Sheep Carcass',hp:100,atk:0,range:0,speed:0.0,cost:{f:0},trainTime:0,desc:'Provides Food when harvested.',icon:'🍖'}
};
const AI_LEVELS={
  easy:{name:'Easy',decisionInterval:240,maxVils:9,queueLimit:1,houseBuffer:1,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:7,attackTick:3900,armyReserve:5,militaryFoodReserve:0,dropSites:false,walls:false,wallVils:0,wallRadius:0,attackAdvantage:1.5,trickle:{food:1,wood:1,gold:0,stone:0}},
  standard:{name:'Medium',decisionInterval:180,maxVils:14,queueLimit:2,houseBuffer:2,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:9,attackTick:2700,armyReserve:7,militaryFoodReserve:70,dropSites:true,walls:true,wallVils:10,wallRadius:6,attackAdvantage:1.15,trickle:{food:2,wood:1,gold:1,stone:0}},
  hard:{name:'Hard',decisionInterval:120,maxVils:20,queueLimit:3,houseBuffer:3,buildersPerBuilding:2,maxBarracks:2,barracksVil:7,attackSize:10,attackTick:2100,armyReserve:10,militaryFoodReserve:120,dropSites:true,walls:true,wallVils:8,wallRadius:7,attackAdvantage:0.9,trickle:{food:3,wood:2,gold:1,stone:0}}
};

function randInt(min,max){
  return Math.floor(Math.random()*(max-min+1))+min;
}

// ---- GAME STATE ----
let map=[], entities=[], entitiesById=new Map(), corpses=[], selected=[], camX=0, camY=0, tick=0;

// Zoom in/out while keeping the world point under screen point (sx,sy) fixed
// in place — used by both wheel zoom (desktop) and pinch zoom (mobile).
function setZoomAroundPoint(newZoom, sx, sy){
  newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
  if(newZoom === ZOOM) return;
  let isoX = (sx - W/2)/ZOOM + camX;
  let isoY = (sy - (H/2 + topH))/ZOOM + camY;
  ZOOM = newZoom;
  camX = isoX - (sx - W/2)/ZOOM;
  camY = isoY - (sy - (H/2 + topH))/ZOOM;
  window.cameraFollowId = null;
}

let res={food:200,wood:200,gold:100,stone:200,prepaidFarms:0};
let popUsed=0, popCap=0;
let aiRes={food:200,wood:200,gold:100,stone:200,prepaidFarms:0}, aiPop=0, aiPopCap=0, aiTick=0;
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
  let type = 'dust';
  if (color === '#9c382a') type = 'blood';
  else if (color.includes('rgba(100,100,100') || color === '#888' || color === '#666') type = 'smoke';
  else if (color === '#ff4500' || color === '#ff8c00' || color === '#ffd700') type = 'fire';
  else if (color === '#4e8c2d') type = 'grass';

  for (let i = 0; i < count; i++) {
    let angle = Math.random() * Math.PI * 2;
    let sp = Math.random() * speed;
    let maxLife = type === 'blood' ? randInt(40, 60) : randInt(20, 35);
    
    let z = 0;
    let vz = 0;
    let gravity = 0;
    let drag = 1.0;
    
    if (type === 'blood') {
      z = 0.35 + Math.random() * 0.2; // Torso level
      vz = 0.02 + Math.random() * 0.03;
      gravity = 0.003;
      drag = 0.96;
    } else if (type === 'fire') {
      z = 0.1;
      vz = 0.01 + Math.random() * 0.015;
      gravity = -0.0003;
      drag = 0.98;
    } else if (type === 'smoke') {
      z = 0.2;
      vz = 0.008 + Math.random() * 0.012;
      gravity = -0.0002;
      drag = 0.95;
    } else if (type === 'dust' || type === 'grass') {
      z = 0.05;
      vz = 0.02 + Math.random() * 0.03;
      gravity = 0.004;
      drag = 0.94;
    }

    particles.push({
      x: x + (Math.random() - 0.5) * 0.3,
      y: y + (Math.random() - 0.5) * 0.3,
      z: z,
      vx: Math.cos(angle) * sp,
      vy: Math.sin(angle) * sp,
      vz: vz,
      gravity: gravity,
      drag: drag,
      life: maxLife,
      maxLife: maxLife,
      color: color,
      type: type,
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
    // Launch height: towers/TC fire from their battlements, units from
    // chest height — drawProjectiles blends this down to impact height.
    startH: attacker.type === 'building' ? (attacker.btype === 'TC' ? 55 : 36) : 12,
    totalDist: d,
    targetId: target.id,
    attacker: attacker
  });
  if (window.playSound) window.playSound('arrow', attacker.x, attacker.y);
}

function isUnitOnScreen(en) {
  let iso = toIso(en.x, en.y);
  let sx = (iso.ix - camX) * ZOOM + W/2;
  let sy = (iso.iy - camY + HALF_TH) * ZOOM + H/2 + topH;
  return sx >= -50 * ZOOM && sx <= W + 50 * ZOOM && sy >= -50 * ZOOM && sy <= H + 50 * ZOOM;
}

function getUnitGroupOffset(entityId) {
  let idOff = entityId % 7;
  return {
    ox: (idOff % 3 - 1) * 6,
    oy: (Math.floor(idOff / 3) - 1) * 4
  };
}
