const C=document.getElementById('game'),X=C.getContext('2d');
const MC=document.getElementById('minimap'),MX=MC.getContext('2d');
const isMobile='ontouchstart' in window||navigator.maxTouchPoints>0;
// Show correct tutorial section
if(isMobile){document.getElementById('tut-desktop').style.display='none';document.getElementById('tut-mobile').style.display='block';}
// Command markers (visual feedback when you issue a command)
let cmdMarkers=[]; // {x,y,time,color}
let bottomH=isMobile?(window.innerWidth<=380?130:window.innerWidth<=600?150:200):200;
let topH=isMobile?(window.innerWidth<=600?28:32):32;
const dpr = window.devicePixelRatio || 1;
let ZOOM = 1.35;
let W=window.innerWidth,H=window.innerHeight-bottomH;
C.width=W*dpr;C.height=window.innerHeight*dpr;
C.style.width=W+'px';C.style.height=window.innerHeight+'px';
X.scale(dpr,dpr);

// ---- CONSTANTS ----
const MAP=60, TW=64, TH=32, HALF_TW=32, HALF_TH=16;
const STARTS=[
  {team:0,x:10,y:10},
  {team:1,x:MAP-13,y:MAP-13}
];
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
  TC:{name:'Town Center',w:2,h:2,hp:2400,cost:{w:275},builds:['villager'],icon:'🏰'},
  HOUSE:{name:'House',w:1,h:1,hp:550,cost:{w:25},pop:5,icon:'🏠'},
  LCAMP:{name:'Lumber Camp',w:1,h:1,hp:600,cost:{w:100},drop:'wood',icon:'🪓'},
  MCAMP:{name:'Mining Camp',w:1,h:1,hp:600,cost:{w:100},drop:'gold,stone',icon:'⛏️'},
  MILL:{name:'Mill',w:1,h:1,hp:600,cost:{w:100},drop:'food',icon:'🛞'},
  FARM:{name:'Farm',w:1,h:1,hp:100,cost:{w:60},isFarm:true,food:300,icon:'🌱'},
  BARRACKS:{name:'Barracks',w:2,h:2,hp:1200,cost:{w:175},builds:['militia'],icon:'⚔️'}
};
const UNITS={
  villager:{name:'Villager',hp:25,atk:3,range:0,speed:1.0,cost:{f:50},trainTime:120,icon:'🧑‍🌾'},
  militia:{name:'Militia',hp:40,atk:4,range:0,speed:1.12,cost:{f:60,g:20},trainTime:100,icon:'🛡️'},
  sheep:{name:'Sheep',hp:8,atk:0,range:0,speed:0.6,cost:{},trainTime:0,food:100,icon:'🐑'}
};
const AI_LEVELS={
  easy:{name:'Easy',decisionInterval:240,maxVils:9,queueLimit:1,houseBuffer:1,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:7,attackTick:3900,armyReserve:5,militaryFoodReserve:0,dropSites:false,trickle:{food:1,wood:1,gold:0,stone:0}},
  standard:{name:'Standard',decisionInterval:180,maxVils:14,queueLimit:2,houseBuffer:2,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:9,attackTick:2700,armyReserve:7,militaryFoodReserve:70,dropSites:true,trickle:{food:2,wood:1,gold:1,stone:0}},
  hard:{name:'Hard',decisionInterval:120,maxVils:20,queueLimit:3,houseBuffer:3,buildersPerBuilding:2,maxBarracks:2,barracksVil:7,attackSize:10,attackTick:2100,armyReserve:10,militaryFoodReserve:120,dropSites:true,trickle:{food:3,wood:2,gold:1,stone:0}}
};

function randInt(min,max){
  return Math.floor(Math.random()*(max-min+1))+min;
}

// ---- GAME STATE ----
let map=[], entities=[], corpses=[], selected=[], camX=0, camY=0, tick=0;
let globalAutoAttack=true;
let res={food:200,wood:200,gold:100,stone:200};
let popUsed=0, popCap=0;
let aiRes={food:200,wood:200,gold:100,stone:200}, aiPop=0, aiPopCap=0, aiTick=0;
let placing=null, mouseX=0, mouseY=0, dragStart=null, dragEnd=null;
let gameOver=false, won=false;
let lastSelKey='';
let gameStarted=false, aiDifficulty='standard';
