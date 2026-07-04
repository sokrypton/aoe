// ---- MULTIPLAYER: PeerJS connection plumbing ----
// This file only owns the WebRTC connection lifecycle — establishing a
// DataConnection between a host and a guest, and a thin send/receive
// envelope. It knows nothing about game state; that's js/net-sync.js
// (world state broadcast) and js/net-cmd.js (command relay), both of
// which register themselves via onNetMessage() below rather than this
// file reaching into game logic directly.
//
// Message envelope: every message sent over the DataConnection is a plain
// object {type: 'sync'|'cmd'|'hello'|'bye', ...payload}.
//
// Every message is compressed before it hits the wire: JSON.stringify →
// deflate-raw (via the browser's built-in CompressionStream) → raw bytes.
// Measured on a real ~13KB mid-game sync payload, this shrinks it to
// ~1.8KB (~7x) — JSON's repeated key names and structure compress far
// better than anything a hand-rolled key-shortening scheme would realistic-
// ally achieve, for zero ongoing maintenance cost. Applied uniformly to
// 'cmd' messages too (not just 'sync') for one code path — they're tiny
// enough that compression overhead is negligible either way.
//
// Since every send is already fully-encoded bytes, the connection uses
// PeerJS's serialization:'none' — sending the ArrayBuffer/Uint8Array
// straight over the RTCDataChannel with no further object-tree encoding
// layer (BinaryPack) in between.

let netPeer = null;
let netMessageHandlers = [];

// CompressionStream/DecompressionStream are stream-based (write in, read
// chunks out), so both directions are inherently async. A single already-
// fully-buffered input (our whole JSON string) drains in one microtask
// hop or two, but the ORDER two overlapping async calls happen to resolve
// in is not guaranteed to match the order they were started — and the
// rest of the system (e.g. applyNetSync assuming "the next sync corrects
// the previous one") depends on messages being processed in the order
// they were sent/received. Each direction gets its own promise chain
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
// pre-compression JSON size). No longer displayed in-game — kept because
// they're handy from the console when debugging sync traffic.
let netBytesSent = 0;
let netBytesReceived = 0;

// How many bytes are sitting in the RTCDataChannel's outgoing buffer,
// still waiting for the actual network to drain them. On a reliable-
// ordered channel this grows without bound if we produce faster than the
// link carries — hostSyncTick (js/net-sync.js) checks this before sending
// to skip/defer syncs instead of piling on latency. PeerJS exposes the
// underlying channel as `.dataChannel`. Doesn't count messages still in
// sendQueue awaiting compression — a few in-flight at most, close enough.
function netSendBuffered(){
  return (netConn && netConn.dataChannel) ? netConn.dataChannel.bufferedAmount : 0;
}

// Dev-only fault injection, settable from the console (nothing in the app
// sets these). Chrome's network throttling does NOT touch WebRTC, so this
// is the practical way to reproduce real-link conditions on one machine:
//   NET_TEST_DELAY_MS = 300      // serial per-message delay (throughput cap)
//   NET_TEST_DROP_RATE = 0.05    // randomly drop 5% of outgoing messages
//   NET_TEST_DROP_NEXT_FULL = true // drop the next full sync (host console)
//                                  // to verify the guest auto-recovers
let sendQueue = Promise.resolve();
function queueSend(conn, msg){
  sendQueue = sendQueue
    .then(() => compressMessage(msg))
    .then(bytes => window.NET_TEST_DELAY_MS
      ? new Promise(res => setTimeout(() => res(bytes), window.NET_TEST_DELAY_MS))
      : bytes)
    .then(bytes => {
      if (window.NET_TEST_DROP_RATE && Math.random() < window.NET_TEST_DROP_RATE) return;
      if (window.NET_TEST_DROP_NEXT_FULL && msg.type === 'sync' && msg.data && msg.data.full) {
        window.NET_TEST_DROP_NEXT_FULL = false;
        return;
      }
      netBytesSent += bytes.length;
      conn.send(bytes);
    })
    .catch(err => console.error('Net send failed (message dropped):', err));
}

let recvQueue = Promise.resolve();
function queueReceive(data){
  netBytesReceived += (data instanceof Uint8Array ? data : new Uint8Array(data)).length;
  recvQueue = recvQueue
    .then(() => decompressMessage(data))
    .then(msg => dispatchNetMessage(msg))
    .catch(err => console.error('Net receive failed (message dropped):', err));
}

// Registers a callback invoked for every incoming message; net-sync.js and
// net-cmd.js each add one for the message types they care about, rather
// than this file needing to know about 'sync'/'cmd' payload shapes.
function onNetMessage(handler){
  netMessageHandlers.push(handler);
}

function dispatchNetMessage(msg){
  if (!msg || typeof msg !== 'object' || !msg.type) return;
  netMessageHandlers.forEach(h => {
    try { h(msg); } catch (err) { console.error('Net message handler failed:', err); }
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

function handleConnectionLost(){
  if (!netConnected) return; // already handled (real 'close' or a prior watchdog trip) — don't double-fire
  netConnected = false;
  netConn = null;
  if (window.onNetConnectionClosed) window.onNetConnectionClosed();
}

setInterval(() => {
  if (!netConnected) return;
  queueSend(netConn, { type: 'ping' });
  if (performance.now() - lastNetRecvAt > NET_TIMEOUT_MS) handleConnectionLost();
}, NET_HEARTBEAT_MS);

function wireConnection(conn){
  netConn = conn;
  lastNetRecvAt = performance.now();
  conn.on('open', () => {
    netConnected = true;
    lastNetRecvAt = performance.now();
    if (window.onNetConnectionOpen) window.onNetConnectionOpen();
  });
  conn.on('data', (data) => {
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
        // Strictly 1v1 (see plan's punt list: no >2-peer topology in v1),
        // but a genuinely live existing connection is rare here in
        // practice — a fresh incoming connection almost always means the
        // same guest reconnecting (e.g. after closing/reopening their tab,
        // where PeerJS's own 'close' event may never have fired for the
        // dead old one — see the heartbeat watchdog above). So always
        // accept the new connection, tearing down whatever the old
        // reference was rather than rejecting the new guest and getting
        // permanently stuck.
        if (netConn && netConn !== conn) { try { netConn.close(); } catch (e) {} }
        wireConnection(conn);
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
      wireConnection(conn);
      conn.on('open', () => resolve());
    });
    netPeer.on('error', (err) => {
      console.error('PeerJS guest error:', err);
      reject(err);
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
  if (netPeer) { try { netPeer.destroy(); } catch (e) {} netPeer = null; }
  netRole = null;
}

function sendToHost(msg){
  if (netRole === 'guest' && netConn && netConnected) queueSend(netConn, msg);
}

function broadcastToGuest(msg){
  if (netRole === 'host' && netConn && netConnected) queueSend(netConn, msg);
}
