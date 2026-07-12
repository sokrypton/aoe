// ---- MULTIPLAYER: PeerJS connection plumbing ----
// This file only owns the WebRTC connection lifecycle — a HOST-RELAY STAR:
// every guest holds exactly one DataConnection to the host, and the host
// holds one per guest in a seat-keyed registry (netGuests below). Guests
// never talk to each other directly; js/net-relay.js forwards what needs
// forwarding. This file knows nothing about game state; js/lockstep.js
// (command exchange + resync) and js/net-sync.js (host-crash recovery)
// register themselves via onNetMessage() below rather than this file
// reaching into game logic directly.
//
// Guest identity: each browser generates one persistent token
// (localStorage) and announces it in a 'hello' right after connecting.
// The host binds token → seat, so a reconnect (new tab, new PeerJS id,
// same browser) lands on the same seat. Binding is EXACT-token-only — no
// takeover heuristics (a fresh unknown connection mid-match is denied,
// not guessed into a seat; pre-match it just gets a fresh lobby seat).
//
// Message envelope: every message sent over the DataConnection is a plain
// object {type: 'cmd-ls'|'tick'|'hello'|'bye'|..., ...payload}.
//
// Every message is compressed before it hits the wire: JSON.stringify →
// deflate-raw (via the browser's built-in CompressionStream) → raw bytes.
// Measured on a real ~13KB mid-game sync payload, this shrinks it to
// ~1.8KB (~7x) — JSON's repeated key names and structure compress far
// better than anything a hand-rolled key-shortening scheme would realistic-
// ally achieve, for zero ongoing maintenance cost. Applied uniformly to
// 'cmd' messages too (not just 'sync') for one code path — they're tiny
// enough that compression overhead is negligible either way. (The 13KB
// figure is from the deleted snapshot-sync mode; resync/recovery state
// payloads are far larger and benefit even more.)
//
// Since every send is already fully-encoded bytes, the connection uses
// PeerJS's serialization:'none' — sending the ArrayBuffer/Uint8Array
// straight over the RTCDataChannel with no further object-tree encoding
// layer (BinaryPack) in between.

let netPeer = null;
let netMessageHandlers = [];

// ---- HOST-SIDE GUEST REGISTRY ----
// seat -> {conn, seat, token, name, connected, lastRecvAt, kicked}.
// `seat` is the lobby seat index == the sim team id (host is always 0, so
// guest seats are 1..3). A record outlives its connection: a drop marks it
// connected=false but keeps token/seat so the same browser can rejoin its
// own seat mid-match. Only an explicit teardown (or the lobby splicing a
// departed seat) removes records.
let netGuests = new Map();
// Connections that have opened but not yet sent 'hello' — nothing but
// hello/proto is accepted from them, and they're closed if the hello
// never arrives (deadline enforced by the heartbeat sweep below).
let netPendingConns = [];
const NET_HELLO_DEADLINE_MS = 5000;

function netGuestBySeat(seat){ return netGuests.get(seat) || null; }
function netGuestByConn(conn){
  for (const r of netGuests.values()) if (r.conn === conn) return r;
  return null;
}
function netConnectedGuestSeats(){
  let seats = [];
  for (const r of netGuests.values()) if (r.connected) seats.push(r.seat);
  return seats;
}
// On the host, the netConnected global means "at least one guest is
// connected" — kept true/false here so the many existing role-agnostic
// `netConnected` checks (chat gate, net-stats, save resume) keep working.
function updateHostConnected(){
  if (netRole === 'host') netConnected = netConnectedGuestSeats().length > 0;
}

// The persistent identity announced in 'hello' is TWO-part, because one
// browser can legitimately run several tabs of the same game (local
// testing does this constantly):
//   token — per-BROWSER (localStorage): survives tab close, so a player
//           who lost their tab can reopen the link and reclaim their seat.
//   tab   — per-TAB (sessionStorage): survives reload of the same tab,
//           distinct across tabs, so two local tabs never collide.
// Binding rules (hostHandleHello): exact token+tab match always rebinds
// (same tab reloading — supersede its half-dead old connection even if the
// watchdog hasn't noticed yet); token match against a DISCONNECTED record
// rebinds (tab closed, new tab reclaiming the seat); anything else is a
// new client. Plain Math.random fallback is fine — transport identity,
// not sim.
function mpRandomId(){
  return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function mpClientToken(){
  try {
    let t = localStorage.getItem('aoeMpClientId');
    if (!t) { t = mpRandomId(); localStorage.setItem('aoeMpClientId', t); }
    return t;
  } catch (e) {
    // Storage blocked (rare) — a per-page token still allows same-tab flows.
    if (!window.__mpMemToken) window.__mpMemToken = 'mem-' + mpRandomId();
    return window.__mpMemToken;
  }
}
function mpTabId(){
  try {
    let t = sessionStorage.getItem('aoeMpTabId');
    if (!t) { t = mpRandomId(); sessionStorage.setItem('aoeMpTabId', t); }
    return t;
  } catch (e) {
    if (!window.__mpMemTab) window.__mpMemTab = 'mem-' + mpRandomId();
    return window.__mpMemTab;
  }
}

// Bumped whenever the sync/command wire format changes incompatibly (seq
// numbers, payload fields, new message types the peer must understand).
// Both peers exchange it right after connecting (onNetConnectionOpen,
// js/init.js) — this is a static GitHub Pages game, so one player having a
// stale cached build while the other has today's is a very real failure
// mode that otherwise surfaces as inexplicable desync instead of a clear
// "refresh your page".
const NET_PROTOCOL_VERSION = 12; // v12: host-relay star for up to 4 players — 'hello'/'welcome' seat binding, relayed cmd-ls/tick/chat carry `from`, per-recipient yourSeat/yourTeam in lobby-sync/lockstep-start/lockstep-resume, match-pause/set-controller; v11: pre-match lobby handshake (lobby-open/lobby-sync/lobby-seat, js/lobby.js) + names/colors in lockstep-start/lockstep-resume; ALSO genMap main-stone/gold placement search widened (js/map.js) — same seed yields a different map than v10, so mixed versions would desync; v10: battering ram is a trainable sim unit (js/core.js UNITS.ram); v9: age-up upgrade cards change sim math (js/core.js UPGRADES); v8: age system — teamAge + TC research in snapshots and simChecksum (js/core.js AGES)

// CompressionStream/DecompressionStream are stream-based (write in, read
// chunks out), so both directions are inherently async. A single already-
// fully-buffered input (our whole JSON string) drains in one microtask
// hop or two, but the ORDER two overlapping async calls happen to resolve
// in is not guaranteed to match the order they were started — and the
// rest of the system (e.g. lockstep's resync barrier assuming commands
// sent before the resync arrive before it) depends on messages being
// processed in the order they were sent/received. Each direction gets its own promise chain
// below so sends/receives are always processed strictly in call order,
// regardless of individual compress/decompress timing.
async function compressMessage(msg){
  let bytes = new TextEncoder().encode(JSON.stringify(msg));
  let cs = new CompressionStream('deflate-raw');
  let writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  let chunks = [];
  let total = 0;
  let reader = cs.readable.getReader();
  while (true) {
    let { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  let out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

async function decompressMessage(data){
  let bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let ds = new DecompressionStream('deflate-raw');
  let writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  let chunks = [];
  let total = 0;
  let reader = ds.readable.getReader();
  while (true) {
    let { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  let out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return JSON.parse(new TextDecoder().decode(out));
}

// Running totals of actual wire bytes (measured post-compression, not the
// pre-compression JSON size). Displayed in the classic skin's #net-stats
// readout below; also handy from the console when debugging sync traffic.
let netBytesSent = 0;
let netBytesReceived = 0;

// ---- NET STATS (upper-right, next to the fullscreen button) ----
// Upload/download rate + total transferred, refreshed once a second, in
// BOTH skins — but only where there's chrome room for it: hidden on touch
// devices and whenever the window is too narrow for the readout to coexist
// with the resource bar and the fullscreen/menu buttons. Display-only —
// the counters above accumulate regardless.
(function(){
  let lastSent = 0, lastRecv = 0, lastT = performance.now(), lastTick = 0;
  const fmtRate = bps => bps >= 100 * 1024
    ? (bps / (1024 * 1024)).toFixed(2) + ' MB/s'
    : (bps / 1024).toFixed(1) + ' KB/s';
  setInterval(() => {
    const el = document.getElementById('net-stats');
    if (!el) return;
    const ls = typeof lockstepEnabled === 'function' && lockstepEnabled();
    // The net/sim readout is a CLASSIC-skin feature only. The modern skin
    // (index.html) keeps its chrome clean — no transfer stats in its top
    // bar at any size. Classic shows the full ↑/↓/Σ·tps readout on desktop
    // and a compact tps/delay line on mobile lockstep matches.
    const classic = document.body.classList.contains('classic-ui');
    const roomFor = !(typeof isMobile !== 'undefined' && isMobile) && window.innerWidth >= 700;
    const active = classic && (roomFor || (isMobile && ls)) && netRole && netConnected;
    el.style.display = active ? 'flex' : 'none';
    if (!active) return;
    const now = performance.now(), dt = (now - lastT) / 1000 || 1;
    const up = (netBytesSent - lastSent) / dt;
    const down = (netBytesReceived - lastRecv) / dt;
    // Sim pace: ticks actually produced per real second. Full rate is
    // 30*GAME_SPEED (60 at the default 2x); lower means the lockstep gate
    // (connection) or the device itself can't keep up. d = current input
    // delay in ticks (the adaptive buffer, js/lockstep.js).
    const t = Math.floor(tick);
    const tps = gameStarted && !gamePaused ? Math.max(0, Math.round((t - lastTick) / dt)) : 0;
    lastTick = t;
    lastSent = netBytesSent; lastRecv = netBytesReceived; lastT = now;
    const simTxt = ls ? (tps + 'tps d' + INPUT_DELAY_TICKS) : (tps + 'tps');
    if (roomFor) {
      const totalMB = ((netBytesSent + netBytesReceived) / (1024 * 1024)).toFixed(2);
      el.textContent = '↑ ' + fmtRate(up) + '  ↓ ' + fmtRate(down) + '  Σ ' + totalMB + ' MB  ·  ' + simTxt;
    } else {
      el.textContent = simTxt; // compact mobile lockstep readout
    }
  }, 1000);
  // The 1s cadence would leave the box overlapping the resource bar for up
  // to a second after a shrink — hide immediately on resize instead.
  window.addEventListener('resize', () => {
    const el = document.getElementById('net-stats');
    if (el && window.innerWidth < 700) el.style.display = 'none';
  });
})();

// Dev-only fault injection, settable from the console (nothing in the app
// sets these). Chrome's network throttling does NOT touch WebRTC, so this
// is the practical way to reproduce real-link conditions on one machine:
//   NET_TEST_DELAY_MS = 300      // serial per-message delay (throughput cap)
//   NET_TEST_DROP_RATE = 0.05    // randomly drop 5% of outgoing messages
let sendQueue = Promise.resolve();
function queueSend(conn, msg){
  sendQueue = sendQueue
    .then(() => compressMessage(msg))
    .then(bytes => window.NET_TEST_DELAY_MS
      ? new Promise(res => setTimeout(() => res(bytes), window.NET_TEST_DELAY_MS))
      : bytes)
    .then(bytes => {
      // NET_TEST_LATENCY_MS: PARALLEL per-message latency (unlike
      // NET_TEST_DELAY_MS above, which serializes and therefore caps
      // throughput) — the realistic way to fake link RTT. Equal timeout
      // per message keeps FIFO ordering.
      if (window.NET_TEST_LATENCY_MS) {
        let delayed = bytes;
        setTimeout(() => {
          if (!netConnected || !conn) return;
          netBytesSent += delayed.length;
          try { conn.send(delayed); } catch (e) {}
        }, window.NET_TEST_LATENCY_MS);
        return;
      }
      if (window.NET_TEST_DROP_RATE && Math.random() < window.NET_TEST_DROP_RATE) return;
      netBytesSent += bytes.length;
      conn.send(bytes);
    })
    .catch(err => console.error('Net send failed (message dropped):', err));
}

let recvQueue = Promise.resolve();
// `conn` is passed on the HOST so the message can be attributed to a seat
// at dispatch time (after the async decompress — the binding may complete
// between arrival and dispatch, and FIFO ordering guarantees the hello
// that binds it is processed first). Guests pass nothing: their only link
// is the host.
function queueReceive(data, conn){
  netBytesReceived += (data instanceof Uint8Array ? data : new Uint8Array(data)).length;
  recvQueue = recvQueue
    .then(() => decompressMessage(data))
    .then(msg => {
      if (netRole === 'host' && conn) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'hello') { hostHandleHello(msg, conn); return; }
        let rec = netGuestByConn(conn);
        if (!rec) {
          // Unbound connection: nothing but proto is meaningful before
          // its hello arrives — drop everything else unattributed.
          if (msg.type === 'proto') dispatchNetMessage(msg, { conn });
          return;
        }
        dispatchNetMessage(msg, { seat: rec.seat });
      } else {
        dispatchNetMessage(msg);
      }
    })
    .catch(err => console.error('Net receive failed (message dropped):', err));
}

// Registers a callback invoked for every incoming message; lockstep.js,
// net-sync.js, and chat.js each add one for the message types they care
// about, rather than this file needing to know payload shapes.
// Handlers receive (msg, src): on the HOST, src.seat identifies which
// guest sent it (bound via the hello handshake — this is the ONLY place a
// message's origin comes from; any team/seat field a guest put in the
// payload itself is never trusted). On a guest, src is undefined — the
// only sender is the host, and relayed messages carry the host-stamped
// `from` seat in the payload.
function onNetMessage(handler){
  netMessageHandlers.push(handler);
}

function dispatchNetMessage(msg, src){
  if (!msg || typeof msg !== 'object' || !msg.type) return;
  netMessageHandlers.forEach(h => {
    try { h(msg, src); } catch (err) { console.error('Net message handler failed:', err); }
  });
}

// PeerJS's own 'close' event is NOT reliable for an abrupt tab close/kill:
// WebRTC often can't signal a clean close when the page just vanishes, so
// 'close' can arrive very late or never (confirmed by testing an actual
// browser-context close — the peer sat "connected" indefinitely). A
// lightweight heartbeat is the robust way to detect this ourselves rather
// than trusting the transport to always tell us: both sides send a tiny
// 'ping' periodically (through the same compressed pipeline as everything
// else — negligible size), and a watchdog flags the connection as dead if
// nothing at all has arrived in a while, regardless of whether PeerJS ever
// fires 'close'.
// Pings are tiny (a few dozen bytes through the already-compressed
// pipeline) so a fast interval costs nothing bandwidth-wise — the real
// constraint is keeping enough margin over it that a single delayed/
// dropped packet, or a backgrounded tab's setInterval throttling, doesn't
// misfire as a false "disconnected". 4x margin, same ratio as the initial
// (slower) values this replaced.
const NET_HEARTBEAT_MS = 1000;
const NET_TIMEOUT_MS = 4000;
let lastNetRecvAt = 0;

// GUEST-side loss of the (single) host link. The host's per-guest
// equivalent is handleGuestConnectionLost below.
function handleConnectionLost(){
  if (!netConnected) return; // already handled (real 'close' or a prior watchdog trip) — don't double-fire
  netConnected = false;
  netConn = null;
  if (window.onNetConnectionClosed) window.onNetConnectionClosed();
}

// HOST-side loss of ONE guest. The record stays in the registry
// (connected=false) so the same token can rejoin its seat — only teardown
// or the lobby removing the seat deletes it.
function handleGuestConnectionLost(seat){
  let rec = netGuests.get(seat);
  if (!rec || !rec.connected) return; // already handled — don't double-fire
  rec.connected = false;
  rec.conn = null;
  updateHostConnected();
  if (window.onGuestConnectionClosed) window.onGuestConnectionClosed(seat);
}

setInterval(() => {
  const now = performance.now();
  if (netRole === 'host') {
    for (const rec of netGuests.values()) {
      if (!rec.connected) continue;
      queueSend(rec.conn, { type: 'ping' });
      if (now - rec.lastRecvAt > NET_TIMEOUT_MS) handleGuestConnectionLost(rec.seat);
    }
    // Sweep connections that opened but never sent their hello.
    netPendingConns = netPendingConns.filter(p => {
      if (now - p.openedAt > NET_HELLO_DEADLINE_MS) {
        try { p.conn.close(); } catch (e) {}
        return false;
      }
      return true;
    });
  } else if (netConnected) {
    queueSend(netConn, { type: 'ping' });
    if (now - lastNetRecvAt > NET_TIMEOUT_MS) handleConnectionLost();
  }
}, NET_HEARTBEAT_MS);

// GUEST side: wire the single connection to the host.
function wireGuestConnection(conn){
  netConn = conn;
  lastNetRecvAt = performance.now();
  conn.on('open', () => {
    netConnected = true;
    lastNetRecvAt = performance.now();
    if (window.onNetConnectionOpen) window.onNetConnectionOpen();
  });
  conn.on('data', (data) => {
    // A superseded connection (guest reconnected; old conn's close hasn't
    // landed yet) must neither feed the liveness watchdog nor dispatch
    // stale messages — same netConn guard the 'close' handler uses.
    if (netConn !== conn) return;
    lastNetRecvAt = performance.now();
    queueReceive(data);
  });
  conn.on('close', () => {
    if (netConn === conn) handleConnectionLost();
  });
  conn.on('error', (err) => {
    console.error('PeerJS connection error:', err);
    if (window.showMsg) showMsg('Connection error — see console');
  });
}

// HOST side: wire an incoming connection. It starts life unbound (pending)
// and only joins the registry once its 'hello' names a token — see
// hostHandleHello. The proto version announcement goes out immediately so
// even a client that will be denied learns about a version mismatch.
function wireHostConnection(conn){
  netPendingConns.push({ conn, openedAt: performance.now() });
  conn.on('open', () => {
    queueSend(conn, { type: 'proto', v: NET_PROTOCOL_VERSION });
  });
  conn.on('data', (data) => {
    let rec = netGuestByConn(conn);
    if (rec) rec.lastRecvAt = performance.now();
    queueReceive(data, conn);
  });
  conn.on('close', () => {
    let rec = netGuestByConn(conn);
    if (rec) handleGuestConnectionLost(rec.seat);
    netPendingConns = netPendingConns.filter(p => p.conn !== conn);
  });
  conn.on('error', (err) => {
    console.error('PeerJS connection error:', err);
  });
}

// The hello names the guest's persistent identity (token + tab — see
// mpClientToken above for the binding rules). A match reclaims its seat,
// superseding any half-dead old connection (the identity-based version of
// the old "always accept the new connection" rule). Unknown identity →
// ask the session layer (js/init.js / js/lobby.js own the seating rules)
// for a fresh seat; null means denied.
function hostHandleHello(msg, conn){
  // Exact same tab (reload) → its record, even if still marked connected.
  // Same browser, different/new tab → only a DISCONNECTED record (a live
  // record with that token is a second local tab, which is a new client).
  let rec = null;
  if (msg.token) {
    for (const r of netGuests.values()) {
      if (r.token !== msg.token) continue;
      if (msg.tab && r.tab === msg.tab) { rec = r; break; }
      if (!r.connected && !rec) rec = r;
    }
  }
  if (rec) {
    if (rec.kicked) { denyGuestConn(conn, 'kicked'); return; }
    if (rec.conn && rec.conn !== conn) { try { rec.conn.close(); } catch (e) {} }
    rec.conn = conn;
    rec.tab = msg.tab || rec.tab;
    rec.connected = true;
    rec.lastRecvAt = performance.now();
    if (msg.name) rec.name = msg.name;
  } else {
    let seat = (typeof window.assignGuestSeat === 'function') ? window.assignGuestSeat(msg) : null;
    if (seat == null) {
      denyGuestConn(conn, (typeof mpMatchStarted !== 'undefined' && mpMatchStarted) ? 'in-progress' : 'full');
      return;
    }
    rec = {
      conn, seat,
      token: msg.token || null,
      tab: msg.tab || null,
      name: msg.name || '',
      connected: true,
      lastRecvAt: performance.now(),
      kicked: false,
    };
    netGuests.set(seat, rec);
  }
  netPendingConns = netPendingConns.filter(p => p.conn !== conn);
  updateHostConnected();
  if (typeof mpMatchStarted !== 'undefined' && mpMatchStarted) persistMpSessionMap();
  queueSend(conn, { type: 'welcome', seat: rec.seat });
  if (window.onNetConnectionOpen) window.onNetConnectionOpen(rec.seat);
}

function denyGuestConn(conn, reason){
  queueSend(conn, { type: 'join-denied', reason });
  netPendingConns = netPendingConns.filter(p => p.conn !== conn);
  // Give the denial a moment to flush through the async send queue before
  // closing — close() drops anything still buffered.
  setTimeout(() => { try { conn.close(); } catch (e) {} }, 500);
}

// Host side: create a Peer, wait for a guest to connect to it.
// Resolves with this host's peerId (to embed in the shareable link) once
// PeerJS's cloud signaling server has assigned one.
//
// `desiredId`, when given, asks PeerJS's signaling server for that EXACT
// id instead of a random one — used when re-hosting from a loaded save
// (js/save.js's serializeGame() stores the host peer id that was active at
// save time). Requesting the same id back lets the ORIGINAL guest's own
// already-running attemptReconnect() loop (js/init.js, which keeps retrying
// against its cached host id every few seconds) silently succeed on its
// own, with no new link needed — otherwise a host reloading its whole page
// and re-hosting always got a fresh random id, permanently stranding that
// guest's tab retrying against an id that no longer exists (confirmed by
// an actual two-browser-context test: the guest sat showing "Attempting to
// reconnect…" forever). The id might not be immediately available again
// right after the old session dies (server-side cleanup lag, or someone
// else's tab happening to hold it) — falls back to a fresh random id
// rather than failing hosting outright if so.
// `strict`: reject on 'unavailable-id' instead of falling back to a random
// id. The ?host= resume flow (js/init.js's enterHostResumeMode) NEEDS the
// exact id back — the guest's reconnect loop is retrying that id and only
// that id, so a silent random fallback would strand it forever; the caller
// retries after a delay instead (the signaling server takes a few seconds
// to release a dead session's id). The save-file re-host flow keeps the
// non-strict fallback: a brand-new guest just uses whatever link is shown.
function hostSession(desiredId, strict){
  return new Promise((resolve, reject) => {
    if (typeof Peer === 'undefined') { reject(new Error('PeerJS library not loaded')); return; }
    netRole = 'host';

    let finish = (peer) => {
      netPeer = peer;
      // 'disconnected' = lost the SIGNALING server (PeerJS cloud), not the
      // game DataConnection — laptop sleep or a wifi blip is enough. An
      // established match keeps playing without signaling, but this host's
      // peer id dies with the socket, so any FUTURE (re)join attempt from
      // the guest would retry against an id that no longer exists, forever.
      // reconnect() re-registers the same id on the same Peer object; no-op
      // guard on destroyed covers a deliberate teardown racing the event.
      peer.on('disconnected', () => {
        if (!peer.destroyed) { try { peer.reconnect(); } catch (e) {} }
      });
      netPeer.on('connection', (conn) => {
        // Star topology: every incoming connection is wired as pending and
        // earns a seat via its 'hello' (token → same seat on reconnect,
        // fresh token → lobby seating rules). See wireHostConnection.
        wireHostConnection(conn);
      });
      resolve(netPeer.id);
    };

    let settled = false;
    let peer = desiredId ? new Peer(desiredId) : new Peer();
    peer.on('open', () => { settled = true; finish(peer); });
    peer.on('error', (err) => {
      if (settled) return;
      if (desiredId && err.type === 'unavailable-id') {
        if (strict) {
          // Destroy the half-made peer so its error/retry state can't
          // linger, then let the caller decide (retry after a delay).
          try { peer.destroy(); } catch (e) {}
          reject(err);
          return;
        }
        // The exact id we wanted isn't free yet — fall back to a fresh
        // random one instead of failing hosting outright. Only the
        // ORIGINAL guest's reconnect benefits from the exact id match; a
        // brand-new guest just uses whatever link is shown regardless.
        let fallback = new Peer();
        fallback.on('open', () => { settled = true; finish(fallback); });
        fallback.on('error', (err2) => {
          console.error('PeerJS host error (fallback):', err2);
          reject(err2);
        });
        return;
      }
      console.error('PeerJS host error:', err);
      reject(err);
    });
  });
}

// Guest side: create our own Peer, then connect directly to the host's id
// (obtained from the ?join= URL param — see autoJoinFromUrl in init.js).
function joinSession(hostPeerId){
  return new Promise((resolve, reject) => {
    if (typeof Peer === 'undefined') { reject(new Error('PeerJS library not loaded')); return; }
    netRole = 'guest';
    // A reconnect attempt calls this again with a previous (now-dead) Peer
    // still sitting in netPeer — destroy it first so its signaling socket
    // doesn't linger, rather than just silently orphaning it.
    if (netPeer) { try { netPeer.destroy(); } catch (e) {} }
    netPeer = new Peer();
    // The promise otherwise only settles on the DataConnection's 'open' or a
    // Peer-level 'error'. An ICE/connection failure where neither ever fires
    // (host id alive but the connection hangs) would leave attemptReconnect's
    // .catch unreached — no retry ever rescheduled, guest stuck on
    // "Attempting to reconnect…" forever. Settle exactly once, with a hard
    // deadline covering both the signaling handshake and the connect.
    let settled = false;
    const settle = (fn, arg) => { if (!settled) { settled = true; clearTimeout(joinDeadline); fn(arg); } };
    const joinDeadline = setTimeout(() => {
      try { netPeer.destroy(); } catch (e) {}
      settle(reject, new Error('join timed out'));
    }, 10000);
    netPeer.on('open', () => {
      // serialization:'binary' (PeerJS's bundled BinaryPack/msgpack encoder)
      // — 'none' isn't a constructor this PeerJS build actually registers
      // (confirmed by hitting "this._serializers[t.serialization] is not a
      // constructor" when tried). BinaryPack still wraps our pre-compressed
      // Uint8Array as a binary blob efficiently (small framing overhead,
      // not re-inflating it), so this is still nearly all of the deflate
      // win. Host's inbound `connection` listener just inherits whatever
      // mode the connecting peer — us — requested.
      let conn = netPeer.connect(hostPeerId, { reliable: true, serialization: 'binary' });
      wireGuestConnection(conn);
      conn.on('open', () => settle(resolve));
    });
    netPeer.on('error', (err) => {
      console.error('PeerJS guest error:', err);
      settle(reject, err);
    });
  });
}

// Tear the whole transport down: connection, peer, role. The complement of
// hostSession/joinSession — used when the user deliberately leaves
// multiplayer (cancel hosting, Play Again after a finished MP match), not
// for transient drops (those keep the peer alive for reconnects). Session-
// level cleanup (reconnect timer, myTeam, match flags) lives in init.js's
// leaveMpSession(), which wraps this.
function teardownNet(){
  netConnected = false;
  if (netConn) { try { netConn.close(); } catch (e) {} }
  netConn = null;
  for (const rec of netGuests.values()) {
    if (rec.conn) { try { rec.conn.close(); } catch (e) {} }
  }
  netGuests.clear();
  netPendingConns.forEach(p => { try { p.conn.close(); } catch (e) {} });
  netPendingConns = [];
  if (netPeer) { try { netPeer.destroy(); } catch (e) {} netPeer = null; }
  netRole = null;
}

function sendToHost(msg){
  if (netRole === 'guest' && netConn && netConnected) queueSend(netConn, msg);
}

function sendToGuest(seat, msg){
  if (netRole !== 'host') return;
  let rec = netGuests.get(seat);
  if (rec && rec.connected && rec.conn) queueSend(rec.conn, msg);
}

function broadcastToGuests(msg, exceptSeat){
  if (netRole !== 'host') return;
  for (const rec of netGuests.values()) {
    if (rec.connected && rec.conn && rec.seat !== exceptSeat) queueSend(rec.conn, msg);
  }
}

// Persist the seat<->token bindings (plus the host peer id) so a host
// page that dies mid-match can rebind rejoining guests to their exact
// seats after a ?host= crash-resume — that flow has no save file, only
// this. Written whenever the registry changes during a live match, read
// by enterHostResumeMode (js/init.js).
function persistMpSessionMap(){
  if (netRole !== 'host' || !netPeer || !netPeer.id) return;
  try {
    localStorage.setItem('aoeMpSessionMap', JSON.stringify({
      hostPeerId: netPeer.id,
      seatTokens: [...netGuests.values()].map(r => ({ seat: r.seat, token: r.token, tab: r.tab, name: r.name, kicked: !!r.kicked })),
    }));
  } catch (e) {}
}

// Pre-seed the registry with DISCONNECTED records (from a save file's
// seatTokens or the persisted session map) so returning guests' hellos
// token-match straight back onto their old seats — the same rebind path a
// live reconnect uses. Mid-match, an identity that matches nothing is
// denied, so this seeding IS the guest list.
function netSeedGuestRecords(seatTokens){
  for (const st of seatTokens || []) {
    if (!st || st.seat == null || !st.token || netGuests.has(st.seat)) continue;
    netGuests.set(st.seat, {
      conn: null, seat: st.seat, token: st.token, tab: st.tab || null,
      name: st.name || '', connected: false, lastRecvAt: 0, kicked: !!st.kicked,
    });
  }
}

// Lobby seats and registry seats are the same index space, and pre-match
// seat REMOVAL (a guest leaves the lobby, an AI seat is deleted) splices
// the lobby array — every later seat shifts down by one, and the registry
// must follow or connections would feed the wrong team's command stream.
// Only legal before the match starts (team ids crystallize at Start).
function netGuestsReindexAfterSeatRemoval(seat){
  let recs = [...netGuests.values()];
  netGuests.clear();
  for (const r of recs) {
    if (r.seat === seat) continue; // the removed seat's own record dies with it
    if (r.seat > seat) r.seat--;
    netGuests.set(r.seat, r);
  }
  updateHostConnected();
}

// Deliberately turn a guest away (lobby kick, mid-match kick). Sends the
// denial, closes the connection, and either forgets the record entirely
// (lobby kick — they may rejoin fresh) or keeps it flagged kicked=true
// (mid-match — their hello must keep being denied). connected flips false
// BEFORE close() so the close event's handleGuestConnectionLost no-ops —
// the caller owns the seat cleanup.
function netCloseGuest(seat, reason, keepRecord){
  let rec = netGuests.get(seat);
  if (!rec) return;
  let conn = rec.conn;
  rec.conn = null;
  rec.connected = false;
  if (keepRecord) rec.kicked = true; else netGuests.delete(seat);
  if (conn) {
    queueSend(conn, { type: 'join-denied', reason });
    setTimeout(() => { try { conn.close(); } catch (e) {} }, 500);
  }
  updateHostConnected();
  if (typeof mpMatchStarted !== 'undefined' && mpMatchStarted) persistMpSessionMap();
}

// ---- HOST RELAY ----
// The star's one forwarding rule: a guest's cmd-ls/tick/chat is repeated
// to every OTHER guest, stamped with the sender's seat (`from`). The host
// stamps from the connection's seat binding — never from anything the
// guest wrote in the payload — and guests trust `from` because their only
// link is the host. Never forwarded back to the sender, and guests hold
// no guest-to-guest links, so loops are impossible. Everything else
// (lobby, resync, pause, proto) is host<->guest point-to-point.
// Guest tick reports are forwarded WITHOUT their checksum fields:
// checksums are compared host<->guest only (the host is the resync
// authority), so relaying them would be noise.
const NET_RELAY_TYPES = new Set(['cmd-ls', 'tick', 'chat']);
onNetMessage((msg, src) => {
  if (netRole !== 'host' || !src || src.seat == null) return;
  if (!NET_RELAY_TYPES.has(msg.type)) return;
  let fwd = msg.type === 'tick'
    ? { type: 'tick', t: msg.t, from: src.seat }
    : Object.assign({}, msg, { from: src.seat });
  broadcastToGuests(fwd, src.seat);
});
