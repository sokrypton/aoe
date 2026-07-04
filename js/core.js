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
// The player spawns in a random corner each match (so openings aren't
// memorizable), with the enemy always in the diagonally opposite corner —
// genMap()'s mirrored resource placement works for any diagonal.
function setMapSize(sizeKey){
  MAP=MAP_SIZES[sizeKey]||MAP_SIZES.medium;
  let lo=10, hi=MAP-13;
  let corners=[[lo,lo],[hi,lo],[lo,hi],[hi,hi]];
  let c=corners[randInt(0,3)];
  STARTS=[
    {team:0,x:c[0],y:c[1]},
    {team:1,x:c[0]===lo?hi:lo,y:c[1]===lo?hi:lo}
  ];
}
// Gaia (neutral sheep/bears), not a player team — named so a future 3rd+
// player team is a color-array entry away, not a hunt for bare "2"s.
const GAIA_TEAM = 2;
// Real player teams only; room to add a 3rd without colliding with GAIA_COLOR.
const PLAYER_TEAM_COLORS = ['#2266bb', '#dd3b3b'];
const GAIA_COLOR = '#cccc88';
// Absolute lookup (team 0 always blue, team 1 always red) regardless of viewer.
function teamColor(team){
  return team === GAIA_TEAM ? GAIA_COLOR : PLAYER_TEAM_COLORS[team];
}
// Darker variant per team, for building art's shaded/shadow side — kept as
// its own hand-picked pair (not a generic darkenColor() pass) since
// building art wants a specific darker tone, not a percentage darken.
const PLAYER_TEAM_COLORS_DARK = ['#1a4488', '#993333'];
const GAIA_COLOR_DARK = '#999966';
function teamColorDark(team){
  return team === GAIA_TEAM ? GAIA_COLOR_DARK : PLAYER_TEAM_COLORS_DARK[team];
}
// Game-seconds per real second (AoE2 "1.7x speed" = 1.7 game-seconds/sec);
// all rates below are authored in real AoE2 game-seconds at 30 ticks each.
// Mutable: the main menu's Speed option sets it via setGameSpeed() (init.js).
let GAME_SPEED = 2;
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
  // buildTime is villager-work ticks (1 builder = 1 tick of progress per game
  // tick, 30 ticks/game-second), matching AoE2 1-villager build times.
  // armor is {m: melee, p: pierce} — see damageEntity() in logic.js.
  TC:{name:'Town Center',w:3,h:3,hp:2400,cost:{w:275,s:100},builds:['villager'],buildTime:4500,garrisonCap:15,armor:{m:3,p:5},desc:'Town Center. Trains villagers and accepts resource dropoffs. Garrison up to 15 units for protection and extra arrows.',icon:'🏰'},
  HOUSE:{name:'House',w:1,h:1,hp:550,cost:{w:25},pop:5,buildTime:750,armor:{m:0,p:7},desc:'Increases population capacity by 5.',icon:'🏠'},
  LCAMP:{name:'Lumber Camp',w:1,h:1,hp:600,cost:{w:100},drop:'wood',buildTime:1050,armor:{m:0,p:7},desc:'Drop site for Wood.',icon:'🪓'},
  MCAMP:{name:'Mining Camp',w:1,h:1,hp:600,cost:{w:100},drop:'gold,stone',buildTime:1050,armor:{m:0,p:7},desc:'Drop site for Gold and Stone.',icon:'⛏️'},
  MILL:{name:'Mill',w:2,h:2,hp:600,cost:{w:100},drop:'food',buildTime:1050,armor:{m:0,p:7},desc:'Drop site for Food. Necessary to plant Farms.',icon:'🛞'},
  // isFarm buildings only turn their ORIGIN tile (x,y) into actual farmland
  // (see createBuilding in entities.js) — the extra footprint is just a
  // bigger plot of tilled ground for the crop art to fill, not extra food.
  FARM:{name:'Farm',w:2,h:2,hp:480,cost:{w:60},isFarm:true,food:175,buildTime:450,armor:{m:0,p:0},desc:'Constant source of Food. Placed on flat land.',icon:'🌱'},
  BARRACKS:{name:'Barracks',w:2,h:2,hp:1200,cost:{w:175},builds:['militia','spearman','archer','scout'],buildTime:1500,armor:{m:0,p:7},desc:'Trains infantry, archers, and light cavalry.',icon:'⚔️'},
  TOWER:{name:'Watch Tower',w:1,h:1,hp:1020,cost:{w:25,s:125},range:8,atk:5,buildTime:2400,garrisonCap:5,armor:{m:1,p:7},desc:'Defensive tower. Automatically shoots arrows at nearby enemies. Garrison up to 5 units for extra arrows.',icon:'🗼'},
  WALL:{name:'Stone Wall',w:1,h:1,hp:900,cost:{s:5},buildTime:240,armor:{m:8,p:10},desc:'Heavy stone defensive barrier to block chokepoints.',icon:'🧱'},
  GATE:{name:'Gate',w:1,h:1,hp:2750,cost:{s:30},buildTime:2100,armor:{m:6,p:6},desc:'Wall opening. Automatically opens for allied units.',icon:'🚪'}
};
// speed is tiles per game-second; trainTime/rof are ticks (30/game-second).
// rof = reload between attacks; armor = {m: melee, p: pierce}. All values
// track AoE2 Dark/Feudal-age stats.
const UNITS={
  villager:{name:'Villager',hp:25,atk:3,range:0,speed:0.8,rof:60,armor:{m:0,p:0},cost:{f:50},trainTime:750,desc:'Gathers resources and constructs structures.',icon:'🧑‍🌾'},
  militia:{name:'Militia',hp:40,atk:4,range:0,speed:0.9,rof:60,armor:{m:0,p:1},cost:{f:60,g:20},trainTime:630,desc:'Basic infantry soldier. Affordable defense.',icon:'🛡️'},
  spearman:{name:'Spearman',hp:45,atk:3,range:0,speed:1.0,rof:90,armor:{m:0,p:0},cost:{f:35,w:25},trainTime:660,desc:'Anti-cavalry infantry. Strong counter to scouts.',icon:'🔱'},
  archer:{name:'Archer',hp:30,atk:4,range:4,speed:0.96,rof:60,armor:{m:0,p:0},cost:{w:25,g:45},trainTime:1050,desc:'Ranged archer. Effective against infantry, weak to scouts.',icon:'🏹'},
  // 1.55 is the Feudal+ scout speed (free +0.35 at Feudal in AoE2); with no
  // age system here, the familiar fast scout is the right baseline.
  scout:{name:'Scout Cavalry',hp:45,atk:3,range:0,speed:1.55,rof:60,armor:{m:0,p:2},cost:{f:80},trainTime:900,desc:'Fast light cavalry. Effective against archers and for scouting.',icon:'🏇'},
  // Wild predator (AoE2 wolf logic, bear body): gaia team 2, lurks in the
  // wild, charges any player unit that wanders into its territory, then
  // returns to its den area when the prey escapes. Stronger than an AoE2
  // wolf (45hp/7atk vs 25/3) so a lone villager should run, but a couple
  // of militia put it down without drama.
  bear:{name:'Bear',hp:45,atk:7,range:0,speed:1.2,rof:60,armor:{m:1,p:0},cost:{f:0},trainTime:0,desc:'Wild animal. Attacks anyone who wanders too close.',icon:'🐻'},
  sheep:{name:'Sheep',hp:7,atk:0,range:0,speed:0.7,rof:60,armor:{m:0,p:0},cost:{f:0},trainTime:0,food:100,desc:'Provides Food when harvested.',icon:'🐑'},
  sheep_carcass:{name:'Sheep Carcass',hp:100,atk:0,range:0,speed:0.0,rof:60,armor:{m:0,p:0},cost:{f:0},trainTime:0,desc:'Provides Food when harvested.',icon:'🍖'}
};
// AI pacing, authored against the AoE2-rate economy (30 ticks per
// game-second; villager trains in 25 game-s, militia in 21 game-s).
// AoE2-style attack plan: the first strike is a small early raid
// (attackSize units, launched no earlier than attackTick), then each
// subsequent wave grows by waveGrowth with at least waveCooldown between
// launches — mirroring how the AoE2 AI escalates from a drush into
// progressively larger attack groups instead of one fixed army size.
// attackTick reference points: hard rushes ~8 game-minutes (a classic drush
// window), easy waits ~15. trickle is free resources per decisionInterval —
// the original AoE2's harder AIs cheated a modest resource trickle; easy
// gets none.
const AI_LEVELS={
  easy:{name:'Easy',decisionInterval:240,maxVils:12,queueLimit:1,houseBuffer:1,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:4,waveGrowth:2,waveCooldown:2700,attackTick:27000,armyReserve:5,militaryFoodReserve:0,dropSites:false,walls:false,wallVils:0,wallRadius:0,attackAdvantage:1.5,trickle:{food:0,wood:0,gold:0,stone:0}},
  standard:{name:'Medium',decisionInterval:180,maxVils:18,queueLimit:2,houseBuffer:2,buildersPerBuilding:1,maxBarracks:1,barracksVil:8,attackSize:5,waveGrowth:3,waveCooldown:2100,attackTick:18000,armyReserve:7,militaryFoodReserve:70,dropSites:true,walls:true,wallVils:10,wallRadius:6,attackAdvantage:1.15,trickle:{food:1,wood:1,gold:0,stone:0}},
  hard:{name:'Hard',decisionInterval:120,maxVils:24,queueLimit:3,houseBuffer:3,buildersPerBuilding:2,maxBarracks:2,barracksVil:7,attackSize:6,waveGrowth:4,waveCooldown:1500,attackTick:14400,armyReserve:10,militaryFoodReserve:120,dropSites:true,walls:true,wallVils:8,wallRadius:7,attackAdvantage:0.9,trickle:{food:2,wood:2,gold:1,stone:1}}
};

function randInt(min,max){
  return Math.floor(Math.random()*(max-min+1))+min;
}

// Corpse decay timeline (wall-clock ms, AoE2-style): fresh body until
// CORPSE_SKEL, then a bone/skeleton stage, fading out over the last 3s
// before CORPSE_LIFE. See drawCorpse() in render-units.js and the corpse
// cull in render.js.
const CORPSE_SKEL=12000, CORPSE_LIFE=25000;

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

// Indexed by team (0 = host/single-player, 1 = guest/AI) rather than two
// separate named globals — see resourceStore() (js/logic.js), the one place
// that should ever be used to read/write these. Array-indexed so a future
// 3rd+ team is a new array entry, not a new named global.
let resources = [
  {food:200,wood:200,gold:100,stone:200,prepaidFarms:0},
  {food:200,wood:200,gold:100,stone:200,prepaidFarms:0}
];
let popUsed=0, popCap=0;
let aiPop=0, aiPopCap=0, aiTick=0;
let placing=null, mouseX=0, mouseY=0, dragStart=null, dragEnd=null;
let gameOver=false, won=false;
// `won` is always computed/synced as "did TEAM 0 win" (js/logic.js's
// handleDeath, js/net-sync.js's applyNetSync just copies the host's own
// value verbatim) — correct as-is for the host (myTeam is always 0), but
// wrong for the guest without adjustment: a guest who actually won would
// have `won === false` (since team 0/the host lost), and the raw value
// would show them a "DEFEAT" screen for winning. Every UI-facing read of
// game outcome should go through this instead of the raw `won` variable.
function didIWin(){
  return myTeam === 0 ? won : !won;
}
let lastSelKey='';
let gameStarted=false, gamePaused=false, aiDifficulty='standard';

// ---- MULTIPLAYER (see js/net.js) ----
// myTeam: which team THIS browser tab plays as. Always 0 in single-player
// and for the host (host keeps its existing team-0 identity); becomes 1 on
// a guest right after joining, since the guest replaces the AI on team 1.
// netRole: null (single-player) | 'host' | 'guest'. netConn/netConnected
// track the PeerJS DataConnection itself.
let myTeam=0, netRole=null;
let netConn=null, netConnected=false;
// dirtyMapCells: tiles the host has changed since its last sync broadcast
// (see js/net-sync.js). guestNeedsFullSync forces the next payload to carry
// the whole `map` instead of just deltas — set on every fresh/re- connection
// (js/init.js's onNetConnectionOpen) so a (re)joining guest always gets a
// complete base to apply deltas onto, never partial state.
let dirtyMapCells=[];
let guestNeedsFullSync=true;
// Cheap no-op in single-player (netRole stays null) and on the guest itself
// (which never mutates the authoritative map) — only the host's own writes
// need tracking for the next broadcast.
function markMapDirty(x,y){
  if(netRole==='host') dirtyMapCells.push({x,y});
}

// Which tile the falling-tree animation started on, and when — LOCAL-ONLY,
// keyed by "x,y" rather than stored as a `fellTick` field directly on the
// map tile object (js/render-terrain.js used to do this). Same bug shape
// as scoutedByMe above: every wood-chop decrements a tile's `res`, which
// calls markMapDirty() and sends that tile as a dirty-cell delta — on the
// GUEST, applying that delta means `map[y][x] = cell` (a brand-new object
// from the wire), wiping out whatever `fellTick` had been set on the OLD
// object. Since the tree-falling trigger is `if (res<=60 && fellTick===
// undefined)`, every single subsequent chop below that threshold saw a
// fresh `undefined` and restarted the fall animation from scratch —
// reported as "the tree falling sequence keeps repeating over and over".
let treeFellTicks = new Map();

// Same shape of bug, two more instances found in the same audit:
// - corpseImpactFxDone: which corpse ids have already played their one-time
//   ground-impact dust puff (js/render-units.js's drawCorpse). Used to live
//   as `c.impactFx` directly on the corpse object — corpses get wholesale-
//   replaced by every sync (`corpses = data.corpses`, js/net-sync.js), so
//   the guest kept re-triggering the puff on every sync instead of once.
// - workSwingCycles: per-unit last work-swing cycle that already fired its
//   impact particle (js/render-units.js) — was `e._swingCyc` directly on
//   the entity, wiped by sync's wholesale entity replacement.
let corpseImpactFxDone = new Set();
let workSwingCycles = new Map();

// Guest-only: reconstructs host-only particle side-effects (hit/death
// blood, building smoke/fire, gather puffs) by diffing each sync against
// the last one, instead of the host sending new messages for them.
// guestPrevHp: entity id -> hp as of last sync (detects damage taken).
// guestReactedCorpses: corpse ids already given their one-shot death burst.
let guestPrevHp = new Map();
let guestReactedCorpses = new Set();
// Per-building last-fired tick for the guest's damage smoke/fire loop
// (advanceGuestBuildingEffects, js/loop.js) — a bare tick%N check doesn't
// work since the guest's tick advances fractionally, not per whole tick.
let guestBuildingFxTick = new Map();

// ---- NEW SPEC GAME STATE & HELPERS ----
let fog=[], projectiles=[], particles=[];
let nextProjectileId = 1;

// Projectiles/corpses/cmdMarkers are "create-once" — deterministic (or
// purely locally-aged) after creation, so js/net-sync.js's buildSyncPayload
// sends each kind's full list only on a fresh join/reconnect, and just the
// new ones since last time otherwise (same idea as mapDelta). One registry
// instead of three copy-pasted pending-array/push-site/branch trios — a 4th
// kind is one new entry here. `live()` returns the current full array;
// `map()` strips to wire fields.
const SYNC_BUFFERS = {
  projectiles: {
    pending: [],
    live: () => projectiles,
    map: p => ({
      id: p.id, x: p.x, y: p.y, startX: p.startX, startY: p.startY,
      startH: p.startH, tx: p.tx, ty: p.ty, totalDist: p.totalDist
    })
  },
  corpses: { pending: [], live: () => corpses, map: c => c }
  // cmdMarkers are deliberately NOT here: a marker is click feedback for
  // whoever clicked, generated locally on that client (js/input.js) and
  // never during a replayed remote command — networking them only ever
  // leaked the host's own clicks (selection targets, rally points) onto
  // the guest's screen, telling the opponent exactly where the host was
  // commanding.
};
function markPendingSync(kind, item){ SYNC_BUFFERS[kind].pending.push(item); }

// Host-only: id -> JSON of the last entity snapshot sent to the guest.
// Unlike SYNC_BUFFERS, entities aren't create-once (they change constantly)
// — but at idle nothing changes, and resending the whole array anyway
// (measured at ~85% of the idle payload) was pure waste. Diffed against
// this every delta sync so only actually-changed entities get resent.
let lastSentEntitySnapshot = new Map();
// ids of enemy buildings THIS client has ever seen at active vision (2) —
// lives outside the synced entity data so it survives the wholesale
// entity replace on each sync (host tracks team 0's scouting, guest
// independently tracks team 1's).
let scoutedByMe = new Set();
function markScoutedBuildings(){
  entities.forEach(e => {
    if (e.type === 'building' && e.team !== myTeam && !scoutedByMe.has(e.id) && buildingFogLevel(e) === 2) {
      scoutedByMe.add(e.id);
    }
  });
}

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

// Shared vision math used both by updateFog() (each client's own live fog,
// for whichever team is "me" locally) and updateTeamExploredEver() below
// (persistent memory of the OTHER team's explored history) — factored out
// so the sight-radius table only lives in one place. Calls cb(x,y) for
// every currently-visible tile around every entity on `team`.
function forEachVisibleTile(team, cb){
  entities.forEach(e => {
    if (e.team !== team) return;

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
      // Footprint spans [e.x, e.x+w) — center tile is Math.floor, not round
      // (round pushes odd-sized buildings, incl. the 3x3 TC, one tile off).
      cx = Math.floor(e.x + (e.w || b.w)/2);
      cy = Math.floor(e.y + (e.h || b.h)/2);
    }

    for (let dy = -sight; dy <= sight; dy++) {
      for (let dx = -sight; dx <= sight; dx++) {
        // Euclidean (circle) works for every real sight radius (3+), but at
        // sight=1 (a fresh foundation) it degenerates to a plus-shape,
        // missing the 4 diagonal corners — use a square there instead.
        let inRange = sight === 1 ? (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) : (dx*dx + dy*dy <= sight*sight);
        if (inRange) {
          let tx = cx + dx;
          let ty = cy + dy;
          if (tx >= 0 && tx < MAP && ty >= 0 && ty < MAP) cb(tx, ty);
        }
      }
    }
  });
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

  // 2. Set visible tiles around MY OWN units/buildings. Each client only
  // computes/uses its own team's fog locally — fog is never sent over the
  // network, so host (team 0) and guest (team 1) never conflict.
  forEachVisibleTile(myTeam, (tx, ty) => { fog[ty][tx] = 2; });
}

// Persistent record of every tile the OTHER team has ever seen, computed
// the same way that team computes its own live fog, but from THIS client's
// perspective. Unlike `fog`, this survives the other side's tab closing —
// lets a rejoining guest recover its explored map (host tracks index 1;
// see buildSyncPayload's `exploredEver`) and lets a guest-originated save
// restore the host's fog too, since whoever loads a save becomes the new
// host (js/save.js) regardless of who saved it (guest tracks index 0 for
// this case). Indexed by team rather than two mirror-image variables —
// only the host can usefully update index 1 (has the guest's real
// positions every tick), only the guest can update index 0 (only gets the
// host's positions via sync).
let teamExploredEver = {0: new Set(), 1: new Set()};
function updateTeamExploredEver(team){
  if (window.fogDisabled) return;
  if (team === 1 && netRole !== 'host') return;
  if (team === 0 && netRole !== 'guest') return;
  forEachVisibleTile(team, (tx, ty) => { teamExploredEver[team].add(ty * MAP + tx); });
}

// Host-only memory of the guest's last-reported camera position (sent via
// the 'guest-view' message) — lets a (re)connecting guest restore its pan
// position instead of recentering, since the host outlives a guest reload.
let hostKnownGuestCam = null;

// One-shot / session-lifecycle flags for the MP connection, consolidated
// from scattered ad hoc `window.__flag` properties into one place:
//   cameraCentered      — has this guest tab centered its camera yet
//   hostJustLoadedSave  — host just loaded a save mid-match; next full
//                          sync should force the guest to re-center
//   loadedHostPeerId    — peer id to request when re-hosting from a save
//   hostPeerId          — the host's peer id this client knows
//   bottomHeightSet     — has the guest's bottom-bar height been computed
//   guestInitialMenuHidden — has the guest's pre-match panel been dismissed
window.__mpSession = {
  cameraCentered: false,
  hostJustLoadedSave: false,
  loadedHostPeerId: null,
  hostPeerId: null,
  bottomHeightSet: false,
  guestInitialMenuHidden: false,
};

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

// AoE2-style ballistics: arrows fly to a fixed ground POSITION (where the
// target was at fire time), not to the target entity — so fast units can
// dodge by moving, and a shot lands on whoever is standing at the impact
// point. Archers have 80% accuracy (a miss scatters the aim point);
// tower/TC fire is 100% accurate, as in AoE2.
function spawnProjectile(attacker, target) {
  let targetX = target.type === 'building' ? target.x + (target.w || BLDGS[target.btype].w)/2 : target.x;
  let targetY = target.type === 'building' ? target.y + (target.h || BLDGS[target.btype].h)/2 : target.y;
  let accuracy = attacker.type === 'building' ? 1.0 : 0.8;
  if (target.type !== 'building' && Math.random() > accuracy) {
    let ang = Math.random() * Math.PI * 2;
    let off = 0.6 + Math.random() * 0.8;
    targetX += Math.cos(ang) * off;
    targetY += Math.sin(ang) * off;
  }
  let d = Math.sqrt((attacker.x - targetX)**2 + (attacker.y - targetY)**2);
  let proj = {
    id: nextProjectileId++,
    x: attacker.x,
    y: attacker.y,
    startX: attacker.x,
    startY: attacker.y,
    // Launch height: towers/TC fire from their battlements, units from
    // chest height — drawProjectiles blends this down to impact height.
    startH: attacker.type === 'building' ? (attacker.btype === 'TC' ? 55 : 36) : 12,
    totalDist: d,
    tx: targetX,
    ty: targetY,
    // Buildings can't sidestep — a shot at a building always connects.
    targetBuildingId: target.type === 'building' ? target.id : null,
    attacker: attacker
  };
  projectiles.push(proj);
  // Flight is fully deterministic (fixed start/target/speed — see
  // js/loop.js's update() and its guest-side twin advanceGuestProjectiles)
  // — the network sync only ever needs to tell the guest about a NEW
  // projectile once, not keep resending its position every ~65ms (see
  // SYNC_BUFFERS above).
  markPendingSync('projectiles', proj);
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
